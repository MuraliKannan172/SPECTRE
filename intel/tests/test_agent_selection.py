"""A turn on the selected provider (ADR-002 D3, D6, D9): no quiet fallback,
the one-time tool probe and its cache, budgets, and provider_state that
survives to the next turn without reaching the browser."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest
from test_chat_agent import CLIENT_TOOLS, FakeFetcher, FakeSearch

from app.chat.agent import Agent, Turn, api_budgets
from app.chat.ollama import OllamaClient
from app.chat.probe import PROBE_NAME
from app.chat.providers import errors
from app.chat.providers.base import Done, ModelInfo, TextDelta, ToolCall, ToolCallEvent, Usage
from app.chat.providers.errors import ProviderError
from app.chat.providers.mock import MockProvider
from app.chat.tools import ToolRegistry
from app.config import FULL_BUDGETS, Settings
from app.store.chat import ChatStore
from app.store.news import NewsStore


class Cloud(MockProvider):
    id = "acme"
    kind = "cloud"
    base_url = "https://api.acme.test/v1"


def info(support: str = "unknown", window: int | None = None) -> ModelInfo:
    return ModelInfo(
        "big-1", "Big 1", "cloud", support, capabilities=frozenset({"completion"}), context_window=window
    )


def answer(text: str, state: dict[str, Any] | None = None) -> list[Any]:
    return [TextDelta(text), Usage(10, 4), Done("stop", provider_state=state)]


def probe_call() -> list[Any]:
    return [ToolCallEvent(ToolCall("p1", PROBE_NAME, {"ok": True})), Usage(5, 1), Done("tool_calls")]


class World:
    def __init__(self, tmp_path: Path, selected: MockProvider, *, known: str | None = None) -> None:
        self.settings = Settings(
            db_path=tmp_path / "t.db",
            feeds_default=tmp_path / "f.yaml",
            feeds_local=tmp_path / "l.yaml",
            env_file=tmp_path / ".env",
        )
        self.news = NewsStore(str(self.settings.db_path))
        self.chats = ChatStore(str(self.settings.db_path))
        self.remembered: list[tuple[str, str, str, str]] = []
        self.selected = selected
        self.agent = Agent(
            settings=self.settings,
            ollama=OllamaClient("http://unused.test", None),  # type: ignore[arg-type]
            news=self.news,
            chats=self.chats,
            search=FakeSearch([]),
            fetcher=FakeFetcher(),  # type: ignore[arg-type]
            registry=ToolRegistry(CLIENT_TOOLS),
            clock=lambda: 1_790_000_000.0,
            provider=MockProvider(),  # the default Ollama stand-in: must never be used here
            consented=lambda provider_id: True,
            providers=lambda provider_id: selected if provider_id == selected.id else None,
            known_tools=lambda *key: known,
            remember_tools=lambda *row: self.remembered.append(row),
        )
        self.conversation = self.chats.ensure_conversation(None)

    def turn(self, provider_id: str = "acme", model: str = "big-1") -> list[tuple[str, dict[str, Any]]]:
        turn = Turn(
            self.conversation,
            "What is on the map?",
            {"lat": 1},
            {},
            self.chats.history(self.conversation),
            provider_id=provider_id,
            model=model,
        )
        self.chats.add_message(self.conversation, "user", turn.message)

        async def collect() -> list[tuple[str, dict[str, Any]]]:
            return [event async for event in self.agent.run(turn)]

        return asyncio.run(collect())

    def close(self) -> None:
        self.chats.close()
        self.news.close()


@pytest.fixture
def world(tmp_path: Path):  # type: ignore[no-untyped-def]
    worlds: list[World] = []

    def make(selected: MockProvider, **kwargs: Any) -> World:
        worlds.append(World(tmp_path, selected, **kwargs))
        return worlds[-1]

    yield make
    for made in worlds:
        made.close()


def test_a_turn_runs_on_the_selected_provider_and_model(world) -> None:  # type: ignore[no-untyped-def]
    cloud = Cloud([answer("From Acme.")], models=[info("yes")])
    events = world(cloud).turn()
    assert events[0][1]["provider"] == "acme" and events[0][1]["model"] == "big-1"
    done = events[-1][1]
    assert (done["provider"], done["model"], done["usage"], done["stop_reason"]) == (
        "acme",
        "big-1",
        {"input": 10, "output": 4},
        "stop",
    )
    assert [r.model for r in cloud.requests] == ["big-1"] and cloud.requests[0].tools


def test_a_selection_that_cannot_run_is_an_error_never_a_switch(world) -> None:  # type: ignore[no-untyped-def]
    made = world(Cloud([answer("x")], models=[info("yes")]))
    events = made.turn(provider_id="gone")
    assert events[-1] == (
        "error",
        {
            "code": "unknown_provider",
            "message": "The selected provider is not available.",
            "provider": "gone",
            "retryable": False,
        },
    )
    assert made.agent.provider.opened == 0, "the default provider was not used instead"


def test_an_unknown_model_is_probed_once_and_a_tool_call_means_yes(world) -> None:  # type: ignore[no-untyped-def]
    cloud = Cloud([probe_call(), answer("Native.")], models=[info()])
    made = world(cloud)
    events = made.turn()
    assert made.remembered == [("acme", "https://api.acme.test/v1", "big-1", "yes")]
    assert cloud.requests[0].tools[0]["function"]["name"] == PROBE_NAME
    assert cloud.requests[1].tools and events[-1][1]["degraded"] is False


def test_a_rejected_tool_request_means_no_and_the_turn_runs_degraded(world) -> None:  # type: ignore[no-untyped-def]
    refused = ProviderError(errors.UNSUPPORTED_FEATURE, "tools not supported for this model")
    cloud = Cloud([[refused], answer('{"answer": "Plain."}')], models=[info()])
    made = world(cloud)
    events = made.turn()
    assert made.remembered == [("acme", "https://api.acme.test/v1", "big-1", "no")]
    assert not cloud.requests[1].tools and events[-1][1]["degraded"] is True


def test_a_text_reply_to_the_probe_proves_nothing_and_is_not_cached(world) -> None:  # type: ignore[no-untyped-def]
    cloud = Cloud([answer("I would rather not."), answer("Native anyway.")], models=[info()])
    made = world(cloud)
    events = made.turn()
    assert made.remembered == [] and cloud.requests[1].tools and events[-1][1]["degraded"] is False


def test_a_cached_result_skips_the_probe(world) -> None:  # type: ignore[no-untyped-def]
    cloud = Cloud([answer('{"answer": "Plain."}')], models=[info()])
    world(cloud, known="no").turn()
    assert len(cloud.requests) == 1 and not cloud.requests[0].tools


def test_a_probe_that_fails_on_the_key_is_the_turn_error(world) -> None:  # type: ignore[no-untyped-def]
    cloud = Cloud([[ProviderError(errors.AUTH_FAILED, "bad key", provider="acme")]], models=[info()])
    made = world(cloud)
    assert made.turn()[-1][1]["code"] == "auth_failed" and made.remembered == []


def test_api_budgets_never_exceed_the_16k_set_and_shrink_with_a_small_window() -> None:
    assert api_budgets(None) == FULL_BUDGETS == api_budgets(1_000_000)
    assert api_budgets(8192) == {name: tokens // 2 for name, tokens in FULL_BUDGETS.items()}


def test_the_final_answer_keeps_its_provider_state_for_the_next_turn_only(world) -> None:  # type: ignore[no-untyped-def]
    cloud = Cloud(
        [answer("First.", {"reasoning_content": "because"}), answer("Second.")], models=[info("yes")]
    )
    made = world(cloud)
    made.turn()
    made.turn()
    replayed = [m for m in cloud.requests[1].messages if m.role == "assistant"]
    assert [(m.content, m.provider_id, m.provider_state) for m in replayed] == [
        ("First.", "acme", {"reasoning_content": "because"})
    ]
    public = made.chats.messages(made.conversation)
    assert all("provider_state" not in row for row in public), "the history route never sends it"
