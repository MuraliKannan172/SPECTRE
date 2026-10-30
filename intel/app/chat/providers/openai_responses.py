"""OpenAI through the Responses API (ADR-002 D1, D3, §1.4), with Chat
Completions for the models marked for it.

- Requests use `store: false` and ask for encrypted reasoning back; reasoning
  items that come with tool calls are replayed, unmodified, to OpenAI only.
- Tools are flat with `strict: false` (leaving `strict` out turns strict mode
  on, and our schemas have optional properties).
- Reasoning effort: the lowest the model accepts. The adapter starts at
  `none` and steps up when a 400 names `reasoning.effort`, then remembers the
  answer per model for the life of the service.
- Chat Completions: only for models listed in the provider's settings
  (`chat_completions_models`). Learning it from a Responses error waits for a
  verified error shape (ADR-002 §8).
"""

from __future__ import annotations

import json
import time
from collections.abc import AsyncIterator, Callable
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
from .openai_chat import OpenAIChatProvider
from .registry import KeyGetter, ProviderSpec
from .sdk import DEFAULT_MAX_OUTPUT, SDK_ERRORS, classify, provider_error

REASONING_EFFORT = "medium"  # when the user turns reasoning on (D11)
EFFORTS = ("none", "minimal", "low")
# Not chat models, on OpenAI's own list (it carries no capability data).
_NOT_RESPONSES = ("realtime", "audio", "image", "search", "computer-use", "codex-mini")


def wire_tools(tools: tuple[dict[str, Any], ...]) -> list[dict[str, Any]]:
    wired = []
    for tool in tools:
        function = tool.get("function") or tool
        wired.append(
            {
                "type": "function",
                "name": function["name"],
                "description": function.get("description", ""),
                "parameters": function.get("parameters") or {"type": "object"},
                "strict": False,
            }
        )
    return wired


def wire_input(messages: tuple[Message, ...], provider_id: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for message in messages:
        if message.role == "system":
            continue
        if message.role == "tool":
            items.append(
                {"type": "function_call_output", "call_id": message.tool_call_id, "output": message.content}
            )
            continue
        state = message.provider_state or {}
        if message.role == "assistant" and message.provider_id == provider_id and state.get("output"):
            items.extend(state["output"])  # reasoning items with their calls, unmodified
            continue
        if message.content:
            items.append({"role": message.role, "content": message.content})
        items.extend(
            {
                "type": "function_call",
                "call_id": call.id,
                "name": call.name,
                "arguments": json.dumps(call.args),
            }
            for call in message.tool_calls
        )
    return items


class OpenAIResponsesProvider:
    kind: Kind = "cloud"
    max_attempts = 3

    def __init__(
        self,
        spec: ProviderSpec,
        base_url: str,
        key: KeyGetter,
        *,
        http: httpx2.AsyncClient,
        chat_models: Callable[[], frozenset[str]] = frozenset,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.id = spec.id
        self.base_url = base_url
        self.chat = OpenAIChatProvider(spec, base_url, key, http=http, clock=clock)
        self._chat_models = chat_models
        self._effort: dict[str, str | None] = {}

    async def list_models(self) -> list[ModelInfo]:
        models = await self.chat.list_models()
        return [m for m in models if not any(part in m.id.lower() for part in _NOT_RESPONSES)]

    async def model_caps(self, model: str) -> ModelInfo:
        return await self.chat.model_caps(model)

    async def test(self) -> dict[str, Any]:
        return {"ok": True, "models": len(await self.list_models())}

    def payload(self, request: ChatRequest, effort: str | None) -> dict[str, Any]:
        body: dict[str, Any] = {
            "model": request.model,
            "input": wire_input(request.messages, self.id),
            "store": False,
            "include": ["reasoning.encrypted_content"],
            "max_output_tokens": int(request.params.get("max_output_tokens") or DEFAULT_MAX_OUTPUT),
        }
        instructions = "\n\n".join(m.content for m in request.messages if m.role == "system" and m.content)
        if instructions:
            body["instructions"] = instructions
        if request.tools:
            body["tools"] = wire_tools(request.tools)
            body["tool_choice"] = request.tool_choice
        elif request.json_schema:
            body["text"] = {
                "format": {
                    "type": "json_schema",
                    "name": "reply",
                    "schema": request.json_schema,
                    "strict": False,
                }
            }
        if effort:
            body["reasoning"] = {"effort": effort}
        return body

    async def _open(self, request: ChatRequest) -> Any:
        """Open the stream at the lowest effort the model accepts."""
        client = self.chat.client()
        known = request.model in self._effort
        ladder: tuple[str | None, ...] = (self._effort[request.model],) if known else (*EFFORTS, None)
        if request.params.get("reasoning"):
            # Asked for: one fixed effort, and the learned lowest one stays as it was.
            ladder = (REASONING_EFFORT,)
        for effort in ladder:
            failure: ProviderError | None = None
            rejected = False
            try:
                opened = await client.responses.create(**self.payload(request, effort), stream=True)
            except openai.BadRequestError as error:
                rejected = error.param == "reasoning.effort" and effort is not None
                failure = None if rejected else provider_error(error, self.id)
            except SDK_ERRORS as error:
                failure = provider_error(error, self.id)
            if failure is not None:
                raise failure
            if not rejected:
                if not request.params.get("reasoning"):
                    self._effort[request.model] = effort
                return opened
        raise ProviderError(errors.UNSUPPORTED_FEATURE, "No reasoning effort was accepted", provider=self.id)

    def _failed(self, error: dict[str, Any]) -> ProviderError:
        """A failure reported inside the stream (no HTTP status)."""
        code = classify(None, {"error": error})
        detail = str(error.get("code") or "")
        return ProviderError(code, str(error.get("message") or ""), provider=self.id, detail=detail)

    async def stream(self, request: ChatRequest) -> AsyncIterator[StreamEvent]:
        if request.model in self._chat_models():
            async for event in self.chat.stream(request):
                yield event
            return
        sdk_stream = await self._open(request)
        calls: dict[str, dict[str, Any]] = {}  # by item_id, in the order they were added
        output: dict[int, dict[str, Any]] = {}
        usage: dict[str, Any] = {}
        stop = "stop"
        failure: ProviderError | None = None
        try:
            async for event in sdk_stream:
                data = event.to_dict(warnings=False)
                kind = data.get("type")
                if kind == "response.output_text.delta":
                    yield TextDelta(str(data.get("delta") or ""))
                elif kind == "response.reasoning_summary_text.delta":
                    yield ThinkingDelta(str(data.get("delta") or ""))
                elif kind == "response.output_item.added":
                    item = data.get("item") or {}
                    if item.get("type") == "function_call":
                        calls[str(item.get("id"))] = {**item, "arguments": item.get("arguments") or ""}
                elif kind == "response.function_call_arguments.delta":
                    call = calls.setdefault(str(data.get("item_id")), {"arguments": ""})
                    call["arguments"] += str(data.get("delta") or "")
                elif kind == "response.function_call_arguments.done":
                    calls.setdefault(str(data.get("item_id")), {})["arguments"] = str(
                        data.get("arguments") or ""
                    )
                elif kind == "response.output_item.done":
                    item = data.get("item") or {}
                    output[int(data.get("output_index") or len(output))] = item
                    if item.get("type") == "function_call":
                        calls[str(item.get("id"))] = item
                elif kind == "response.completed":
                    usage = (data.get("response") or {}).get("usage") or {}
                elif kind == "response.incomplete":
                    response = data.get("response") or {}
                    usage = response.get("usage") or {}
                    stop = str((response.get("incomplete_details") or {}).get("reason") or "incomplete")
                elif kind == "response.failed":
                    failure = self._failed((data.get("response") or {}).get("error") or {})
                    break
                elif kind == "error":
                    failure = self._failed(data)
                    break
        except SDK_ERRORS as error:
            failure = provider_error(error, self.id)
        finally:
            await sdk_stream.close()
        if failure is not None:
            raise failure
        for call in calls.values():
            yield ToolCallEvent(
                ToolCall(
                    str(call.get("call_id")), str(call.get("name")), normalize_args(call.get("arguments"))
                )
            )
        yield Usage(int(usage.get("input_tokens") or 0), int(usage.get("output_tokens") or 0))
        items = [output[index] for index in sorted(output)]
        reasoning = any(item.get("type") == "reasoning" for item in items)
        yield Done("tool_calls" if calls else stop, provider_state={"output": items} if reasoning else None)
