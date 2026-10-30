"""Anthropic's native Messages API (ADR-002 D1, D3, §1.4), through the
`anthropic` SDK (API version 2026-10-21, the SDK's default).

- No `temperature`, `top_p` or `top_k`: that API version rejects them.
- No `thinking` field: leaving it out means adaptive thinking, and some
  models reject `{type: "disabled"}`. Thinking blocks that come back are kept
  with their signatures and replayed unmodified to Anthropic only.
- Every `tool_result` of a round goes first, in one `user` message.
- `tool_choice` is `auto`, or `none` for the last round, never `any`/`tool`.
"""

from __future__ import annotations

import time
from collections.abc import AsyncIterator, Callable
from typing import Any

import anthropic
import httpx2

from . import errors
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
from .errors import ProviderError
from .registry import KeyGetter, ProviderSpec
from .sdk import DEFAULT_MAX_OUTPUT, LIST_TTL_SECONDS, SDK_ERRORS, TIMEOUT, key_may_travel, provider_error

_THINKING = ("thinking", "redacted_thinking")


def wire_tools(tools: tuple[dict[str, Any], ...]) -> list[dict[str, Any]]:
    wired = []
    for tool in tools:
        function = tool.get("function") or tool
        wired.append(
            {
                "name": function["name"],
                "description": function.get("description", ""),
                "input_schema": function.get("parameters") or {"type": "object"},
            }
        )
    return wired


def _blocks(message: Message, provider_id: str) -> list[dict[str, Any]]:
    if message.role == "tool":
        return [{"type": "tool_result", "tool_use_id": message.tool_call_id, "content": message.content}]
    if message.role == "assistant":
        state = message.provider_state or {}
        if message.provider_id == provider_id and state.get("content"):
            return list(state["content"])  # unmodified, thinking signatures included
        blocks = [{"type": "text", "text": message.content}] if message.content else []
        return blocks + [
            {"type": "tool_use", "id": call.id, "name": call.name, "input": call.args}
            for call in message.tool_calls
        ]
    return [{"type": "text", "text": message.content}] if message.content else []


def wire_messages(messages: tuple[Message, ...], provider_id: str) -> list[dict[str, Any]]:
    """Canonical messages as alternating turns. Tool results become user
    turns; consecutive turns of one role merge (an unanswered question left
    in history, or several tool results), keeping tool results first."""
    turns: list[dict[str, Any]] = []
    for message in messages:
        if message.role == "system":
            continue
        role = "assistant" if message.role == "assistant" else "user"
        blocks = _blocks(message, provider_id)
        if not blocks:
            continue
        if turns and turns[-1]["role"] == role:
            merged = turns[-1]["content"] + blocks
            results = [b for b in merged if b.get("type") == "tool_result"]
            turns[-1]["content"] = results + [b for b in merged if b.get("type") != "tool_result"]
        else:
            turns.append({"role": role, "content": blocks})
    return turns


def model_info(data: dict[str, Any]) -> ModelInfo:
    capabilities = {"completion"}
    declared = data.get("capabilities") or {}
    if isinstance(declared, dict):
        if any("image" in str(name) and value for name, value in declared.items()):
            capabilities.add("vision")
        if declared.get("thinking"):
            capabilities.add("reasoning")
    context = data.get("max_input_tokens")
    details = {key: data[key] for key in ("max_tokens", "lifecycle") if data.get(key) is not None}
    return ModelInfo(
        id=str(data["id"]),
        label=str(data.get("display_name") or data["id"]),
        kind="cloud",
        supports_tools="unknown",  # Anthropic publishes no flag; the agent probes (D3)
        capabilities=frozenset(capabilities),
        context_window=context if isinstance(context, int) else None,
        details=details,
    )


class AnthropicProvider:
    kind: Kind = "cloud"
    max_attempts = 3

    def __init__(
        self,
        spec: ProviderSpec,
        base_url: str,
        key: KeyGetter,
        *,
        http: httpx2.AsyncClient,
        workspace: Callable[[], str | None] = lambda: None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.id = spec.id
        self.label = spec.label
        self.base_url = base_url
        self._key = key
        self._workspace = workspace
        self._http = http
        self._clock = clock
        self._listed: tuple[float, list[ModelInfo]] | None = None

    def client(self) -> anthropic.AsyncAnthropic:
        key = self._key()
        if not key:
            raise ProviderError(errors.AUTH_FAILED, f"No API key is set for {self.label}", provider=self.id)
        if not key_may_travel(self.base_url):
            raise ProviderError(
                errors.UNSUPPORTED_FEATURE,
                "An API key is never sent over plain http to another machine",
                provider=self.id,
            )
        workspace = self._workspace()
        return anthropic.AsyncAnthropic(
            api_key=key,
            base_url=self.base_url,
            max_retries=0,
            timeout=TIMEOUT,
            http_client=self._http,
            default_headers={"anthropic-workspace-id": workspace} if workspace else None,
        )

    async def list_models(self) -> list[ModelInfo]:
        client = self.client()
        failure: ProviderError | None = None
        rows: list[dict[str, Any]] = []
        try:
            async for model in client.models.list(limit=1000):
                rows.append(model.to_dict(warnings=False))
        except SDK_ERRORS as error:
            failure = provider_error(error, self.id)
        if failure is not None:
            raise failure
        models = [model_info(row) for row in rows if row.get("id")]
        self._listed = (self._clock(), models)
        return models

    async def model_caps(self, model: str) -> ModelInfo:
        if self._listed is None or self._clock() - self._listed[0] > LIST_TTL_SECONDS:
            try:
                await self.list_models()
            except ProviderError as error:
                if error.code == errors.AUTH_FAILED:
                    raise
                self._listed = (self._clock(), [])
        for info in self._listed[1] if self._listed else []:
            if info.id == model:
                return info
        return ModelInfo(model, model, "cloud", "unknown")

    async def test(self) -> dict[str, Any]:
        return {"ok": True, "models": len(await self.list_models())}

    def payload(self, request: ChatRequest) -> dict[str, Any]:
        body: dict[str, Any] = {
            "model": request.model,
            "max_tokens": int(request.params.get("max_output_tokens") or DEFAULT_MAX_OUTPUT),
            "messages": wire_messages(request.messages, self.id),
        }
        system = "\n\n".join(m.content for m in request.messages if m.role == "system" and m.content)
        if system:
            body["system"] = system
        if request.tools:
            body["tools"] = wire_tools(request.tools)
            body["tool_choice"] = {"type": "none" if request.tool_choice == "none" else "auto"}
        return body

    async def stream(self, request: ChatRequest) -> AsyncIterator[StreamEvent]:
        client = self.client()
        failure: ProviderError | None = None
        try:
            sdk_stream = await client.messages.create(**self.payload(request), stream=True)
        except SDK_ERRORS as error:
            failure = provider_error(error, self.id)
        if failure is not None:
            raise failure
        blocks: dict[int, dict[str, Any]] = {}
        partial: dict[int, str] = {}
        tokens_in = tokens_out = 0
        stop = "end_turn"
        try:
            async for event in sdk_stream:
                data = event.to_dict(warnings=False)
                kind = data.get("type")
                if kind == "message_start":
                    usage = (data.get("message") or {}).get("usage") or {}
                    tokens_in = sum(
                        int(usage.get(key) or 0)
                        for key in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")
                    )
                elif kind == "content_block_start":
                    blocks[int(data["index"])] = dict(data.get("content_block") or {})
                elif kind == "content_block_delta":
                    index = int(data["index"])
                    block = blocks.setdefault(index, {})
                    delta = data.get("delta") or {}
                    dtype = delta.get("type")
                    if dtype == "text_delta":
                        block["text"] = block.get("text", "") + delta.get("text", "")
                        yield TextDelta(delta.get("text", ""))
                    elif dtype == "input_json_delta":
                        partial[index] = partial.get(index, "") + delta.get("partial_json", "")
                    elif dtype == "thinking_delta":
                        block["thinking"] = block.get("thinking", "") + delta.get("thinking", "")
                        yield ThinkingDelta(delta.get("thinking", ""))
                    elif dtype == "signature_delta":
                        block["signature"] = block.get("signature", "") + delta.get("signature", "")
                elif kind == "message_delta":
                    stop = (data.get("delta") or {}).get("stop_reason") or stop
                    tokens_out = int((data.get("usage") or {}).get("output_tokens") or tokens_out)
                # ping, message_stop, content_block_stop and new event types: nothing to do
        except SDK_ERRORS as error:
            failure = provider_error(error, self.id)
        finally:
            await sdk_stream.close()
        if failure is not None:
            raise failure
        content = []
        for index in sorted(blocks):
            block = blocks[index]
            if block.get("type") == "tool_use":
                block["input"] = (
                    normalize_args(partial[index]) if index in partial else block.get("input") or {}
                )
                yield ToolCallEvent(ToolCall(str(block["id"]), str(block["name"]), block["input"]))
            content.append(block)
        yield Usage(tokens_in, tokens_out)
        thinking = any(block.get("type") in _THINKING for block in content)
        yield Done(stop, provider_state={"content": content} if thinking else None)
