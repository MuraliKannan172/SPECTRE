"""Fixes from the post-P5 code and security review: usage that a stopped turn
still counts, the probe's "no", LAN viewers and cloud models, clearing history,
reasoning state per model, the map switch on globe results, runaway replies."""

from __future__ import annotations

import asyncio
import time
from pathlib import Path
from typing import Any

import pytest
import test_agent_selection as selection
from fastapi.testclient import TestClient
from test_agent_selection import Cloud, answer, calls_viewport, info
from test_chat_agent import FakeOllama, say
from test_providers_api import HEADERS, SELECTION, STATUS, make_app, writer

from app.chat.agent import Turn, _parse_fallback, _without_view
from app.chat.context import message_chars
from app.chat.providers import errors
from app.chat.providers.base import Done, Message, TextDelta, Usage
from app.chat.providers.errors import ProviderError
from app.chat.providers.ollama import OllamaProvider
from app.redact import redact
from app.store.chat import ChatStore

world = selection.world  # the shared fixture


def test_a_stopped_turn_still_records_the_rounds_it_was_billed_for(world) -> None:  # type: ignore[no-untyped-def]
    cloud = Cloud(
        [calls_viewport(), [TextDelta("Part"), TextDelta("ial"), Usage(9, 2), Done("stop")]],
        models=[info("yes")],
    )
    made = world(cloud)
    turn = Turn(made.conversation, "hi", provider_id="acme", model="big-1")

    async def stop_at_the_first_token() -> None:
        events = made.agent.run(turn)
        async for name, _ in events:
            if name == "token":
                await events.aclose()  # what Stop and a closed tab do
                break

    asyncio.run(stop_at_the_first_token())
    totals = made.chats.usage_totals(made.conversation)
    assert (totals["input"], totals["output"]) == (7, 3), "round 1 was billed and counted"


def test_only_a_refusal_that_names_tools_is_cached_as_no(world) -> None:  # type: ignore[no-untyped-def]
    other = ProviderError(errors.UNSUPPORTED_FEATURE, "stream_options is not supported", provider="acme")
    made = world(Cloud([[other]], models=[info()]))
    assert made.turn()[-1][1]["code"] == "unsupported_feature" and made.remembered == []
    tools = ProviderError(errors.UNSUPPORTED_FEATURE, "This model does not support tools", provider="acme")
    made = world(Cloud([[tools], answer("Plain.")], models=[info()]))
    made.turn()
    assert made.remembered[0][3] == "no"


def test_a_lan_viewer_never_runs_a_cloud_model(world) -> None:  # type: ignore[no-untyped-def]
    cloud = Cloud([answer("Never.")], models=[info("yes")])
    made = world(cloud)
    turn = Turn(made.conversation, "hi", provider_id="acme", model="big-1", lan=True)

    async def run() -> list[tuple[str, dict[str, Any]]]:
        return [event async for event in made.agent.run(turn)]

    assert asyncio.run(run())[-1][1]["code"] == "lan_viewer"
    assert cloud.requests == [], "nothing reached the provider, not even a capability lookup"


def test_the_service_reads_the_proxys_lan_mark(tmp_path: Path) -> None:
    with TestClient(make_app(tmp_path), base_url="http://127.0.0.1") as client:
        headers = writer(client)
        client.put("/api/intel/providers/acme/consent", json={"granted": True}, headers=headers)
        client.put(SELECTION, json={"provider": "acme", "model": "big-1"}, headers=headers)
        lan = {**HEADERS, "x-spectre-viewer": "lan"}
        status = client.get(STATUS, headers={"x-spectre-viewer": "lan"}).json()
        turn = client.post("/api/intel/chat", json={"message": "hi"}, headers=lan)
        again = client.post("/api/intel/chat", json={"message": "hi"}, headers=lan)
    assert (status["ready"], status["problem"]) == (False, "lan_viewer")
    assert '"code": "lan_viewer"' in turn.text
    assert again.status_code == 200, "the refused turn released the gate"


def test_a_turn_that_fails_before_streaming_releases_the_gate(tmp_path: Path) -> None:
    with TestClient(make_app(tmp_path, FakeOllama([say("Hi.")])), base_url="http://127.0.0.1") as client:
        nothing = client.post("/api/intel/chat", json={"message": "", "regenerate": True}, headers=HEADERS)
        after = client.post("/api/intel/chat", json={"message": "hi"}, headers=HEADERS)
    assert nothing.status_code == 422 and after.status_code == 200


def test_clearing_history_clears_what_it_counted(tmp_path: Path) -> None:
    chats = ChatStore(str(tmp_path / "t.db"))
    first = chats.ensure_conversation(None)
    chats.record_usage(first, provider_id="acme", model="m", kind="cloud", tokens_in=90_000, tokens_out=10)
    chats.clear()
    reused = chats.ensure_conversation(None)
    assert reused == first, "SQLite hands the same id out again"
    assert chats.usage_totals(reused) == {"input": 0, "output": 0, "cloud": 0}
    chats.close()


def test_reasoning_state_goes_back_only_to_the_model_that_wrote_it(world) -> None:  # type: ignore[no-untyped-def]
    cloud = Cloud(
        [answer("First.", {"reasoning_content": "because"}), answer("Second.")],
        models=[info("yes"), selection.ModelInfo("big-2", "Big 2", "cloud", "yes")],
    )
    made = world(cloud)
    made.turn()
    made.turn(model="big-2")
    replayed = [m for m in cloud.requests[1].messages if m.role == "assistant"]
    assert [(m.content, m.provider_state) for m in replayed] == [("First.", None)]


def test_replayed_reasoning_counts_toward_the_context_estimate() -> None:
    plain = Message("assistant", "Hi.")
    assert (
        message_chars(Message("assistant", "Hi.", provider_state={"r": "x" * 100}))
        > message_chars(plain) + 100
    )


def test_with_the_map_switch_off_globe_results_lose_the_camera() -> None:
    result = {"ok": True, "observer": {"latitude": 1}, "passes": [{"cameraPosition": {}, "t": 5}]}
    assert _without_view(result) == {"ok": True, "passes": [{"t": 5}]}
    cctv = {"camera": {"id": "cam-7", "name": "Bridge"}}
    assert _without_view(cctv) == cctv, "a CCTV camera is data, not the view"


def test_a_runaway_reply_is_cut_off_and_marked(world) -> None:  # type: ignore[no-untyped-def]
    cloud = Cloud(
        [[TextDelta("x" * 70_000), TextDelta("never read"), Usage(1, 1), Done("stop")]], models=[info("yes")]
    )
    made = world(cloud)
    done = made.turn()[-1][1]
    assert done["stop_reason"] == "length"
    assert done["usage"]["output"] >= 70_000 // 4, "the cut round is counted, estimated"
    assert made.chats.usage_totals(made.conversation)["output"] == done["usage"]["output"]


def test_fallback_call_ids_differ_between_rounds() -> None:
    reply = '{"tool": "zoom_to_globe", "arguments": {}}'
    ids = [_parse_fallback(reply, n)[1][0].id for n in (1, 2)]
    assert ids[0] != ids[1]


@pytest.mark.parametrize("name", ["gpt-oss:120b-cloud", "beam:cloud"])
def test_a_cloud_tag_is_cloud_even_without_remote_host(name: str) -> None:
    provider = OllamaProvider.__new__(OllamaProvider)
    provider.kind = "local"
    assert provider._info(name, {}, None).kind == "cloud"
    assert provider._info("cloudy-model:7b", {}, None).kind == "local"


def test_a_new_base_url_gets_no_saved_key_and_needs_consent_again(
    tmp_path: Path, memory_keyring: Any
) -> None:
    with TestClient(make_app(tmp_path), base_url="http://127.0.0.1") as client:
        headers = writer(client)
        acme = "/api/intel/providers/acme"
        client.put(f"{acme}/key", json={"key": "sk-acme-0123456789"}, headers=headers)
        client.put(f"{acme}/consent", json={"granted": True}, headers=headers)
        assert client.app.state.providers.get("acme")._key() == "sk-acme-0123456789"
        moved = client.put(
            f"{acme}/settings", json={"base_url": "https://gateway.example.com/v1"}, headers=headers
        )
        assert (moved.json()["key_reaches_address"], moved.json()["consent"]) == (False, False)
        with pytest.raises(ProviderError) as withheld:
            client.app.state.providers.get("acme")._key()
        assert withheld.value.code == "key_not_sent", "a settings write alone redirects no key, and says so"
        client.put(SELECTION, json={"provider": "acme", "model": "big-1"}, headers=headers)
        assert client.get(STATUS).json()["problem"] == "key_not_sent"
        client.put(f"{acme}/key", json={"key": "sk-acme-0123456789"}, headers=headers)
        assert client.app.state.providers.get("acme")._key() == "sk-acme-0123456789", "saved again, for here"


def test_the_status_prices_only_the_current_models_tokens(tmp_path: Path) -> None:
    with TestClient(make_app(tmp_path), base_url="http://127.0.0.1") as client:
        client.put(SELECTION, json={"provider": "acme", "model": "big-1"}, headers=writer(client))
        chats = client.app.state.chats
        conversation = chats.current_conversation()
        chats.record_usage(
            conversation, provider_id="ollama", model="m", kind="local", tokens_in=900, tokens_out=50
        )
        chats.record_usage(
            conversation, provider_id="acme", model="big-1", kind="cloud", tokens_in=10, tokens_out=5
        )
        usage = client.get(STATUS).json()["usage"]
    assert (usage["input"], usage["output"], usage["priced"]) == (910, 55, {"input": 10, "output": 5})


def test_a_lan_viewer_gets_no_network_model_either(world) -> None:  # type: ignore[no-untyped-def]
    class Network(Cloud):
        kind = "remote"

    server = Network([answer("Never.")], models=[info("yes")])
    made = world(server)
    turn = Turn(made.conversation, "hi", provider_id="acme", model="big-1", lan=True)

    async def run() -> list[tuple[str, dict[str, Any]]]:
        return [event async for event in made.agent.run(turn)]

    assert asyncio.run(run())[-1][1]["code"] == "lan_viewer" and server.requests == []


@pytest.mark.parametrize("text", ["a" * 20_000, "sk-" * 7_000, "x" * 5_000 + "***", "nvapi-" * 3_000])
def test_redaction_stays_fast_on_long_lines(text: str) -> None:
    started = time.perf_counter()
    redact(text)
    assert time.perf_counter() - started < 0.25
