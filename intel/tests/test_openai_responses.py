"""OpenAI Responses quirks (ADR-002 D3, D8, §1.4)."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from fakes_openai_responses import ResponsesHarness, call_events, completed, error_body, message_events

from app.chat.providers import errors
from app.chat.providers.base import ChatRequest, Done, Message, ToolCall, ToolCallEvent
from app.chat.providers.errors import ProviderError

TOOL = {
    "type": "function",
    "function": {"name": "lookup", "description": "Find.", "parameters": {"type": "object"}},
}


def run(harness: ResponsesHarness, chat: ChatRequest) -> list[Any]:
    async def go() -> list[Any]:
        return [event async for event in harness.provider.stream(chat)]

    return asyncio.run(go())


def ask(*messages: Message, model: str = "gpt-x", **kwargs: Any) -> ChatRequest:
    messages = messages or (Message("system", "Be brief."), Message("user", "hi"))
    return ChatRequest(model, messages, tools=(TOOL,), params={"temperature": 0.2}, **kwargs)


def effort_rejected() -> tuple[int, dict[str, str], dict[str, Any]]:
    return (400, {}, error_body(400, "Unsupported value: 'reasoning.effort'.", param="reasoning.effort"))


def test_the_request_is_stateless_with_flat_non_strict_tools() -> None:
    harness = ResponsesHarness()
    harness.answer("ok")
    run(harness, ask(tool_choice="none"))
    body = harness.upstream.bodies[0]
    assert harness.upstream.paths[-1] == "/v1/responses"
    assert body["instructions"] == "Be brief." and body["input"] == [{"role": "user", "content": "hi"}]
    assert body["store"] is False and body["include"] == ["reasoning.encrypted_content"]
    assert body["tools"] == [
        {
            "type": "function",
            "name": "lookup",
            "description": "Find.",
            "parameters": {"type": "object"},
            "strict": False,
        }
    ]
    assert body["tool_choice"] == "none" and body["max_output_tokens"] == 4096
    assert "temperature" not in body and body["reasoning"] == {"effort": "none"}


def test_the_lowest_accepted_effort_is_learned_once_per_model() -> None:
    harness = ResponsesHarness()
    harness.replies += [effort_rejected(), effort_rejected()]
    harness.answer("first")
    harness.answer("second")
    assert run(harness, ask())[0].text == "first"
    assert [b["reasoning"]["effort"] for b in harness.upstream.bodies] == ["none", "minimal", "low"]
    run(harness, ask())
    assert harness.upstream.bodies[-1]["reasoning"] == {"effort": "low"} and harness.upstream_requests == 4


def test_a_model_that_takes_no_effort_setting_is_asked_without_one() -> None:
    harness = ResponsesHarness()
    harness.replies += [effort_rejected(), effort_rejected(), effort_rejected()]
    harness.answer("ok")
    run(harness, ask())
    assert "reasoning" not in harness.upstream.bodies[-1] and harness.upstream_requests == 4


def test_other_400s_are_not_mistaken_for_an_effort_problem() -> None:
    harness = ResponsesHarness()
    harness.replies.append((400, {}, error_body(400, "Invalid tool schema", param="tools[0]")))
    with pytest.raises(ProviderError) as raised:
        run(harness, ask())
    assert raised.value.code == errors.UNSUPPORTED_FEATURE and harness.upstream_requests == 1


def test_reasoning_items_come_back_with_their_calls_to_openai_only() -> None:
    harness = ResponsesHarness()
    reasoning = {"type": "reasoning", "id": "rs_1", "summary": [], "encrypted_content": "gAAAA-opaque"}
    harness.events(
        {
            "type": "response.output_item.added",
            "output_index": 0,
            "item": {**reasoning, "encrypted_content": None},
        },
        {"type": "response.output_item.done", "output_index": 0, "item": reasoning},
        *call_events(1, "call_a", "lookup", {"q": "x"}),
        completed(),
    )
    events = run(harness, ask())
    call = next(e.call for e in events if isinstance(e, ToolCallEvent))
    done = events[-1]
    assert (call.id, call.args) == ("call_a", {"q": "x"})
    assert isinstance(done, Done) and done.stop_reason == "tool_calls"
    assert [item["type"] for item in done.provider_state["output"]] == ["reasoning", "function_call"]

    def replayed(provider_id: str) -> list[dict[str, Any]]:
        harness.answer("done")
        assistant = Message(
            "assistant",
            "",
            tool_calls=(ToolCall("call_a", "lookup", {"q": "x"}),),
            provider_id=provider_id,
            provider_state=done.provider_state,
        )
        run(harness, ask(Message("user", "hi"), assistant, Message("tool", "R", tool_call_id="call_a")))
        return harness.upstream.bodies[-1]["input"]

    items = replayed("openai")
    assert items[1] == reasoning and items[-1] == {
        "type": "function_call_output",
        "call_id": "call_a",
        "output": "R",
    }
    assert [i.get("type") for i in replayed("anthropic")] == [None, "function_call", "function_call_output"]


def test_a_model_marked_for_chat_completions_goes_there() -> None:
    harness = ResponsesHarness(chat_models=frozenset({"older"}))
    harness.replies.append(
        (
            200,
            {},
            [
                b'data: {"id":"c","object":"chat.completion.chunk","created":1,'
                b'"model":"older","choices":[{"index":0,"delta":{"content":"chat"},'
                b'"finish_reason":"stop"}]}\n\n',
                b"data: [DONE]\n\n",
            ],
        )
    )
    assert run(harness, ask(model="older"))[0].text == "chat"
    body = harness.upstream.bodies[0]
    assert harness.upstream.paths[-1] == "/v1/chat/completions"
    assert body["max_completion_tokens"] == 4096 and body["reasoning_effort"] == "none"


@pytest.mark.parametrize(
    ("event", "code"),
    [
        (
            {"type": "response.failed", "response": {"error": {"code": "server_error", "message": "boom"}}},
            errors.PROVIDER_UNAVAILABLE,
        ),
        (
            {
                "type": "response.failed",
                "response": {"error": {"code": "rate_limit_exceeded", "message": "slow"}},
            },
            errors.RATE_LIMITED,
        ),
        (
            {"type": "error", "code": "context_length_exceeded", "message": "too long", "param": None},
            errors.CONTEXT_TOO_LONG,
        ),
    ],
)
def test_failures_after_the_headers_are_mapped(event: dict[str, Any], code: str) -> None:
    harness = ResponsesHarness()
    harness.events(*message_events(("par",)), event)
    with pytest.raises(ProviderError) as raised:
        run(harness, ask())
    assert raised.value.code == code


def test_an_incomplete_response_ends_with_its_reason() -> None:
    harness = ResponsesHarness()
    incomplete = {
        "type": "response.incomplete",
        "response": {
            "incomplete_details": {"reason": "max_output_tokens"},
            "usage": {"input_tokens": 5, "output_tokens": 9},
        },
    }
    harness.events(*message_events(("cut",)), incomplete)
    events = run(harness, ask())
    assert events[-1].stop_reason == "max_output_tokens" and (events[-2].input, events[-2].output) == (5, 9)


def test_the_model_list_leaves_out_non_chat_models() -> None:
    harness = ResponsesHarness()
    models = asyncio.run(harness.provider.list_models())
    assert [(m.id, m.supports_tools, m.kind) for m in models] == [("gpt-x", "unknown", "cloud")]
