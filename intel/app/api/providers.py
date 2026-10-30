"""Neural Core provider API under /api/intel/providers (ADR-002 D5, D6).

Keys are write-only: no route returns a key, a prefix or a suffix. Every route
refuses a request carrying an Origin header or a cross-site marker (only the
app's proxy, which runs the POWER UP admission gate, reaches it), and every
write needs the session token this service issued at start-up, fetched from
GET /providers/session. Local-only mode blocks any call to a cloud provider,
including a connection test and a model list.
"""

from __future__ import annotations

import asyncio
import hmac
from collections.abc import AsyncIterator
from dataclasses import asdict
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from ..chat.ollama import OllamaError
from ..chat.probe import probe_tools
from ..chat.providers.base import ChatProvider, ModelInfo
from ..chat.providers.errors import ProviderError
from ..chat.providers.keys import KeyStoreError, host_of, key_reaches
from ..chat.providers.registry import ProviderSpec, base_url_problem
from ..chat.providers.sdk import key_may_travel
from ..store.providers import CONTEXT_CEILING_RANGE, ProviderSettings
from .chat import _json_body, _same_machine, _sse

router = APIRouter(prefix="/api/intel/providers")

SESSION_HEADER = "x-spectre-session"
_KEY_ERRORS = {"no_key": 400, "bad_key": 400, "external": 409, "shared_key": 409, "keyring_failed": 503}


class KeyBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    key: str = Field(..., min_length=1, max_length=1024)


MODEL_ID = r"^[A-Za-z0-9._:/@+-]{1,200}$"
ModelId = Annotated[str, Field(pattern=MODEL_ID)]


class SettingsBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    base_url: str | None = Field(None, max_length=512)
    workspace_id: str | None = Field(None, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")
    chat_completions_models: list[ModelId] = Field(default_factory=list, max_length=20)
    params: ParamsBody | None = None


class ParamsBody(BaseModel):
    """Per-provider parameters (D11). Ollama-only fields are refused for others,
    and temperature for Anthropic (API version 2026-10-21 rejects it)."""

    model_config = ConfigDict(extra="forbid")
    temperature: float | None = Field(None, ge=0, le=2)
    max_output_tokens: int | None = Field(None, ge=64, le=32768)
    num_ctx: int | None = Field(None, ge=2048, le=262144)
    keep_alive: str | None = Field(None, pattern=r"^(-1|0|\d{1,4}[smh])$")
    price_in: float | None = Field(None, ge=0, le=10000)  # USD per 1M input tokens, typed by the user
    price_out: float | None = Field(None, ge=0, le=10000)
    reasoning: bool | None = None  # on where REASONING_PROVIDERS allow it (D11)


OLLAMA_ONLY = ("num_ctx", "keep_alive")
# Where turning reasoning on has a verified wire format and passback (D11).
# Anthropic waits: thinking with tools needs its blocks kept across turns,
# unverified until a live run. NIM and custom servers have no common switch.
REASONING_PROVIDERS = frozenset({"ollama", "deepseek", "openrouter", "openai"})


class ProbeBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    model: ModelId


class SelectionBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    provider: str = Field(..., max_length=32)
    model: ModelId


# An Ollama registry name: [host/][namespace/]model[:tag]. Every segment starts
# with a letter or digit, so no scheme, flag or '..' segment gets through.
OLLAMA_NAME = r"^[A-Za-z0-9][A-Za-z0-9._-]*(?:/[A-Za-z0-9][A-Za-z0-9._-]*){0,3}(?::[A-Za-z0-9._-]{1,80})?$"


PULL_FIELDS = ("status", "digest", "total", "completed")  # never anything else Ollama sends


class PullBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    model: str = Field(..., max_length=200, pattern=OLLAMA_NAME)


class ConsentBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    granted: bool


class PolicyBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    local_only: bool | None = None
    map_context: bool | None = None
    session_budget: int | None = Field(None, ge=0, le=10_000_000)  # cloud tokens; 0 is off
    # tokens an API model's turn may use (D9)
    context_ceiling: int | None = Field(None, ge=CONTEXT_CEILING_RANGE[0], le=CONTEXT_CEILING_RANGE[1])


class TestBody(BaseModel):
    model_config = ConfigDict(extra="forbid")


def _state(request: Request) -> Any:
    _same_machine(request)
    state = request.app.state
    if getattr(state, "providers", None) is None:
        raise HTTPException(
            503, {"code": "providers_unavailable", "reason": getattr(state, "chat_problem", None)}
        )
    return state


def _writer(request: Request, *, body: bool = True) -> Any:
    state = _state(request)
    if body:
        _json_body(request)
    token = request.headers.get(SESSION_HEADER, "")
    if not hmac.compare_digest(token.encode(), state.session_token.encode()):
        raise HTTPException(403, {"code": "session_required"})
    return state


def _spec(state: Any, provider_id: str) -> ProviderSpec:
    spec = state.providers.specs.get(provider_id)
    if spec is None:
        raise HTTPException(404, {"code": "unknown_provider"})
    return spec


def _kind(state: Any, spec: ProviderSpec) -> str:
    provider = state.providers.get(spec.id)
    return getattr(provider, "kind", spec.kind)


def _egress_allowed(state: Any, spec: ProviderSpec) -> None:
    if _kind(state, spec) == "cloud" and state.provider_store.policy().local_only:
        raise HTTPException(409, {"code": "local_only", "message": "Local-only mode blocks cloud providers"})


def _view(state: Any, spec: ProviderSpec) -> dict[str, Any]:
    saved = state.provider_store.settings(spec.id)
    provider: ChatProvider | None = state.providers.get(spec.id)
    return {
        "id": spec.id,
        "label": spec.label,
        "kind": _kind(state, spec),
        "docs": spec.docs or None,
        "base_url": _base_url(provider, spec),
        "base_url_editable": spec.id != "ollama",
        "workspace_id": saved.workspace_id,
        "adapter": spec.adapter,
        "params": saved.params,
        "chat_completions_models": list(saved.chat_completions_models),
        "key": state.keys.status(spec).public(),
        # False when the key was saved for (or comes with) another address: it is not sent here.
        "key_reaches_address": key_reaches(
            spec, _base_url(provider, spec), state.provider_store.key_host(spec.id)
        ),
        "consent": state.provider_store.consented(spec.id),
    }


def _base_url(provider: ChatProvider | None, spec: ProviderSpec) -> str:
    client = getattr(provider, "client", None)
    return str(getattr(provider, "base_url", None) or getattr(client, "base_url", None) or spec.base_url)


def _model(info: ModelInfo) -> dict[str, Any]:
    data = asdict(info)
    data["capabilities"] = sorted(info.capabilities)
    return data


def _provider_failure(error: ProviderError) -> HTTPException:
    return HTTPException(502, {"code": error.code, "message": str(error), "retryable": error.retryable})


@router.get("")
async def list_providers(request: Request) -> dict[str, Any]:
    state = _state(request)
    policy = state.provider_store.policy()
    return {
        "providers": [_view(state, spec) for spec in state.providers.specs.values()],
        "policy": asdict(policy),
        "keyring": state.keys.keyring_available,
        "selection": _selection(state),
    }


def _selection(state: Any) -> dict[str, str] | None:
    """The current conversation's choice, else the last one (a new
    conversation starts with it); None means the default Ollama model."""
    current = state.chats.current_conversation()
    chosen = (state.chats.selection(current) if current else None) or state.provider_store.last_selection()
    return {"provider": chosen[0], "model": chosen[1]} if chosen else None


@router.put("/selection")
async def put_selection(body: SelectionBody, request: Request) -> dict[str, Any]:
    """Choose the provider and model for the current conversation, and for
    new ones. Consent and local-only mode are checked when a turn runs."""
    state = _writer(request)
    spec = _spec(state, body.provider)
    conversation = state.chats.ensure_conversation(state.chats.current_conversation())
    state.chats.set_selection(conversation, spec.id, body.model)
    state.provider_store.set_last_selection(spec.id, body.model)
    return {"conversation_id": conversation, "selection": _selection(state)}


@router.get("/session")
async def session(request: Request) -> dict[str, str]:
    return {"token": _state(request).session_token}


@router.put("/policy")
async def set_policy(body: PolicyBody, request: Request) -> dict[str, Any]:
    state = _writer(request)
    policy = state.provider_store.set_policy(
        local_only=body.local_only,
        map_context=body.map_context,
        session_budget=body.session_budget,
        context_ceiling=body.context_ceiling,
    )
    return asdict(policy)


@router.put("/{provider_id}/key")
async def put_key(provider_id: str, body: KeyBody, request: Request) -> dict[str, Any]:
    state = _writer(request)
    spec = _spec(state, provider_id)
    address = _base_url(state.providers.get(spec.id), spec)
    if not key_may_travel(address):
        message = "This server is on plain http on another machine; a key would travel unencrypted"
        raise HTTPException(409, {"code": "key_over_http", "message": message})
    try:
        status = state.keys.set(spec, body.key).public()
    except KeyStoreError as error:
        raise HTTPException(_KEY_ERRORS[error.code], {"code": error.code, "message": str(error)}) from None
    state.provider_store.set_key_host(spec.id, host_of(address))  # the key goes here and nowhere new
    return status


@router.delete("/{provider_id}/key")
async def delete_key(provider_id: str, request: Request) -> dict[str, Any]:
    state = _writer(request, body=False)
    try:
        spec = _spec(state, provider_id)
        status = state.keys.delete(spec).public()
        state.provider_store.set_key_host(spec.id, None)
        return status
    except KeyStoreError as error:
        raise HTTPException(_KEY_ERRORS[error.code], {"code": error.code, "message": str(error)}) from None


@router.put("/{provider_id}/settings")
async def put_settings(provider_id: str, body: SettingsBody, request: Request) -> dict[str, Any]:
    state = _writer(request)
    spec = _spec(state, provider_id)
    base_url = (body.base_url or "").strip().rstrip("/") or None
    if base_url is not None:
        if spec.id == "ollama":
            raise HTTPException(
                409, {"code": "set_in_environment", "message": "Ollama's address comes from OLLAMA_HOST"}
            )
        keyless = spec.key_optional and not state.keys.status(spec).configured
        problem = base_url_problem(base_url, allow_lan_http=keyless)
        if problem:
            raise HTTPException(400, {"code": "bad_base_url", "message": f"The base URL {problem}"})
    params = body.params.model_dump(exclude_none=True) if body.params else {}
    refused = [name for name in OLLAMA_ONLY if name in params and spec.id != "ollama"]
    if spec.adapter == "anthropic" and "temperature" in params:
        refused.append("temperature")
    if "reasoning" in params and spec.id not in REASONING_PROVIDERS:
        refused.append("reasoning")
    if refused:
        raise HTTPException(400, {"code": "unsupported_param", "params": refused})
    saved = ProviderSettings(base_url, body.workspace_id, tuple(body.chat_completions_models), params)
    state.provider_store.save_settings(spec.id, saved)
    target = base_url or spec.base_url
    before = _base_url(state.providers.get(spec.id), spec)
    if host_of(target) != host_of(before):
        # Another host is another recipient: ask for consent again, probe its
        # models again; a saved key does not follow (keys.key_reaches).
        state.provider_store.set_consent(spec.id, False)
        state.provider_store.forget_tools(spec.id)
    # Rebuild only when the address changed: a rebuild drops the adapter's
    # learned reasoning effort and its cached model list.
    if spec.id != "ollama" and target != before:
        state.providers.rebuild(spec.id, target)
    return _view(state, spec)


@router.put("/{provider_id}/consent")
async def put_consent(provider_id: str, body: ConsentBody, request: Request) -> dict[str, bool]:
    state = _writer(request)
    spec = _spec(state, provider_id)
    state.provider_store.set_consent(spec.id, body.granted)
    return {"consent": state.provider_store.consented(spec.id)}


@router.post("/{provider_id}/test")
async def test_connection(provider_id: str, body: TestBody, request: Request) -> dict[str, Any]:
    state = _writer(request)
    spec = _spec(state, provider_id)
    _egress_allowed(state, spec)
    try:
        result = await state.providers.get(spec.id).test()
    except ProviderError as error:
        return {"ok": False, "code": error.code, "message": str(error), "retryable": error.retryable}
    return {**result, "ok": True}


@router.get("/{provider_id}/models")
async def models(provider_id: str, request: Request) -> dict[str, Any]:
    state = _state(request)
    spec = _spec(state, provider_id)
    _egress_allowed(state, spec)
    try:
        listed = await state.providers.get(spec.id).list_models()
    except ProviderError as error:
        raise _provider_failure(error) from None
    return {"models": [_model(info) for info in listed]}


@router.post("/{provider_id}/probe")
async def probe(provider_id: str, body: ProbeBody, request: Request) -> dict[str, Any]:
    """Test tool calling (D3): one tiny prompt with a dummy tool, cached."""
    state = _writer(request)
    spec = _spec(state, provider_id)
    if spec.id == "ollama":
        raise HTTPException(
            400, {"code": "reported_by_ollama", "message": "Ollama reports tool support itself"}
        )
    _egress_allowed(state, spec)
    provider = state.providers.get(spec.id)
    try:
        result = await probe_tools(provider, body.model)
    except ProviderError as error:
        return {"ok": False, "code": error.code, "message": str(error), "retryable": error.retryable}
    base_url = _base_url(provider, spec)
    if result:
        state.provider_store.remember_tools(spec.id, base_url, body.model, result)
    else:  # a text reply proves nothing: a cached "no" must not outlive it
        state.provider_store.forget_tools(spec.id, base_url, body.model)
    agent = getattr(state, "agent", None)
    if agent is not None:
        agent.forget_unproven(spec.id, base_url, body.model)
    return {"ok": True, "supports_tools": result or "unknown"}


@router.post("/ollama/pull")
async def pull_model(body: PullBody, request: Request) -> StreamingResponse:
    """Pull model (D11): Ollama's own progress as SSE (`progress`, then `done`
    or `error`). Leaving the page closes this stream and the request to
    Ollama; whether Ollama then stops downloading is up to Ollama."""
    state = _writer(request)
    provider = state.providers.get("ollama")
    client = getattr(provider, "client", None)
    if client is None:
        raise HTTPException(503, {"code": "chat_unavailable"})

    async def stream() -> AsyncIterator[str]:
        try:
            succeeded = False
            async for chunk in client.pull(body.model):
                succeeded = chunk.get("status") == "success"
                yield _sse("progress", {key: chunk.get(key) for key in PULL_FIELDS})
            if succeeded:
                yield _sse("done", {"model": body.model})
            else:  # the stream ended without Ollama's success line
                yield _sse(
                    "error", {"code": "incomplete", "message": "Ollama stopped before the pull finished"}
                )
        except OllamaError as error:
            yield _sse("error", {"code": error.code, "message": str(error)[:300]})

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


@router.get("/ollama/gpu")
async def gpu(request: Request) -> dict[str, Any]:
    """The GPU's name and memory for the VRAM estimate, from nvidia-smi when
    present. Fixed arguments, a timeout, and never a tool a model can call."""
    _state(request)
    return {"gpu": await nvidia_gpu()}


@router.post("/budget/continue")
async def continue_budget(body: TestBody, request: Request) -> dict[str, int]:
    """Allow one more session budget of cloud tokens in this conversation (D10).
    A gated write: a LAN viewer cannot keep spending the owner\'s key."""
    state = _writer(request)
    conversation = state.chats.current_conversation()
    if conversation is None:
        raise HTTPException(409, {"code": "no_conversation"})
    budget = state.provider_store.policy().session_budget
    extra = state.chats.raise_budget(conversation, max(budget, 1))
    return {"allowance": budget + extra}


GPU_QUERY = ("nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits")


def parse_gpu(output: str) -> dict[str, Any] | None:
    line = output.strip().splitlines()[0] if output.strip() else ""
    name, _, memory = line.rpartition(",")
    try:
        megabytes = int(memory.strip())
    except ValueError:
        return None
    return {"name": name.strip()[:80], "memory_mb": megabytes} if name.strip() else None


async def nvidia_gpu() -> dict[str, Any] | None:
    try:
        process = await asyncio.create_subprocess_exec(
            *GPU_QUERY, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL
        )
    except OSError:
        return None  # no NVIDIA driver here
    try:
        output, _ = await asyncio.wait_for(process.communicate(), timeout=3)
    except TimeoutError:
        process.kill()
        return None
    return parse_gpu(output.decode("utf-8", "replace"))
