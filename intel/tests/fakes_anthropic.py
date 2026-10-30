"""A fake Anthropic Messages server, from ADR-002 §1.4: named SSE events
(message_start, content_block_start/delta/stop, message_delta, message_stop,
ping), tool input as input_json_delta.partial_json, cumulative usage."""

from __future__ import annotations

import json
from typing import Any

from sse import CANARY, Reply, Upstream, event_frames, fake_server

from app.chat.providers.anthropic_messages import AnthropicProvider
from app.chat.providers.registry import ProviderSpec

SPEC = ProviderSpec(
    "anthropic", "Claude", "anthropic", "cloud", "https://api.anthropic.com", ("ANTHROPIC_API_KEY",)
)
_TYPES = {
    401: "authentication_error",
    402: "billing_error",
    403: "permission_error",
    404: "not_found_error",
    429: "rate_limit_error",
    500: "api_error",
    529: "overloaded_error",
}


def start(input_tokens: int = 3) -> dict[str, Any]:
    message = {
        "id": "msg_1",
        "type": "message",
        "role": "assistant",
        "model": "m",
        "content": [],
        "stop_reason": None,
        "usage": {"input_tokens": input_tokens, "output_tokens": 1},
    }
    return {"type": "message_start", "message": message}


def block_start(index: int, block: dict[str, Any]) -> dict[str, Any]:
    return {"type": "content_block_start", "index": index, "content_block": block}


def delta(index: int, **body: Any) -> dict[str, Any]:
    return {"type": "content_block_delta", "index": index, "delta": body}


def stop(index: int) -> dict[str, Any]:
    return {"type": "content_block_stop", "index": index}


def finish(reason: str, output_tokens: int = 2) -> list[dict[str, Any]]:
    message_delta = {
        "type": "message_delta",
        "delta": {"stop_reason": reason},
        "usage": {"output_tokens": output_tokens},
    }
    return [message_delta, {"type": "message_stop"}]


def error_body(status: int, message: str = "scripted") -> dict[str, Any]:
    return {
        "type": "error",
        "error": {"type": _TYPES.get(status, "invalid_request_error"), "message": message},
    }


class AnthropicHarness:
    name = "anthropic"
    unsupported: dict[str, str] = {}

    def __init__(self, *, key: str | None = CANARY, workspace: str | None = None, models: Any = None) -> None:
        self.upstream = Upstream()
        self.replies: list[Reply] = []
        pages = models or {
            "data": [
                {
                    "id": "m",
                    "type": "model",
                    "display_name": "Model M",
                    "max_input_tokens": 200000,
                    "max_tokens": 64000,
                }
            ],
            "has_more": False,
            "first_id": "m",
            "last_id": "m",
        }
        self.http = fake_server(self.upstream, self.replies, lambda: pages)
        self.provider = AnthropicProvider(
            SPEC, SPEC.base_url, lambda: key, http=self.http, workspace=lambda: workspace
        )

    def events(self, *events: dict[str, Any]) -> None:
        self.replies.append((200, {}, event_frames(*events)))

    def answer(self, *chunks: str) -> None:
        text = [delta(0, type="text_delta", text=piece) for piece in chunks]
        self.events(
            start(),
            block_start(0, {"type": "text", "text": ""}),
            {"type": "ping"},
            *text,
            stop(0),
            *finish("end_turn"),
        )

    def tool_calls(self, *calls: tuple[str, dict[str, Any]]) -> None:
        body: list[dict[str, Any]] = []
        for index, (name, args) in enumerate(calls):
            text = json.dumps(args)
            body += [
                block_start(index, {"type": "tool_use", "id": f"toolu_{index}", "name": name, "input": {}}),
                delta(index, type="input_json_delta", partial_json=text[:4]),
                delta(index, type="input_json_delta", partial_json=text[4:]),
                stop(index),
            ]
        self.events(start(), *body, *finish("tool_use"))

    def fail(self, status: int, headers: dict[str, str] | None = None) -> None:
        self.replies.append((status, headers or {}, error_body(status)))

    def fail_echoing_key(self, status: int) -> None:
        self.replies.append((status, {}, error_body(status, f"invalid x-api-key: {CANARY}")))

    def fail_context(self) -> None:
        # UNVERIFIED shape (§1.4): the message text is what is mapped.
        body = error_body(400, "prompt is too long: 250000 tokens > 200000 maximum")
        self.replies.append((400, {}, body))

    def answer_with_unknown_event(self, text: str) -> None:
        self.events(
            start(),
            {"type": "future_event", "x": 1},
            block_start(0, {"type": "text", "text": ""}),
            delta(0, type="future_delta", foo=1),
            delta(0, type="text_delta", text=text),
            stop(0),
            *finish("end_turn"),
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
        messages = self.upstream.bodies[-1]["messages"]
        names = {
            block["id"]: block["name"]
            for message in messages
            for block in message["content"]
            if block.get("type") == "tool_use"
        }
        return [
            (names[block["tool_use_id"]], block["content"])
            for block in messages[-1]["content"]
            if block.get("type") == "tool_result"
        ]
