"""Neural Core HTTP API under /api/intel/chat.

POST /chat streams one turn as SSE. One turn runs at a time, and turns are
rate-limited per minute. State-changing routes refuse any request that carries
an Origin header or a cross-site fetch marker: the app's own proxy
(server/providers/intel.js) sends neither, while a page on another site
calling 127.0.0.1:8100 from the user's browser always does.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import time
import uuid
from collections import deque
from collections.abc import AsyncIterator
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from ..chat.agent import Turn
from ..chat.ollama import OllamaError
from ..chat.providers.errors import ProviderError

router = APIRouter(prefix="/api/intel/chat")

MAX_CONTEXT_BYTES = 8 * 1024
MAX_RESULT_BYTES = 32 * 1024


class ChatRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    message: str = Field("", max_length=4000)
    conversation_id: int | None = Field(None, ge=1)
    regenerate: bool = False
    viewport: dict[str, Any] | None = None
    layer_state: dict[str, Any] | None = None


class ToolResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    turn_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    call_id: str = Field(pattern=r"^[0-9a-f]{12}$")
    ok: bool
    result: Any = None
    error: str | None = Field(None, max_length=500)


class StopRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    turn_id: str = Field(pattern=r"^[0-9a-f]{32}$")


class ChatGate:
    """One turn at a time, and at most `per_minute` turns a minute.

    The turn is claimed synchronously in the route (no await between the check
    and the claim) and released when its stream ends. A claim older than
    STALE_SECONDS is treated as abandoned, so a stream that never started
    cannot block the panel for good."""

    STALE_SECONDS = 600

    def __init__(self, per_minute: int) -> None:
        self.per_minute = per_minute
        self.started: deque[float] = deque()
        self.active_turn: str | None = None
        self.active_since = 0.0
        self.stop = asyncio.Event()

    def busy(self) -> bool:
        return self.active_turn is not None and time.monotonic() - self.active_since < self.STALE_SECONDS

    def claim(self, turn_id: str) -> None:
        if self.busy():
            raise HTTPException(409, {"code": "busy"})
        now = time.monotonic()
        while self.started and now - self.started[0] > 60:
            self.started.popleft()
        if len(self.started) >= self.per_minute:
            raise HTTPException(429, {"code": "rate_limited"})
        self.started.append(now)
        self.active_turn, self.active_since = turn_id, now
        self.stop.clear()

    def release(self, turn_id: str) -> None:
        if self.active_turn == turn_id:
            self.active_turn = None


def _same_machine(request: Request) -> None:
    if request.headers.get("origin") is not None or request.headers.get("sec-fetch-site") == "cross-site":
        raise HTTPException(403, {"code": "cross_origin"})


def _json_body(request: Request) -> None:
    _same_machine(request)
    ctype = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if ctype != "application/json":
        raise HTTPException(415, {"code": "json_only"})


def _bounded(value: dict[str, Any] | None, name: str) -> None:
    if value is not None and len(json.dumps(value, default=str)) > MAX_CONTEXT_BYTES:
        raise HTTPException(413, {"code": "too_large", "field": name})


def _sse(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _services(request: Request) -> Any:
    state = request.app.state
    if getattr(state, "agent", None) is None:
        raise HTTPException(503, {"code": "chat_unavailable", "reason": getattr(state, "chat_problem", None)})
    return state


@router.post("")
async def chat(body: ChatRequest, request: Request) -> StreamingResponse:
    _json_body(request)
    state = _services(request)
    _bounded(body.viewport, "viewport")
    _bounded(body.layer_state, "layer_state")
    gate: ChatGate = state.chat_gate
    if not body.regenerate and not body.message.strip():
        raise HTTPException(422, {"code": "empty_message"})
    turn_id = uuid.uuid4().hex
    gate.claim(turn_id)  # busy and rate checks come before anything changes
    chats = state.chats
    # No id continues the current conversation (the one the panel shows).
    conversation = chats.ensure_conversation(body.conversation_id or chats.current_conversation())
    if body.regenerate:
        message = chats.drop_last_answer(conversation)
        if message is None:
            gate.release(turn_id)
            raise HTTPException(422, {"code": "nothing_to_regenerate"})
    else:
        message = body.message.strip()
    history = chats.history(conversation)
    # The provider and model come only from the stored selection, which only
    # the gated /providers/selection route changes: a LAN viewer can chat but
    # never switch to a provider that spends the owner's key (ADR-002 D5).
    store = getattr(state, "provider_store", None)
    chosen = chats.selection(conversation) or (store.last_selection() if store else None)
    turn = Turn(conversation, message, body.viewport, body.layer_state, history, turn_id=turn_id)
    if chosen:
        turn.provider_id, turn.model = chosen
    chats.add_message(conversation, "user", message)

    async def stream() -> AsyncIterator[str]:
        events = state.agent.run(turn)
        try:
            async for event, data in events:
                yield _sse(event, data)
                if gate.stop.is_set() or await request.is_disconnected():
                    yield _sse("error", {"code": "stopped"})
                    break
        finally:
            # Release first: closing a turn cut short (stop, browser gone) can
            # raise, and a held gate would refuse every message as busy.
            gate.release(turn.turn_id)
            with contextlib.suppress(Exception):
                await events.aclose()

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


@router.post("/tool-result", status_code=204)
async def tool_result(body: ToolResult, request: Request) -> Response:
    _json_body(request)
    state = _services(request)
    if len(json.dumps(body.result, default=str)) > MAX_RESULT_BYTES:
        raise HTTPException(413, {"code": "too_large"})
    payload = {"ok": body.ok, "result": body.result, "error": body.error}
    if not state.agent.resolve_client_tool(body.turn_id, body.call_id, payload):
        raise HTTPException(404, {"code": "unknown_call"})
    return Response(status_code=204)


@router.post("/stop", status_code=204)
async def stop(body: StopRequest, request: Request) -> Response:
    _json_body(request)
    gate: ChatGate = _services(request).chat_gate
    if gate.active_turn == body.turn_id:
        gate.stop.set()
    return Response(status_code=204)


@router.get("/history")
async def history(request: Request) -> dict[str, Any]:
    chats = _services(request).chats
    conversation = chats.current_conversation()
    return {
        "conversation_id": conversation,
        "messages": chats.messages(conversation) if conversation else [],
    }


@router.delete("/history", status_code=204)
async def clear_history(request: Request) -> Response:
    _same_machine(request)
    state = _services(request)
    if state.chat_gate.busy():
        raise HTTPException(409, {"code": "busy"})
    state.chats.clear()
    return Response(status_code=204)


@router.get("/status")
async def status(request: Request) -> dict[str, Any]:
    """The selected provider and model with a provider-neutral `ready` /
    `problem` pair (ADR-002 D7); every earlier field stays. An API provider's
    readiness comes from local facts only (key, consent, local-only mode), so
    this poll never calls a cloud API. Ollama is checked as before."""
    state = request.app.state
    settings = state.settings
    chats = getattr(state, "chats", None)
    store = getattr(state, "provider_store", None)
    conversation = chats.current_conversation() if chats else None
    chosen = (chats.selection(conversation) if chats and conversation else None) or (
        store.last_selection() if store else None
    )
    provider_id, model = chosen or ("ollama", settings.ollama_model)
    policy = store.policy() if store else None
    result: dict[str, Any] = {
        "model": model,
        "provider": provider_id,
        "kind": None,
        "ready": False,
        "problem": None,
        "usage": chats.usage_totals(conversation) if chats else None,
        "budget": _budget_view(chats, conversation, policy),
        "num_ctx": settings.num_ctx,
        "low_resource": settings.low_resource,
        "search": state.search.status() if getattr(state, "search", None) else None,
        "chat_problem": getattr(state, "chat_problem", None),
        "ollama": {"reachable": False, "version": None},
        "model_present": None,
        "tools": None,
        "loaded": None,
    }
    agent = getattr(state, "agent", None)
    if agent is None:
        result["problem"] = "chat_unavailable"
        return result
    if provider_id != "ollama":
        result.update(_api_readiness(state, provider_id, policy))
        return result
    try:
        result["ollama"] = {"reachable": True, "version": await agent.ollama.version()}
    except OllamaError as error:
        result["ollama"]["error"] = error.code
        result["problem"] = "ollama_offline"
        return result
    try:
        # Under local-only mode a cloud provider gets no call at all, not even this lookup.
        if not agent.local_only_blocks():
            info = await agent.provider.model_caps(model)
            result["model_present"] = True
            result["tools"] = "tools" in info.capabilities
            result["kind"] = info.kind
    except ProviderError as error:
        result["model_present"] = False if error.detail == "not_found" else None
    try:
        for loaded in await agent.ollama.ps():
            if model in (loaded.get("name"), loaded.get("model")):
                result["loaded"] = {
                    "size_vram": loaded.get("size_vram"),
                    "size": loaded.get("size"),
                    "expires_at": loaded.get("expires_at"),
                    "context_length": loaded.get("context_length"),
                }
    except OllamaError:
        pass
    if result["model_present"] is not True:
        result["problem"] = (
            "ollama_model_missing" if result["model_present"] is False else "model_check_failed"
        )
    elif result["kind"] == "cloud" and policy and policy.local_only:
        result["problem"] = "local_only"
    result["ready"] = result["problem"] is None
    return result


def _budget_view(chats: Any, conversation: int | None, policy: Any) -> dict[str, int] | None:
    if chats is None or policy is None or policy.session_budget <= 0:
        return None
    extra = chats.budget_extra(conversation) if conversation else 0
    spent = chats.usage_totals(conversation)["cloud"]
    return {"spent": spent, "allowance": policy.session_budget + extra, "budget": policy.session_budget}


def _api_readiness(state: Any, provider_id: str, policy: Any) -> dict[str, Any]:
    providers = getattr(state, "providers", None)
    provider = providers.get(provider_id) if providers else None
    if provider is None:
        return {"kind": None, "ready": False, "problem": "unknown_provider"}
    spec = providers.specs[provider_id]
    kind = provider.kind
    problem = None
    if not state.keys.status(spec).configured and not spec.key_optional:
        problem = "no_key"
    elif kind == "cloud" and policy is not None and policy.local_only:
        problem = "local_only"
    elif kind != "local" and not state.provider_store.consented(provider_id):
        problem = "consent_required"
    return {"kind": kind, "ready": problem is None, "problem": problem}
