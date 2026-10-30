"""Chat Completions quirks per provider (ADR-002 D3, D8, §1.4)."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest
from fakes_openai_chat import USAGE, OpenAIChatHarness, chunk
from sse import CANARY

from app.chat.providers import errors
from app.chat.providers.base import ChatRequest, Done, Message, ThinkingDelta, ToolCall, ToolCallEvent
from app.chat.providers.errors import ProviderError
from app.chat.providers.sdk import classify, endpoint_kind

TOOL = {"type": "function", "function": {"name": "lookup", "parameters": {"type": "object"}}}


def run(harness: OpenAIChatHarness, chat: ChatRequest) -> list[Any]:
    async def go() -> list[Any]:
        return [event async for event in harness.provider.stream(chat)]

    return asyncio.run(go())


def ask(*messages: Message, **kwargs: Any) -> ChatRequest:
    return ChatRequest("m", messages or (Message("user", "hi"),), tools=(TOOL,), **kwargs)


def test_deepseek_thinking_is_off_unless_asked_for() -> None:
    harness = OpenAIChatHarness("deepseek")
    harness.answer("ok")
    harness.answer("ok")
    run(harness, ask(params={"temperature": 0.2}))
    run(harness, ask(params={"reasoning": True}))
    assert harness.upstream.bodies[0]["thinking"] == {"type": "disabled"}
    assert "thinking" not in harness.upstream.bodies[1]


def test_deepseek_reasoning_comes_back_on_every_later_request_and_not_after_a_switch() -> None:
    harness = OpenAIChatHarness("deepseek")
    call = {"index": 0, "id": "call_1", "type": "function", "function": {"name": "lookup", "arguments": "{}"}}
    harness.stream(
        chunk({"reasoning_content": "Need a lookup."}),
        chunk({"tool_calls": [call]}),
        chunk({}, "tool_calls"),
        USAGE,
    )
    events = run(harness, ask(params={"reasoning": True}))
    done = events[-1]
    assert isinstance(done, Done) and done.provider_state == {"reasoning_content": "Need a lookup."}
    assert [e.text for e in events if isinstance(e, ThinkingDelta)] == ["Need a lookup."]

    def follow_up(provider_id: str) -> dict[str, Any]:
        assistant = Message(
            "assistant",
            "",
            tool_calls=(ToolCall("call_1", "lookup", {}),),
            provider_id=provider_id,
            provider_state=done.provider_state,
        )
        harness.answer("Done.")
        run(harness, ask(Message("user", "hi"), assistant, Message("tool", "R", tool_call_id="call_1")))
        return harness.upstream.bodies[-1]["messages"][1]

    assert follow_up("deepseek")["reasoning_content"] == "Need a lookup."
    assert "reasoning_content" not in follow_up("openrouter"), "another provider's state is stripped"


def test_openrouter_reasoning_details_are_kept_in_order_and_replayed() -> None:
    harness = OpenAIChatHarness("openrouter")
    details = [
        {"type": "reasoning.text", "text": "a", "index": 0},
        {"type": "reasoning.encrypted", "data": "x"},
    ]
    harness.stream(
        chunk({"reasoning_details": details[:1]}),
        chunk({"reasoning_details": details[1:]}),
        chunk({"content": "ok"}, "stop"),
        USAGE,
    )
    done = run(harness, ask())[-1]
    assert done.provider_state == {"reasoning_details": details}
    harness.answer("again")
    previous = Message("assistant", "ok", provider_id="openrouter", provider_state=done.provider_state)
    run(harness, ask(Message("user", "hi"), previous, Message("user", "more")))
    assert harness.upstream.bodies[-1]["messages"][1]["reasoning_details"] == details


def test_the_last_round_keeps_the_tools_and_asks_for_no_call() -> None:
    harness = OpenAIChatHarness("openrouter")
    harness.answer("ok")
    run(harness, ask(tool_choice="none"))
    body = harness.upstream.bodies[0]
    assert body["tools"] == [TOOL] and body["tool_choice"] == "none"
    assert body["max_tokens"] == 4096 and body["stream_options"] == {"include_usage": True}


def test_openai_chat_completions_use_its_own_parameters() -> None:
    harness = OpenAIChatHarness("openai")
    harness.answer("ok")
    run(harness, ask(params={"temperature": 0.2, "max_output_tokens": 500}))
    body = harness.upstream.bodies[0]
    assert body["max_completion_tokens"] == 500 and "max_tokens" not in body
    assert "temperature" not in body and body["reasoning_effort"] == "none"


def test_the_openai_org_and_project_from_the_environment_are_never_sent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OPENAI_ORG_ID", "org-private")
    monkeypatch.setenv("OPENAI_PROJECT_ID", "proj-private")
    harness = OpenAIChatHarness("openrouter")
    harness.answer("ok")
    run(harness, ask())
    sent = harness.upstream.headers[0]
    assert "openai-organization" not in sent and "openai-project" not in sent
    assert sent["authorization"] == f"Bearer {CANARY}"


def test_a_nim_pending_reply_is_unsupported_not_polled() -> None:
    harness = OpenAIChatHarness("nvidia")
    harness.replies.append((202, {"NVCF-REQID": "r1"}, {"status": "pending"}))
    with pytest.raises(ProviderError) as raised:
        run(harness, ask())
    assert raised.value.code == errors.UNSUPPORTED_FEATURE and harness.upstream_requests == 1


def test_an_error_chunk_after_the_headers_is_mapped_by_its_code() -> None:
    harness = OpenAIChatHarness("openrouter")
    harness.stream(chunk({"content": "par"}), {"error": {"code": 502, "message": "upstream died"}})
    with pytest.raises(ProviderError) as raised:
        run(harness, ask())
    assert raised.value.code == errors.PROVIDER_UNAVAILABLE


@pytest.mark.parametrize(
    ("status", "body", "code"),
    [
        (402, {"error": {"code": 402, "message": "Insufficient credits"}}, errors.QUOTA_EXCEEDED),
        (429, {"error": {"code": "insufficient_quota", "message": "quota"}}, errors.QUOTA_EXCEEDED),
        (429, {"error": {"code": 429, "message": "slow down"}}, errors.RATE_LIMITED),
        (403, {"error": {"code": 403, "message": "Input flagged by moderation"}}, errors.UNSUPPORTED_FEATURE),
        (403, {"error": {"code": 403, "message": "Country not supported"}}, errors.AUTH_FAILED),
        (404, {"error": {"code": "model_not_found", "message": "no"}}, errors.MODEL_NOT_FOUND),
        (503, {"error": {"code": 503, "message": "busy"}}, errors.PROVIDER_UNAVAILABLE),
        (
            400,
            {"error": {"type": "invalid_request_error", "message": "prompt is too long"}},
            errors.CONTEXT_TOO_LONG,
        ),
    ],
)
def test_documented_errors_map_onto_the_taxonomy(status: int, body: dict[str, Any], code: str) -> None:
    assert classify(status, body) == code


def test_no_key_fails_before_any_request() -> None:
    harness = OpenAIChatHarness("deepseek", key=None)
    with pytest.raises(ProviderError) as raised:
        run(harness, ask())
    assert raised.value.code == errors.AUTH_FAILED and harness.upstream.paths == []


def test_a_custom_server_needs_no_key_and_its_kind_follows_its_address() -> None:
    harness = OpenAIChatHarness("custom", key=None)
    harness.answer("local reply")
    assert run(harness, ask())[0].text == "local reply"
    assert harness.provider.kind == "local"
    assert [endpoint_kind(u) for u in ("http://192.168.1.5:1234/v1", "http://gpu-box:8000/v1")] == [
        "remote"
    ] * 2
    assert endpoint_kind("https://llm.example.com/v1") == "cloud"


def test_a_key_is_never_sent_over_http_to_another_machine() -> None:
    harness = OpenAIChatHarness("custom", key=CANARY, base_url="http://192.168.1.5:1234/v1")
    with pytest.raises(ProviderError) as raised:
        run(harness, ask())
    assert raised.value.code == errors.UNSUPPORTED_FEATURE and harness.upstream.paths == []


def test_the_model_list_reads_tools_vision_context_and_price_and_is_cached() -> None:
    harness = OpenAIChatHarness("openrouter")
    models = {m.id: m for m in asyncio.run(harness.provider.list_models())}
    assert set(models) == {"m", "plain", "json-ok"}, "embedding models are not chat models"
    m = models["m"]
    assert (m.supports_tools, m.context_window, m.label) == ("yes", 131072, "Model M")
    assert {"tools", "vision"} <= m.capabilities and m.details["pricing"]["prompt"] == "0.000001"
    assert models["plain"].supports_tools == "no"
    caps = asyncio.run(harness.provider.model_caps("m"))
    unknown = asyncio.run(harness.provider.model_caps("not-listed"))
    assert caps.supports_tools == "yes" and unknown.supports_tools == "unknown"
    assert harness.upstream.paths.count("/api/v1/models") == 1, "model_caps used the cached list"


def test_tool_arguments_split_across_chunks_arrive_whole() -> None:
    harness = OpenAIChatHarness("openrouter")
    harness.tool_calls(("lookup", {"q": "a long query", "n": 2}))
    calls = [e.call for e in run(harness, ask()) if isinstance(e, ToolCallEvent)]
    assert [(c.id, c.args) for c in calls] == [("call_lookup_0", {"q": "a long query", "n": 2})]
    assert json.loads(json.dumps(calls[0].args)) == {"q": "a long query", "n": 2}


def test_degraded_mode_asks_for_json_only_where_the_model_declares_it() -> None:
    harness = OpenAIChatHarness("openrouter")
    asyncio.run(harness.provider.model_caps("plain"))  # fills the cached model list
    schema = {"type": "object"}
    for model in ("plain", "json-ok", "not-listed"):
        harness.answer("{}")
        run(harness, ChatRequest(model, (Message("user", "hi"),), json_schema=schema))
    sent = [body.get("response_format") for body in harness.upstream.bodies]
    assert sent == [None, {"type": "json_schema", "json_schema": {"name": "reply", "schema": schema}}, None]
