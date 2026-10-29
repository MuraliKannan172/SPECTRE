"""The agent loop against any provider (ADR-002 D3), using the scripted mock:
the loop's behaviour must not depend on Ollama."""

from __future__ import annotations

import asyncio
import shutil
from pathlib import Path
from typing import Any

import pytest
from test_chat_agent import CLIENT_TOOLS, FakeFetcher, FakeSearch

from app.chat.agent import MAX_TOOL_ROUNDS, Agent, Turn
from app.chat.ollama import OllamaClient
from app.chat.providers import errors
from app.chat.providers.base import Done, ModelInfo, TextDelta, ToolCall, ToolCallEvent, Usage
from app.chat.providers.errors import ProviderError
from app.chat.providers.mock import MockProvider
from app.chat.tools import ToolRegistry
from app.config import Settings
from app.store.chat import ChatStore
from app.store.db import MIGRATIONS_DIR, connect, migrate
from app.store.news import NewsStore

MODEL = ModelInfo("m:1", "m:1", "cloud", "yes", capabilities=frozenset({"completion", "tools"}))


def answer(text: str) -> list[Any]:
    return [TextDelta(text), Usage(10, 4, 0.5), Done("stop")]


def calls(*names: str) -> list[Any]:
    events = [ToolCallEvent(ToolCall(f"c{n}", name, {})) for n, name in enumerate(names)]
    return [*events, Usage(10, 2), Done("tool_calls", provider_state={"opaque": True})]


@pytest.fixture
def run_with(tmp_path: Path):  # type: ignore[no-untyped-def]
    stores: list[Any] = []

    def go(
        provider: MockProvider, *, close_after: int | None = None, history_of: int | None = None
    ) -> list[tuple[str, dict[str, Any]]]:
        settings = Settings(
            db_path=tmp_path / "t.db",
            feeds_default=tmp_path / "f.yaml",
            feeds_local=tmp_path / "l.yaml",
            env_file=tmp_path / ".env",
            ollama_model=MODEL.id,
        )
        news, chats = NewsStore(str(settings.db_path)), ChatStore(str(settings.db_path), tmp_path / "logs")
        stores.extend((news, chats))
        agent = Agent(
            settings=settings,
            ollama=OllamaClient("http://unused.test", None),  # type: ignore[arg-type]
            news=news,
            chats=chats,
            search=FakeSearch([]),
            fetcher=FakeFetcher(),  # type: ignore[arg-type]
            registry=ToolRegistry(CLIENT_TOOLS),
            clock=lambda: 1_790_000_000.0,
            provider=provider,
        )
        history = chats.messages(history_of) if history_of is not None else []
        turn = Turn(
            chats.ensure_conversation(history_of),
            "What is on the map?",
            viewport={"lat": 1},
            layer_state={},
            history=history,
        )

        async def collect() -> list[tuple[str, dict[str, Any]]]:
            events = []
            stream = agent.run(turn)
            async for event in stream:
                events.append(event)
                if close_after is not None and len(events) >= close_after:
                    await stream.aclose()
                    break
            return events

        return asyncio.run(collect())

    yield go
    for store in stores:
        store.close()


def test_a_parallel_tool_round_reaches_the_provider_as_one_step(run_with) -> None:  # type: ignore[no-untyped-def]
    provider = MockProvider([calls("viewport", "layer_state"), answer("Two things.")], models=[MODEL])
    events = run_with(provider)
    assert [name for name, _ in events][-1] == "done"
    follow_up = provider.requests[1].messages
    assistant, first, second = follow_up[-3:]
    assert [c.id for c in assistant.tool_calls] == ["c0", "c1"]
    assert assistant.provider_id == "mock" and assistant.provider_state == {"opaque": True}
    assert (first.role, first.tool_call_id, first.name) == ("tool", "c0", "viewport")
    assert (second.role, second.tool_call_id, second.name) == ("tool", "c1", "layer_state")
    done = events[-1][1]
    assert (done["eval_count"], done["prompt_eval_count"], done["tokens_per_s"]) == (4, 10, 8.0)


def test_the_last_round_keeps_the_tools_and_asks_for_an_answer(run_with) -> None:  # type: ignore[no-untyped-def]
    rounds = [calls("viewport") for _ in range(MAX_TOOL_ROUNDS)]
    provider = MockProvider([*rounds, answer("Enough.")], models=[MODEL])
    run_with(provider)
    assert [r.tool_choice for r in provider.requests] == ["auto"] * MAX_TOOL_ROUNDS + ["none"]
    assert all(r.tools for r in provider.requests), "tools stay defined for APIs that need them"


def test_a_retryable_error_before_any_text_is_retried(run_with) -> None:  # type: ignore[no-untyped-def]
    provider = MockProvider(
        [[ProviderError(errors.RATE_LIMITED, retry_after=0.0)], answer("Hello.")], models=[MODEL]
    )
    events = run_with(provider)
    assert ("token", {"text": "Hello."}) in events and provider.opened == 2


def test_an_auth_failure_is_reported_once_with_its_taxonomy_code(run_with) -> None:  # type: ignore[no-untyped-def]
    provider = MockProvider([[ProviderError(errors.AUTH_FAILED, "bad key", provider="mock")]], models=[MODEL])
    events = run_with(provider)
    assert events[-1] == ("error", {"code": "auth_failed", "message": "bad key"})
    assert provider.opened == 1


def test_a_conversation_from_before_migration_0003_loads_and_continues(  # type: ignore[no-untyped-def]
    tmp_path: Path, run_with
) -> None:
    old_migrations = tmp_path / "old-migrations"
    old_migrations.mkdir()
    for name in ("0001_init.sql", "0002_chat.sql"):
        shutil.copy(MIGRATIONS_DIR / name, old_migrations / name)
    conn = connect(tmp_path / "t.db")
    assert migrate(conn, old_migrations) == [1, 2]
    conn.execute("INSERT INTO conversations (id, created_at, updated_at) VALUES (7, 1, 1)")
    conn.executemany(
        "INSERT INTO messages (conversation_id, role, content, created_at) VALUES (7, ?, ?, 1)",
        [("user", "Earlier question"), ("assistant", "Earlier answer")],
    )
    conn.close()

    provider = MockProvider([answer("Continued.")], models=[MODEL])
    events = run_with(provider, history_of=7)

    assert [name for name, _ in events][-1] == "done"
    replayed = provider.requests[0].messages[1:3]
    assert [(m.role, m.content, m.provider_id) for m in replayed] == [
        ("user", "Earlier question", None),
        ("assistant", "Earlier answer", None),
    ]
    chats = ChatStore(str(tmp_path / "t.db"))
    try:
        latest = chats.messages(7)[-1]
    finally:
        chats.close()
    assert (latest["content"], latest["provider_id"], latest["model"]) == ("Continued.", "mock", MODEL.id)


def test_stopping_a_turn_closes_the_provider_stream(run_with) -> None:  # type: ignore[no-untyped-def]
    long = [TextDelta(f"t{n} ") for n in range(20)] + [Usage(1, 20), Done("stop")]
    provider = MockProvider([long], models=[MODEL])
    events = run_with(provider, close_after=3)  # turn, then two tokens
    assert [name for name, _ in events] == ["turn", "token", "token"]
    assert provider.closed_early == 1
