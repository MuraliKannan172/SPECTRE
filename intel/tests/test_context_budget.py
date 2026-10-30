"""The context budget (ADR-002 D9): trimming and the usage-corrected estimate."""

from __future__ import annotations

from typing import Any

import test_chat_agent as chat_tests
from test_chat_agent import FakeOllama, call, collect, say, turn_for

from app.chat.context import (
    CHARS_PER_TOKEN,
    MIN_CHARS_PER_TOKEN,
    TRIMMED,
    chars_per_token,
    fit,
    message_chars,
)
from app.chat.providers.base import Message, ToolCall
from app.config import Settings

make_agent = chat_tests.make_agent  # the shared fixture


def tool_round(n: int, size: int) -> list[Message]:
    calls = (ToolCall(f"c{n}", "web_search", {"query": f"q{n}"}),)
    return [
        Message("assistant", "", tool_calls=calls, provider_id="deepseek", provider_state={"r": n}),
        Message("tool", "x" * size, tool_call_id=f"c{n}", name="web_search"),
    ]


def conversation(history: int, rounds: int, size: int = 1000) -> list[Message]:
    past = [Message("user" if i % 2 == 0 else "assistant", f"h{i} " + "y" * 500) for i in range(history)]
    turn = [message for n in range(rounds) for message in tool_round(n, size)]
    return [Message("system", "rules"), *past, Message("user", "the question"), *turn]


def total(messages: list[Message]) -> int:
    return sum(message_chars(message) for message in messages)


def test_a_request_under_the_limit_is_sent_as_it_is() -> None:
    messages = conversation(history=4, rounds=2)
    assert fit(messages, total(messages)) is messages


def test_the_oldest_tool_results_shrink_first_and_every_call_keeps_its_result() -> None:
    messages = conversation(history=4, rounds=3)
    trimmed = fit(messages, total(messages) - 1500)
    results = [m for m in trimmed if m.role == "tool"]
    assert [m.content for m in results] == [TRIMMED, TRIMMED, "x" * 1000]
    assert trimmed[:6] == messages[:6], "the system prompt, history and question stay"
    calls = [m for m in trimmed if m.tool_calls]
    assert [c.provider_state for c in calls] == [{"r": 0}, {"r": 1}, {"r": 2}]
    assert {m.tool_call_id for m in results} == {c.tool_calls[0].id for c in calls}


def test_then_the_oldest_history_goes_and_history_starts_with_a_question() -> None:
    messages = conversation(history=4, rounds=2)
    limit = total(messages) - 1000 - 600  # one result stubbed is not enough
    trimmed = fit(messages, limit)
    assert trimmed[0] == messages[0] and trimmed[1].role == "user"
    assert [m.content[:3] for m in trimmed[1:3]] == ["h2 ", "h3 "], "the oldest pair went"
    assert total(trimmed) <= limit
    assert trimmed[-1].content == "x" * 1000, "the latest round's results stay"


def test_a_request_that_cannot_fit_keeps_the_system_prompt_question_and_latest_results() -> None:
    messages = conversation(history=4, rounds=2)
    trimmed = fit(messages, 10)
    assert [m.role for m in trimmed] == ["system", "user", "assistant", "tool", "assistant", "tool"]
    assert trimmed[1].content == "the question"
    assert [m.content for m in trimmed if m.role == "tool"] == [TRIMMED, "x" * 1000]


def test_the_fixed_part_counts_toward_the_limit() -> None:
    messages = conversation(history=0, rounds=2)
    assert fit(messages, total(messages), fixed=0) is messages
    assert fit(messages, total(messages), fixed=500) is not messages


def test_reported_usage_only_ever_tightens_the_estimate() -> None:
    assert chars_per_token(8000, 4000) == 2.0
    assert chars_per_token(8000, 100) == CHARS_PER_TOKEN, "a cached prompt reads as cheap"
    assert chars_per_token(8000, 100_000) == MIN_CHARS_PER_TOKEN
    assert chars_per_token(8000, 0) is None


# -- the agent -------------------------------------------------------------------------


def reported(prompt_tokens: int) -> list[dict[str, Any]]:
    chunks = say("Answer.")
    chunks[-1]["prompt_eval_count"] = prompt_tokens
    return chunks


def history(count: int, size: int) -> list[dict[str, Any]]:
    return [
        {"role": "user" if i % 2 == 0 else "assistant", "content": f"m{i} " + "z" * size}
        for i in range(count)
    ]


def sent_history(fake: FakeOllama, request: int) -> list[str]:
    messages = fake.requests[request]["messages"]
    return [m["content"][:3] for m in messages[1:-1]]


def test_a_denser_tokenizer_seen_in_usage_shrinks_the_next_turns_history(make_agent) -> None:  # type: ignore[no-untyped-def]
    # 16k context: 3000 history tokens, 12000 characters at 4 per token.
    # The second turn's prompt comes from Ollama's cache and reports few tokens.
    fake = FakeOllama([reported(10**6), reported(1), reported(900)])
    agent = make_agent(fake)
    past = history(6, 1800)
    collect(agent, turn_for(agent, "first"))
    collect(agent, turn_for(agent, "second", history=past))
    assert sent_history(fake, 1) == ["m4 ", "m5 "], "1.5 characters per token: 4500 characters"
    collect(agent, turn_for(agent, "third", history=past))
    assert sent_history(fake, 2) == ["m0 ", "m1 ", "m2 ", "m3 ", "m4 ", "m5 "], "back to 4"


def test_history_sent_to_a_model_starts_with_a_question(make_agent) -> None:  # type: ignore[no-untyped-def]
    fake = FakeOllama([say("Answer.")])
    agent = make_agent(fake)
    past = [
        {"role": "assistant", "content": "a0 left over from a longer exchange"},
        {"role": "user", "content": "u1 question"},
        {"role": "assistant", "content": "a2 answer"},
    ]
    collect(agent, turn_for(agent, "next", history=past))
    assert sent_history(fake, 0) == ["u1 ", "a2 "]


def test_an_overfull_round_trims_old_tool_results_before_ollama_cuts_the_prompt(
    make_agent,
    tmp_path,  # type: ignore[no-untyped-def]
) -> None:
    settings = Settings(
        db_path=tmp_path / "t.db",
        feeds_default=tmp_path / "f.yaml",
        feeds_local=tmp_path / "l.yaml",
        env_file=tmp_path / ".env",
        ollama_num_ctx=4096,  # 3072 input tokens after the answer's reserve
    )
    big = {"query": "x" * 4000}
    fake = FakeOllama([*(call("fly_to_location", big) for _ in range(3)), say("Done.")])
    agent = make_agent(fake, settings=settings)

    def browser(agent, event):  # type: ignore[no-untyped-def]
        name, data = event
        if name == "client_tool":
            agent.resolve_client_tool(data["turn_id"], data["call_id"], {"ok": True, "echo": "r" * 3000})

    events = collect(agent, turn_for(agent, "fly", history=history(4, 400)), on_event=browser)
    assert events[-1][0] == "done"
    last = fake.requests[-1]["messages"]
    results = [m["content"] for m in last if m["role"] == "tool"]
    assert results[:2] == [TRIMMED, TRIMMED] and results[2] != TRIMMED
    assert last[0]["role"] == "system" and last[1]["content"] == "fly", "history went before the question"
