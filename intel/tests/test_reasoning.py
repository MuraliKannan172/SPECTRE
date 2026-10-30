"""The reasoning switch (ADR-002 D11): off unless asked for, the wire field
each provider takes, more output room, and thinking shown but never kept."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest
import test_chat_agent as chat_tests
from fakes_openai_chat import OpenAIChatHarness
from fakes_openai_responses import ResponsesHarness
from fastapi.testclient import TestClient
from test_chat_agent import FakeOllama, collect, turn_for
from test_providers_api import make_app, writer

from app.chat.agent import REASONING_MAX_OUTPUT
from app.chat.providers.base import ChatRequest, Message
from app.chat.providers.openai_responses import REASONING_EFFORT

make_agent = chat_tests.make_agent  # the shared fixture


def ollama_thinking(*thoughts: str, answer: str = "Answer.") -> list[dict[str, Any]]:
    chunks: list[dict[str, Any]] = [
        {"message": {"role": "assistant", "content": "", "thinking": text}, "done": False}
        for text in thoughts
    ]
    chunks.append({"message": {"role": "assistant", "content": answer}, "done": False})
    chunks.append({"message": {"role": "assistant", "content": ""}, "done": True, "eval_count": 3})
    return chunks


def test_ollama_thinks_only_when_asked_and_the_thinking_is_shown_not_kept(make_agent) -> None:  # type: ignore[no-untyped-def]
    fake = FakeOllama([ollama_thinking(), ollama_thinking("Weighing it.", "Done weighing.")])
    agent = make_agent(fake)
    collect(agent, turn_for(agent, "first"))
    assert fake.requests[0]["think"] is False, "OLLAMA_THINK's default, as before"
    agent.params_for = lambda provider_id: {"reasoning": True}
    events = collect(agent, turn_for(agent, "second"))
    assert fake.requests[1]["think"] is True
    assert [data["text"] for name, data in events if name == "thinking"] == ["Weighing it.", "Done weighing."]
    stored = agent.chats.messages(events[0][1]["conversation_id"])
    assert [m["content"] for m in stored if m["role"] == "assistant"] == ["Answer."]


def test_openrouter_reasoning_is_its_documented_switch_and_absent_by_default() -> None:
    harness = OpenAIChatHarness("openrouter")
    plain = harness.provider.payload(ChatRequest("m", (Message("user", "hi"),)))
    asked = harness.provider.payload(ChatRequest("m", (Message("user", "hi"),), params={"reasoning": True}))
    assert "extra_body" not in plain
    assert asked["extra_body"] == {"reasoning": {"enabled": True}}


def test_openai_reasoning_uses_one_effort_and_leaves_the_learned_one_alone() -> None:
    harness = ResponsesHarness()
    harness.answer("ok")
    harness.answer("ok")

    async def go(params: dict[str, Any]) -> None:
        async for _ in harness.provider.stream(ChatRequest("gpt-x", (Message("user", "hi"),), params=params)):
            pass

    asyncio.run(go({"reasoning": True}))
    assert harness.upstream.bodies[-1]["reasoning"] == {"effort": REASONING_EFFORT}
    assert "gpt-x" not in harness.provider._effort, "nothing learned from a turn the user asked to reason"
    asyncio.run(go({}))
    assert harness.upstream.bodies[-1]["reasoning"] == {"effort": "none"}, "the lowest, as before"


def test_reasoning_turns_get_more_output_room(make_agent) -> None:  # type: ignore[no-untyped-def]
    agent = make_agent(FakeOllama([]))
    agent.params_for = lambda provider_id: {"reasoning": True}
    plan = asyncio.run(agent._plan(turn_for(agent, "hi")))
    assert plan.input_limit == agent.settings.num_ctx - 4096, "thinking needs room in Ollama's window"
    request = agent._request([Message("user", "hi")], plan, native=True, allow_tools=True)
    assert request.params["max_output_tokens"] == REASONING_MAX_OUTPUT


@pytest.mark.parametrize(("provider", "status"), [("acme", 400), ("ollama", 200)])
def test_the_switch_is_offered_only_where_it_is_verified(tmp_path: Path, provider: str, status: int) -> None:
    with TestClient(make_app(tmp_path), base_url="http://127.0.0.1") as client:
        url = f"/api/intel/providers/{provider}/settings"
        saved = client.put(url, json={"params": {"reasoning": True}}, headers=writer(client))
    assert saved.status_code == status
    if status == 400:
        assert saved.json()["detail"]["params"] == ["reasoning"]


def test_the_thinking_reserve_never_empties_a_small_window(make_agent) -> None:  # type: ignore[no-untyped-def]
    agent = make_agent(FakeOllama([]))
    agent.params_for = lambda provider_id: {"reasoning": True, "num_ctx": 4096}
    plan = asyncio.run(agent._plan(turn_for(agent, "hi")))
    assert plan.input_limit == 2048


def test_openai_reasoning_falls_back_to_no_effort_field(monkeypatch: pytest.MonkeyPatch) -> None:
    from test_openai_responses import effort_rejected

    harness = ResponsesHarness()
    harness.replies.append(effort_rejected())
    harness.answer("ok")

    async def go() -> None:
        request = ChatRequest("plain-model", (Message("user", "hi"),), params={"reasoning": True})
        async for _ in harness.provider.stream(request):
            pass

    asyncio.run(go())
    assert "reasoning" not in harness.upstream.bodies[-1], "a model that takes no effort is still asked"
    assert "plain-model" not in harness.provider._effort
