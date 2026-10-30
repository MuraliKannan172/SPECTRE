"""scripts/verify_provider.py against fake servers: no network, no real keyring,
and the intel database only ever read through a copy."""

from __future__ import annotations

import asyncio
import importlib.util
from pathlib import Path
from typing import Any

import httpx
import pytest
from fakes_openai_chat import OpenAIChatHarness
from helpers import MemoryKeyring, make_settings
from sse import CANARY
from test_chat_agent import FakeOllama, call, say

from app.config import Settings
from app.store.providers import ProviderStore

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "verify_provider.py"
_spec = importlib.util.spec_from_file_location("verify_provider", SCRIPT)
assert _spec and _spec.loader
verify_provider: Any = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(verify_provider)

ADD = ("add_numbers", {"a": 17, "b": 25})


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return make_settings(tmp_path, "sources: []\n")


def run(
    settings: Settings,
    provider_id: str,
    model: str | None = None,
    *,
    environ: dict[str, str] | None = None,
    ollama: FakeOllama | None = None,
    api: OpenAIChatHarness | None = None,
) -> tuple[int, str]:
    lines: list[str] = []
    code = asyncio.run(
        verify_provider.verify(
            provider_id,
            model,
            settings=settings,
            environ=environ or {},
            backend=MemoryKeyring(),
            out=lines.append,
            ollama_http=httpx.AsyncClient(transport=httpx.MockTransport(ollama or FakeOllama([]))),
            sdk_http=(api or OpenAIChatHarness()).http,
        )
    )
    return code, "\n".join(lines)


def test_ollama_passes_a_listing_a_prompt_and_a_tool_round_trip(settings: Settings) -> None:
    fake = FakeOllama([say("ready"), call(*ADD), say("The sum is 42.")])
    fake.tags = [{"name": "m:1", "capabilities": ["completion", "tools"]}]
    code, out = run(settings, "ollama", "m:1", ollama=fake)
    assert code == 0, out
    assert out.startswith(f"No saved settings at {settings.db_path}; defaults used")
    for line in ("PASS 1 list models: 1 listed", "PASS 2 short prompt: 'ready'", "PASS 3 tool call"):
        assert line in out
    assert "PASS 3 tool result: 'The sum is 42.'" in out and out.endswith("RESULT PASS")
    replayed = fake.requests[2]["messages"]
    assert replayed[-1] == {"role": "tool", "content": '{"sum": 42}', "tool_name": "add_numbers"}


def test_a_model_that_answers_without_the_tool_fails_step_3(settings: Settings) -> None:
    fake = FakeOllama([say("ready"), say("17 + 25 = 42")])
    fake.tags = [{"name": "m:1"}]
    code, out = run(settings, "ollama", "m:1", ollama=fake)
    assert code == 1 and "FAIL 3 tool call: the model did not call add_numbers" in out
    assert out.endswith("RESULT FAIL")


def test_an_api_provider_uses_the_saved_key_and_never_prints_it(settings: Settings) -> None:
    api = OpenAIChatHarness()
    api.answer("ready")
    api.tool_calls(ADD)
    api.answer("The sum is ", "42.")
    code, out = run(settings, "openrouter", "m", environ={"OPENROUTER_API_KEY": CANARY}, api=api)
    assert code == 0, out
    assert "OpenRouter at https://openrouter.ai/api/v1 (cloud; key from environment)" in out
    assert "steps 2 and 3 spend a few tokens" in out and CANARY not in out
    assert all(headers["authorization"] == f"Bearer {CANARY}" for headers in api.upstream.headers)
    replay = api.upstream.bodies[-1]["messages"]
    assert replay[-1] == {"role": "tool", "tool_call_id": "call_add_numbers_0", "content": '{"sum": 42}'}


def test_a_rejected_key_fails_once_per_step_without_a_retry_or_the_key(settings: Settings) -> None:
    api = OpenAIChatHarness()
    api.fail_echoing_key(401)
    api.fail_echoing_key(401)
    code, out = run(settings, "openrouter", "m", environ={"OPENROUTER_API_KEY": CANARY}, api=api)
    assert code == 1
    assert "FAIL 2 short prompt: auth_failed" in out and "FAIL 3 tool call: auth_failed" in out
    assert len(api.upstream.bodies) == 2 and CANARY not in out


def test_without_a_key_nothing_is_sent(settings: Settings) -> None:
    api = OpenAIChatHarness()
    code, out = run(settings, "openrouter", "m", api=api)
    assert code == 2 and "No key for OpenRouter" in out and "OPENROUTER_API_KEY" in out
    assert api.upstream.paths == []


def test_an_api_provider_without_a_model_lists_and_stops(settings: Settings) -> None:
    api = OpenAIChatHarness()
    code, out = run(settings, "openrouter", environ={"OPENROUTER_API_KEY": CANARY}, api=api)
    assert code == 2 and "PASS 1 list models" in out and "--model <id>" in out
    assert api.upstream.bodies == [], "no prompt was sent"


def test_an_unknown_provider_cannot_run(settings: Settings) -> None:
    code, out = run(settings, "acme")
    assert code == 2 and "Unknown provider 'acme'" in out and "anthropic" in out


def test_local_only_mode_stops_a_cloud_check_and_the_database_is_only_read(settings: Settings) -> None:
    store = ProviderStore(str(settings.db_path))
    store.set_policy(local_only=True)
    store.close()
    before = settings.db_path.read_bytes()
    api = OpenAIChatHarness()
    code, out = run(settings, "openrouter", "m", environ={"OPENROUTER_API_KEY": CANARY}, api=api)
    assert code == 2 and "Local-only mode is on" in out
    assert out.startswith(f"Saved settings from {settings.db_path}")
    assert api.upstream.paths == [], "not even the model list"
    assert settings.db_path.read_bytes() == before
    # A read-only open of a WAL database leaves SQLite's index and an empty log, no data.
    wal = settings.db_path.with_name("intel.db-wal")
    assert not wal.exists() or wal.stat().st_size == 0
