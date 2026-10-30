"""A fake OpenAI Responses server, from ADR-002 §1.4: output items announced
by response.output_item.added, function arguments streamed by item_id,
usage in response.completed."""

from __future__ import annotations

import json
from typing import Any

from sse import CANARY, Reply, Upstream, event_frames, fake_server

from app.chat.providers.openai_responses import OpenAIResponsesProvider
from app.chat.providers.registry import ProviderSpec

SPEC = ProviderSpec("openai", "ChatGPT", "openai", "cloud", "https://api.openai.com/v1", ("OPENAI_API_KEY",))
MODELS = {
    "object": "list",
    "data": [
        {"id": "gpt-x", "object": "model", "created": 1, "owned_by": "openai"},
        {"id": "gpt-x-realtime", "object": "model", "created": 1, "owned_by": "openai"},
        {"id": "text-embedding-3-small", "object": "model", "created": 1, "owned_by": "openai"},
    ],
}


def completed(input_tokens: int = 3, output_tokens: int = 2) -> dict[str, Any]:
    usage = {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": input_tokens + output_tokens,
    }
    return {"type": "response.completed", "response": {"id": "resp_1", "status": "completed", "usage": usage}}


def message_events(text_chunks: tuple[str, ...], index: int = 0) -> list[dict[str, Any]]:
    item = {"type": "message", "id": f"msg_{index}", "role": "assistant", "content": []}
    deltas = [
        {
            "type": "response.output_text.delta",
            "item_id": f"msg_{index}",
            "output_index": index,
            "content_index": 0,
            "delta": piece,
        }
        for piece in text_chunks
    ]
    done_item = {**item, "content": [{"type": "output_text", "text": "".join(text_chunks)}]}
    return [
        {"type": "response.output_item.added", "output_index": index, "item": item},
        *deltas,
        {"type": "response.output_item.done", "output_index": index, "item": done_item},
    ]


def call_events(index: int, call_id: str, name: str, args: dict[str, Any]) -> list[dict[str, Any]]:
    text = json.dumps(args)
    item = {"type": "function_call", "id": f"fc_{index}", "call_id": call_id, "name": name, "arguments": ""}
    return [
        {"type": "response.output_item.added", "output_index": index, "item": item},
        {"type": "response.function_call_arguments.delta", "item_id": f"fc_{index}", "delta": text[:4]},
        {"type": "response.function_call_arguments.delta", "item_id": f"fc_{index}", "delta": text[4:]},
        {"type": "response.function_call_arguments.done", "item_id": f"fc_{index}", "arguments": text},
        {
            "type": "response.output_item.done",
            "output_index": index,
            "item": {**item, "arguments": text, "status": "completed"},
        },
    ]


def error_body(status: int, message: str = "scripted", **extra: Any) -> dict[str, Any]:
    return {
        "error": {"message": message, "type": "invalid_request_error", "code": None, "param": None, **extra}
    }


class ResponsesHarness:
    name = "openai_responses"
    unsupported: dict[str, str] = {}

    def __init__(self, *, key: str | None = CANARY, chat_models: frozenset[str] = frozenset()) -> None:
        self.upstream = Upstream()
        self.replies: list[Reply] = []
        self.http = fake_server(self.upstream, self.replies, lambda: MODELS)
        self.provider = OpenAIResponsesProvider(
            SPEC, SPEC.base_url, lambda: key, http=self.http, chat_models=lambda: chat_models
        )

    def events(self, *events: dict[str, Any]) -> None:
        self.replies.append((200, {}, event_frames(*events)))

    def answer(self, *chunks: str) -> None:
        self.events(
            {"type": "response.created", "response": {"id": "resp_1", "status": "in_progress"}},
            *message_events(chunks),
            completed(),
        )

    def tool_calls(self, *calls: tuple[str, dict[str, Any]]) -> None:
        body = [
            event for n, (name, args) in enumerate(calls) for event in call_events(n, f"call_{n}", name, args)
        ]
        self.events(*body, completed())

    def fail(self, status: int, headers: dict[str, str] | None = None) -> None:
        self.replies.append((status, headers or {}, error_body(status)))

    def fail_echoing_key(self, status: int) -> None:
        body = error_body(status, f"Incorrect API key provided: {CANARY}.", code="invalid_api_key")
        self.replies.append((status, {}, body))

    def fail_context(self) -> None:
        # UNVERIFIED shape (§1.4).
        body = error_body(
            400, "Your input exceeds the context window of this model.", code="context_length_exceeded"
        )
        self.replies.append((400, {}, body))

    def answer_with_unknown_event(self, text: str) -> None:
        self.events(
            {"type": "response.future_event", "sequence_number": 1, "x": 2},
            *message_events((text,)),
            completed(),
        )

    def long_answer(self, chunks: int) -> None:
        self.answer(*(f"t{n} " for n in range(chunks)))

    @property
    def upstream_requests(self) -> int:
        return len(self.upstream.bodies)

    @property
    def upstream_closed(self) -> bool:
        return self.upstream.closed_early > 0

    def sent_tool_results(self) -> list[tuple[str, str]]:
        items = self.upstream.bodies[-1]["input"]
        names = {item["call_id"]: item["name"] for item in items if item.get("type") == "function_call"}
        return [(names[i["call_id"]], i["output"]) for i in items if i.get("type") == "function_call_output"]
