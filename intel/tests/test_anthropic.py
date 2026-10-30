"""Anthropic Messages quirks (ADR-002 D3, D8, §1.4)."""

from __future__ import annotations

import asyncio
from typing import Any

import httpx2
import pytest
from fakes_anthropic import SPEC, AnthropicHarness, block_start, delta, error_body, finish, start, stop
from sse import CANARY, event_frames

from app.chat.providers import errors
from app.chat.providers.anthropic_messages import AnthropicProvider
from app.chat.providers.base import ChatRequest, Done, Message, ThinkingDelta, ToolCall, ToolCallEvent
from app.chat.providers.errors import ProviderError
from app.chat.providers.retry import stream_with_retries

TOOL = {
    "type": "function",
    "function": {"name": "lookup", "description": "Find.", "parameters": {"type": "object"}},
}


def run(harness: AnthropicHarness, chat: ChatRequest, attempts: int = 1) -> list[Any]:
    async def no_sleep(_: float) -> None:
        return None

    async def go() -> list[Any]:
        stream = stream_with_retries(lambda: harness.provider.stream(chat), attempts=attempts, sleep=no_sleep)
        return [event async for event in stream]

    return asyncio.run(go())


def ask(*messages: Message, **kwargs: Any) -> ChatRequest:
    messages = messages or (Message("system", "Be brief."), Message("user", "hi"))
    return ChatRequest("m", messages, tools=(TOOL,), params={"temperature": 0.2, "num_ctx": 8192}, **kwargs)


def test_the_request_has_a_top_level_system_and_no_sampling_or_thinking_fields() -> None:
    harness = AnthropicHarness()
    harness.answer("ok")
    run(harness, ask())
    body, headers = harness.upstream.bodies[0], harness.upstream.headers[0]
    assert body["system"] == "Be brief." and body["messages"] == [
        {"role": "user", "content": [{"type": "text", "text": "hi"}]}
    ]
    assert body["max_tokens"] == 4096 and body["tool_choice"] == {"type": "auto"}
    assert body["tools"] == [{"name": "lookup", "description": "Find.", "input_schema": {"type": "object"}}]
    assert not {"temperature", "top_p", "top_k", "thinking"} & set(body), (
        "rejected from API version 2026-10-21"
    )
    assert headers["anthropic-version"] == "2026-10-21" and CANARY in headers["authorization"]
    assert "anthropic-workspace-id" not in headers


def test_the_last_round_keeps_the_tools_with_tool_choice_none() -> None:
    harness = AnthropicHarness()
    harness.answer("ok")
    run(harness, ask(tool_choice="none"))
    body = harness.upstream.bodies[0]
    assert body["tool_choice"] == {"type": "none"} and body["tools"]


def test_every_tool_result_goes_first_in_one_user_message() -> None:
    harness = AnthropicHarness()
    harness.answer("ok")
    calls = (ToolCall("toolu_0", "lookup", {"q": "a"}), ToolCall("toolu_1", "lookup", {"q": "b"}))
    run(harness, ask(
        Message("user", "hi"),
        Message("assistant", "Checking.", tool_calls=calls, provider_id="anthropic"),
        Message("tool", "A", tool_call_id="toolu_0", name="lookup"),
        Message("tool", "B", tool_call_id="toolu_1", name="lookup"),
        Message("user", "and then?"),
    ))  # fmt: skip
    messages = harness.upstream.bodies[0]["messages"]
    assert [m["role"] for m in messages] == ["user", "assistant", "user"]
    assert [b["type"] for b in messages[1]["content"]] == ["text", "tool_use", "tool_use"]
    assert [(b["type"], b.get("tool_use_id")) for b in messages[2]["content"]] == [
        ("tool_result", "toolu_0"),
        ("tool_result", "toolu_1"),
        ("text", None),
    ]


def test_an_unanswered_question_in_history_merges_into_the_next_user_turn() -> None:
    harness = AnthropicHarness()
    harness.answer("ok")
    run(harness, ask(Message("user", "first"), Message("user", "second")))
    assert harness.upstream.bodies[0]["messages"] == [
        {"role": "user", "content": [{"type": "text", "text": "first"}, {"type": "text", "text": "second"}]}
    ]


def test_thinking_blocks_come_back_unmodified_to_anthropic_only() -> None:
    harness = AnthropicHarness()
    harness.events(
        start(),
        block_start(0, {"type": "thinking", "thinking": "", "signature": ""}),
        delta(0, type="thinking_delta", thinking="Need "),
        delta(0, type="thinking_delta", thinking="a lookup."),
        delta(0, type="signature_delta", signature="sig=="),
        stop(0),
        block_start(1, {"type": "tool_use", "id": "toolu_0", "name": "lookup", "input": {}}),
        delta(1, type="input_json_delta", partial_json='{"q": "x"}'),
        stop(1),
        *finish("tool_use"),
    )
    events = run(harness, ask())
    assert "".join(e.text for e in events if isinstance(e, ThinkingDelta)) == "Need a lookup."
    call = next(e.call for e in events if isinstance(e, ToolCallEvent))
    done = events[-1]
    assert isinstance(done, Done) and done.stop_reason == "tool_use"
    expected = [
        {"type": "thinking", "thinking": "Need a lookup.", "signature": "sig=="},
        {"type": "tool_use", "id": "toolu_0", "name": "lookup", "input": {"q": "x"}},
    ]
    assert done.provider_state == {"content": expected}

    def assistant_blocks(provider_id: str) -> list[dict[str, Any]]:
        harness.answer("done")
        assistant = Message("assistant", "", tool_calls=(call,), provider_id=provider_id,
                            provider_state=done.provider_state)  # fmt: skip
        run(harness, ask(Message("user", "hi"), assistant, Message("tool", "R", tool_call_id="toolu_0")))
        return harness.upstream.bodies[-1]["messages"][1]["content"]

    assert assistant_blocks("anthropic") == expected
    assert [b["type"] for b in assistant_blocks("openrouter")] == ["tool_use"], "a switch strips thinking"


def test_a_workspace_id_is_sent_when_set() -> None:
    harness = AnthropicHarness(workspace="wrkspc_1")
    harness.answer("ok")
    run(harness, ask())
    assert harness.upstream.headers[0]["anthropic-workspace-id"] == "wrkspc_1"


def test_a_spend_limit_429_is_quota_and_not_retried() -> None:
    harness = AnthropicHarness()
    body = error_body(429, "spend limit reached")
    body["error"]["details"] = {"error_code": "enforced_spend_limit_reached"}
    harness.replies.append((429, {}, body))
    harness.answer("unreached")
    with pytest.raises(ProviderError) as raised:
        run(harness, ask(), attempts=3)
    assert raised.value.code == errors.QUOTA_EXCEEDED and harness.upstream_requests == 1


def test_overloaded_is_retried() -> None:
    harness = AnthropicHarness()
    harness.fail(529)
    harness.answer("second")
    assert run(harness, ask(), attempts=3)[0].text == "second" and harness.upstream_requests == 2


def test_an_error_event_after_the_headers_is_mapped_by_its_type() -> None:
    harness = AnthropicHarness()
    overloaded = {"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}
    text = delta(0, type="text_delta", text="Hal")
    harness.events(start(), block_start(0, {"type": "text", "text": ""}), text, overloaded)
    with pytest.raises(ProviderError) as raised:
        run(harness, ask())
    assert raised.value.code == errors.PROVIDER_UNAVAILABLE


def test_the_model_list_follows_pages_and_reads_context() -> None:
    seen: list[str] = []

    def handle(request: httpx2.Request) -> httpx2.Response:
        seen.append(str(request.url.params.get("after_id")))
        if request.url.params.get("after_id") == "a":
            return httpx2.Response(200, json={"data": [{"id": "b", "display_name": "B"}], "has_more": False,
                                              "first_id": "b", "last_id": "b"})  # fmt: skip
        page = {"data": [{"id": "a", "display_name": "Model A", "max_input_tokens": 200000}],
                "has_more": True, "first_id": "a", "last_id": "a"}  # fmt: skip
        return httpx2.Response(200, json=page)

    http = httpx2.AsyncClient(transport=httpx2.MockTransport(handle))
    provider = AnthropicProvider(SPEC, SPEC.base_url, lambda: CANARY, http=http)
    models = asyncio.run(provider.list_models())
    assert [(m.id, m.label, m.context_window, m.supports_tools) for m in models] == [
        ("a", "Model A", 200000, "unknown"),
        ("b", "B", None, "unknown"),
    ]
    assert seen == ["None", "a"]


def test_no_key_fails_before_any_request() -> None:
    harness = AnthropicHarness(key=None)
    with pytest.raises(ProviderError) as raised:
        run(harness, ask())
    assert raised.value.code == errors.AUTH_FAILED and harness.upstream.paths == []


def test_frames_without_an_event_name_are_not_the_wire_format() -> None:
    # The SDK drops SSE frames without `event:`; the fake must name them.
    assert event_frames({"type": "ping"}) == [b'event: ping\ndata: {"type": "ping"}\n\n']
