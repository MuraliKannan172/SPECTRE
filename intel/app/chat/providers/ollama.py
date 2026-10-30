"""Ollama behind the provider interface (ADR-002 D1), native /api/chat.

The payload is the one the Neural Core sent before providers existed. Ollama
tool calls carry no id: the adapter gives each call of a round a synthetic
id and matches results back by tool name, in order. The raw calls go back
to Ollama unchanged through `provider_state`.

Ollama is not always local: a model with a `remote_host` (the `:cloud`
models) runs on that host, and Ollama itself may run on another machine.
"""

from __future__ import annotations

import ipaddress
from collections.abc import AsyncIterator
from typing import Any
from urllib.parse import urlsplit

from ..ollama import OllamaClient, OllamaError
from .base import (
    ChatRequest,
    Done,
    Kind,
    Message,
    ModelInfo,
    StreamEvent,
    TextDelta,
    ThinkingDelta,
    ToolCall,
    ToolCallEvent,
    Usage,
    normalize_args,
)
from .errors import (
    MODEL_NOT_FOUND,
    NETWORK,
    PROVIDER_UNAVAILABLE,
    ProviderError,
    code_for_status,
    retry_after_seconds,
)

PROVIDER_ID = "ollama"

# OllamaError codes (the panel's `ollama_<code>` errors) by taxonomy code.
_TAXONOMY = {
    "offline": NETWORK,
    "timeout": NETWORK,
    "unavailable": NETWORK,
    "not_found": MODEL_NOT_FOUND,
    "model_missing": MODEL_NOT_FOUND,
    "bad_response": PROVIDER_UNAVAILABLE,
    "model_error": PROVIDER_UNAVAILABLE,
}


def provider_error(error: OllamaError) -> ProviderError:
    if error.code == "http_status" and error.status:
        code = code_for_status(error.status)
    else:
        code = _TAXONOMY.get(error.code, PROVIDER_UNAVAILABLE)
    return ProviderError(
        code,
        str(error),
        provider=PROVIDER_ID,
        detail=error.code,
        status=error.status,
        retry_after=retry_after_seconds(error.retry_after),
    )


def host_kind(base_url: str) -> Kind:
    host = (urlsplit(base_url).hostname or "").lower()
    if host == "localhost":
        return "local"
    try:
        return "local" if ipaddress.ip_address(host).is_loopback else "remote"
    except ValueError:
        return "remote"


def _tags_entry(entries: list[dict[str, Any]], model: str) -> dict[str, Any]:
    """The /api/tags entry for a model name, `qwen` and `qwen:latest` alike."""

    def canonical(name: object) -> str:
        text = str(name or "")
        return text if ":" in text else f"{text}:latest"

    wanted = canonical(model)
    for entry in entries:
        if wanted in (canonical(entry.get("name")), canonical(entry.get("model"))):
            return entry
    return {}


def _context_window(shown: dict[str, Any]) -> int | None:
    for key, value in (shown.get("model_info") or {}).items():
        if key.endswith(".context_length") and isinstance(value, int):
            return value
    return None


class OllamaProvider:
    id = PROVIDER_ID
    # A local server: retrying an offline or failing Ollama only delays the error.
    max_attempts = 1

    def __init__(self, client: OllamaClient) -> None:
        self.client = client
        self.kind: Kind = host_kind(client.base_url)
        self._caps: dict[str, ModelInfo] = {}

    def _info(self, name: str, entry: dict[str, Any], context: int | None) -> ModelInfo:
        capabilities = frozenset(entry.get("capabilities") or [])
        details = dict(entry.get("details") or {})
        remote = entry.get("remote_host")
        if remote:
            details["remote_host"] = remote
        if isinstance(entry.get("size"), int):
            details["size"] = entry["size"]  # bytes on disk, for the VRAM estimate (D11)
        # The name too: an Ollama that leaves remote_host out (or a model missing
        # from /api/tags) must not make a :cloud model look local.
        tag = name.rsplit(":", 1)[1] if ":" in name else ""
        cloud = bool(remote) or tag == "cloud" or tag.endswith("-cloud")
        return ModelInfo(
            id=name,
            label=name,
            kind="cloud" if cloud else self.kind,
            supports_tools=("yes" if "tools" in capabilities else "no") if capabilities else "unknown",
            capabilities=capabilities,
            context_window=context,
            details=details,
        )

    async def list_models(self) -> list[ModelInfo]:
        """Installed chat models. Without capabilities (an old Ollama) every
        model is listed, marked unknown; with them, models that cannot chat
        (no `completion`, such as embedding models) are left out."""
        try:
            entries = await self.client.tags()
        except OllamaError as error:
            raise provider_error(error) from error
        models = []
        for entry in entries:
            name = str(entry.get("name") or entry.get("model") or "")
            capabilities = entry.get("capabilities")
            if not name or (capabilities and "completion" not in capabilities):
                continue
            context = (entry.get("details") or {}).get("context_length")
            models.append(self._info(name, entry, context if isinstance(context, int) else None))
        return models

    async def model_caps(self, model: str) -> ModelInfo:
        if model not in self._caps:
            try:
                shown = await self.client.show(model)
                # /api/show has no remote_host (Ollama 0.40.13); only /api/tags
                # says a model runs on ollama.com, and local-only mode needs that.
                listed = _tags_entry(await self.client.tags(), model)
            except OllamaError as error:
                raise provider_error(error) from error
            remote = {key: listed[key] for key in ("remote_host", "remote_model") if listed.get(key)}
            self._caps[model] = self._info(model, {**shown, **remote}, _context_window(shown))
        return self._caps[model]

    async def test(self) -> dict[str, Any]:
        try:
            return {"ok": True, "version": await self.client.version()}
        except OllamaError as error:
            raise provider_error(error) from error

    def payload(self, request: ChatRequest) -> dict[str, Any]:
        params = request.params
        payload: dict[str, Any] = {
            "model": request.model,
            "messages": [_wire_message(message) for message in request.messages],
            "think": params.get("think", False),
            "keep_alive": params.get("keep_alive", "5m"),
            "options": {
                "num_ctx": params.get("num_ctx", 8192),
                "temperature": params.get("temperature", 0.2),
            },
        }
        # Ollama answers without tools when asked for an answer, as before.
        if request.tools and request.tool_choice != "none":
            payload["tools"] = list(request.tools)
        if request.json_schema is not None:
            payload["format"] = request.json_schema
        return payload

    async def stream(self, request: ChatRequest) -> AsyncIterator[StreamEvent]:
        raw_calls: list[dict[str, Any]] = []
        stats: dict[str, Any] = {}
        try:
            async for chunk in self.client.chat(self.payload(request)):
                message = chunk.get("message") or {}
                if message.get("thinking"):
                    yield ThinkingDelta(str(message["thinking"]))
                if message.get("content"):
                    yield TextDelta(str(message["content"]))
                raw_calls.extend(message.get("tool_calls") or [])
                if chunk.get("done"):
                    stats = chunk
        except OllamaError as error:
            raise provider_error(error) from error
        for index, raw in enumerate(raw_calls):
            function = raw.get("function") or {}
            yield ToolCallEvent(
                ToolCall(
                    id=f"call_{index}",
                    name=str(function.get("name") or ""),
                    args=normalize_args(function.get("arguments", {})),
                )
            )
        seconds = (stats.get("eval_duration") or 0) / 1e9
        yield Usage(
            input=int(stats.get("prompt_eval_count") or 0),
            output=int(stats.get("eval_count") or 0),
            output_seconds=seconds or None,
        )
        yield Done(
            stop_reason=str(stats.get("done_reason") or "stop"),
            provider_state={"tool_calls": raw_calls} if raw_calls else None,
        )


def _wire_message(message: Message) -> dict[str, Any]:
    if message.role == "tool":
        return {"role": "tool", "content": message.content, "tool_name": message.name or ""}
    wire: dict[str, Any] = {"role": message.role, "content": message.content}
    if message.tool_calls:
        state = message.provider_state if message.provider_id == PROVIDER_ID else None
        wire["tool_calls"] = (state or {}).get("tool_calls") or [
            {"function": {"name": call.name, "arguments": call.args}} for call in message.tool_calls
        ]
    return wire
