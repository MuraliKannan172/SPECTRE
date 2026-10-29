"""Provider-agnostic chat types for the Neural Core (ADR-002 D1, D2).

Adapters turn these into one provider's wire format and back. Nothing
provider-specific crosses this boundary except `provider_state`, which is
opaque, replayed only to the provider that produced it, and dropped when a
conversation changes provider. Errors are raised as `ProviderError`
(errors.py), not sent as events.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

Role = Literal["system", "user", "assistant", "tool"]
Kind = Literal["local", "remote", "cloud"]
Support = Literal["yes", "no", "unknown"]
ToolChoice = Literal["auto", "none"]


@dataclass(frozen=True)
class ToolCall:
    id: str
    name: str
    # A dict, unless the model sent arguments that are not a JSON object;
    # tool validation reports those back to the model.
    args: Any


@dataclass(frozen=True)
class Message:
    role: Role
    content: str = ""
    tool_calls: tuple[ToolCall, ...] = ()
    tool_call_id: str | None = None
    # For a tool result: the tool it answers (Ollama matches results by name).
    name: str | None = None
    provider_id: str | None = None
    model: str | None = None
    provider_state: dict[str, Any] | None = None


@dataclass(frozen=True)
class ChatRequest:
    model: str
    messages: tuple[Message, ...]
    tools: tuple[dict[str, Any], ...] = ()
    # "none" asks for an answer, not a call. Adapters keep sending the tool
    # definitions when their API needs them (ADR-002 D3, the forced answer).
    tool_choice: ToolChoice = "auto"
    # A JSON schema the reply must follow (the no-native-tools fallback).
    json_schema: dict[str, Any] | None = None
    params: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class TextDelta:
    text: str


@dataclass(frozen=True)
class ThinkingDelta:
    text: str


@dataclass(frozen=True)
class ToolCallEvent:
    """One complete call: adapters accumulate streamed fragments first."""

    call: ToolCall


@dataclass(frozen=True)
class Usage:
    input: int
    output: int
    # Seconds spent generating the output, when the provider reports it.
    output_seconds: float | None = None


@dataclass(frozen=True)
class Done:
    stop_reason: str
    provider_state: dict[str, Any] | None = None


StreamEvent = TextDelta | ThinkingDelta | ToolCallEvent | Usage | Done


@dataclass(frozen=True)
class ModelInfo:
    id: str
    label: str
    kind: Kind
    supports_tools: Support
    capabilities: frozenset[str] = frozenset()
    context_window: int | None = None
    details: dict[str, Any] = field(default_factory=dict)


class ChatProvider(Protocol):
    id: str
    kind: Kind
    # Attempts per request, retries included (1 means never retry).
    max_attempts: int

    async def list_models(self) -> list[ModelInfo]: ...

    async def model_caps(self, model: str) -> ModelInfo: ...

    async def test(self) -> dict[str, Any]: ...

    def stream(self, request: ChatRequest) -> AsyncIterator[StreamEvent]: ...


def normalize_args(raw: Any) -> Any:
    """Tool-call arguments as a dict: an object stays, a JSON string is
    parsed, anything unparseable becomes {"_unparsed": ...} so validation
    tells the model what went wrong."""
    if isinstance(raw, str):
        try:
            return json.loads(raw) if raw.strip() else {}
        except ValueError:
            return {"_unparsed": raw[:200]}
    return raw if raw is not None else {}
