"""OpenAI-compatible Chat Completions (ADR-002 D1, D3): OpenRouter, NVIDIA NIM,
DeepSeek, a custom server (LM Studio, vLLM), and the Chat Completions path of
the OpenAI adapter.

The `openai` SDK speaks the wire format; its objects are turned into plain
dicts at once (`to_dict`) and never leave this module. Per-provider quirks are
the small table below, not subclasses.
"""

from __future__ import annotations

import json
import time
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from typing import Any

import httpx2
import openai

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
from .sdk import (
    DEFAULT_MAX_OUTPUT,
    LIST_TTL_SECONDS,
    SDK_ERRORS,
    TIMEOUT,
    endpoint_kind,
    key_may_travel,
    provider_error,
)

# Round-trip fields a provider needs back on its own assistant messages (D2):
# DeepSeek reasoning_content, OpenRouter reasoning_details.
PASSBACK_FIELDS = ("reasoning_content", "reasoning_details")
# Model families a chat picker should not offer (embedding, speech, images).
_NOT_CHAT = ("embed", "rerank", "tts", "whisper", "transcribe", "dall-e", "moderation")


@dataclass(frozen=True)
class Quirks:
    max_tokens_field: str = "max_tokens"
    temperature: bool = True
    disable_thinking: bool = False  # DeepSeek: thinking is on unless turned off
    reasoning_content_back: bool = False  # DeepSeek: 400 without it once tools are used
    tools_need_effort_none: bool = False  # OpenAI Chat Completions, GPT-5.4 and later


QUIRKS = {
    "deepseek": Quirks(disable_thinking=True, reasoning_content_back=True),
    "openai": Quirks(
        max_tokens_field="max_completion_tokens", temperature=False, tools_need_effort_none=True
    ),
}


def wire_message(message: Message, provider_id: str) -> dict[str, Any]:
    if message.role == "tool":
        return {"role": "tool", "tool_call_id": message.tool_call_id, "content": message.content}
    if message.role != "assistant":
        return {"role": message.role, "content": message.content}
    wired: dict[str, Any] = {"role": "assistant", "content": message.content or None}
    if message.tool_calls:
        wired["tool_calls"] = [
            {
                "id": call.id,
                "type": "function",
                "function": {"name": call.name, "arguments": json.dumps(call.args)},
            }
            for call in message.tool_calls
        ]
    # Replayed only to the provider that wrote it: a switch strips it (D2).
    if message.provider_id == provider_id and message.provider_state:
        for field in PASSBACK_FIELDS:
            if field in message.provider_state:
                wired[field] = message.provider_state[field]
    return wired


def model_info(data: dict[str, Any], kind: Kind) -> ModelInfo:
    supported = data.get("supported_parameters")
    tools = ("yes" if "tools" in supported else "no") if isinstance(supported, list) else "unknown"
    modalities = (
        (data.get("architecture") or {}).get("input_modalities") or data.get("input_modalities") or []
    )
    capabilities = {"completion"}
    if tools == "yes":
        capabilities.add("tools")
    if "image" in modalities:
        capabilities.add("vision")
    if data.get("reasoning") or (isinstance(supported, list) and "reasoning" in supported):
        capabilities.add("reasoning")
    if isinstance(supported, list) and {"response_format", "structured_outputs"} & set(supported):
        capabilities.add("json")
    context = data.get("context_length") or data.get("context_window")
    details = {
        key: data[key]
        for key in ("owned_by", "pricing", "max_output_tokens", "reasoning")
        if data.get(key) is not None
    }
    return ModelInfo(
        id=str(data["id"]),
        label=str(data.get("name") or data["id"]),
        kind=kind,
        supports_tools=tools,
        capabilities=frozenset(capabilities),
        context_window=context if isinstance(context, int) else None,
        details=details,
    )


class OpenAIChatProvider:
    max_attempts = 3

    def __init__(
        self,
        spec: ProviderSpec,
        base_url: str,
        key: KeyGetter,
        *,
        http: httpx2.AsyncClient,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.id = spec.id
        self.label = spec.label
        self.base_url = base_url
        self.kind: Kind = endpoint_kind(base_url)
        self.quirks = QUIRKS.get(spec.id, Quirks())
        self._key = key
        self._key_optional = spec.key_optional
        self._http = http
        self._clock = clock
        self._listed: tuple[float, list[ModelInfo]] | None = None

    def client(self) -> openai.AsyncOpenAI:
        key = self._key()
        if not key and not self._key_optional:
            raise ProviderError(errors.AUTH_FAILED, f"No API key is set for {self.label}", provider=self.id)
        if key and not key_may_travel(self.base_url):
            raise ProviderError(
                errors.UNSUPPORTED_FEATURE,
                "An API key is never sent over plain http to another machine",
                provider=self.id,
            )
        client = openai.AsyncOpenAI(
            api_key=key or "none",
            base_url=self.base_url,
            max_retries=0,  # one retry policy for every provider (D8)
            timeout=TIMEOUT,
            http_client=self._http,
        )
        # The SDK fills these from OPENAI_ORG_ID / OPENAI_PROJECT_ID and would send
        # them to any base URL, OpenRouter's included.
        client.organization = None
        client.project = None
        return client

    # -- models ------------------------------------------------------------------

    async def list_models(self) -> list[ModelInfo]:
        client = self.client()
        failure: ProviderError | None = None
        try:
            page = await client.models.list()
            rows = [model.to_dict(warnings=False) for model in page.data]
        except SDK_ERRORS as error:
            failure = provider_error(error, self.id)
        if failure is not None:
            raise failure
        models = [model_info(row, self.kind) for row in rows if row.get("id")]
        models = [m for m in models if not any(part in m.id.lower() for part in _NOT_CHAT)]
        self._listed = (self._clock(), models)
        return models

    async def model_caps(self, model: str) -> ModelInfo:
        """From the cached model list (refreshed every 10 minutes); a model the
        list does not show is `unknown`, and a list that fails for any reason
        but the key does not block the turn."""
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
        return ModelInfo(model, model, self.kind, "unknown")

    async def test(self) -> dict[str, Any]:
        return {"ok": True, "models": len(await self.list_models())}

    def _declares_json(self, model: str) -> bool:
        listed = self._listed[1] if self._listed else []
        return any(info.id == model and "json" in info.capabilities for info in listed)

    # -- chat ----------------------------------------------------------------------

    def payload(self, request: ChatRequest) -> dict[str, Any]:
        params = request.params
        body: dict[str, Any] = {
            "model": request.model,
            "messages": [wire_message(m, self.id) for m in request.messages],
            "stream_options": {"include_usage": True},
            self.quirks.max_tokens_field: int(params.get("max_output_tokens") or DEFAULT_MAX_OUTPUT),
        }
        if request.tools:
            # Sent on every request, the last one too (OpenRouter requires it, D3).
            body["tools"] = list(request.tools)
            body["tool_choice"] = request.tool_choice
            if self.quirks.tools_need_effort_none:
                body["reasoning_effort"] = "none"
        elif request.json_schema and self._declares_json(request.model):
            # Degraded mode (D3): a JSON response format only where the model's
            # list entry declares one; otherwise the prompt's instructions alone.
            body["response_format"] = {
                "type": "json_schema",
                "json_schema": {"name": "reply", "schema": request.json_schema},
            }
        if self.quirks.temperature and "temperature" in params:
            body["temperature"] = params["temperature"]
        if self.quirks.disable_thinking and not params.get("reasoning"):
            body["extra_body"] = {"thinking": {"type": "disabled"}}
        return body

    async def stream(self, request: ChatRequest) -> AsyncIterator[StreamEvent]:
        client = self.client()
        failure: ProviderError | None = None
        try:
            sdk_stream = await client.chat.completions.create(**self.payload(request), stream=True)
        except SDK_ERRORS as error:
            failure = provider_error(error, self.id)
        if failure is not None:
            raise failure
        if sdk_stream.response.status_code == 202:  # NIM "pending": no polling in v1 (D8)
            await sdk_stream.close()
            raise ProviderError(
                errors.UNSUPPORTED_FEATURE, "The model answered asynchronously (202)", provider=self.id
            )
        calls: dict[int, dict[str, str]] = {}
        reasoning: list[str] = []
        details: list[Any] = []
        usage: dict[str, Any] = {}
        finish = "stop"
        try:
            async for chunk in sdk_stream:
                data = chunk.to_dict(warnings=False)
                usage = data.get("usage") or usage
                for choice in data.get("choices") or []:
                    delta = choice.get("delta") or {}
                    if delta.get("content"):
                        yield TextDelta(delta["content"])
                    thought = delta.get("reasoning_content") or delta.get("reasoning")
                    if thought:
                        reasoning.append(thought)
                        yield ThinkingDelta(thought)
                    details.extend(delta.get("reasoning_details") or [])
                    for part in delta.get("tool_calls") or []:
                        call = calls.setdefault(
                            int(part.get("index") or 0), {"id": "", "name": "", "args": ""}
                        )
                        function = part.get("function") or {}
                        call["id"] = part.get("id") or call["id"]
                        call["name"] = function.get("name") or call["name"]
                        call["args"] += function.get("arguments") or ""
                    finish = choice.get("finish_reason") or finish
        except SDK_ERRORS as error:
            failure = provider_error(error, self.id)
        finally:
            await sdk_stream.close()
        if failure is not None:
            raise failure
        if finish == "insufficient_system_resource":  # DeepSeek
            raise ProviderError(
                errors.PROVIDER_UNAVAILABLE, "The provider ran out of capacity", provider=self.id
            )
        for index in sorted(calls):
            call = calls[index]
            yield ToolCallEvent(
                ToolCall(call["id"] or f"call_{index}", call["name"], normalize_args(call["args"]))
            )
        yield Usage(int(usage.get("prompt_tokens") or 0), int(usage.get("completion_tokens") or 0))
        state: dict[str, Any] = {}
        if reasoning and self.quirks.reasoning_content_back:
            state["reasoning_content"] = "".join(reasoning)
        if details:
            state["reasoning_details"] = details
        yield Done(finish, provider_state=state or None)
