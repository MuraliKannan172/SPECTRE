"""/api/intel/chat routes: SSE turn, cross-origin refusal, history, status."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from helpers import FEEDS_YAML, make_settings
from test_chat_agent import CLIENT_TOOLS, FakeOllama, say

from app.chat.tools import ToolRegistry
from app.config import DEFAULT_MODEL
from app.main import create_app
from app.web.search import SearchService

HEADERS = {"content-type": "application/json", "host": "127.0.0.1"}


class StubParser:
    nlp = None
    model_name = "stub"
    gazetteer: tuple[()] = ()

    def locate(self, *args: Any, **kwargs: Any) -> None:
        return None


def client_for(tmp_path: Path, fake: FakeOllama) -> TestClient:
    settings = make_settings(tmp_path, FEEDS_YAML)
    app = create_app(
        settings,
        geoparser=StubParser(),  # type: ignore[arg-type]
        start_scheduler=False,
        ollama_transport=httpx.MockTransport(fake),
        search=SearchService(None, problem="not configured in tests"),
        tool_registry=ToolRegistry(CLIENT_TOOLS),
    )
    return TestClient(app, base_url="http://127.0.0.1")


def events_of(text: str) -> list[tuple[str, dict[str, Any]]]:
    out = []
    for block in text.strip().split("\n\n"):
        lines = dict(line.split(": ", 1) for line in block.splitlines() if ": " in line)
        out.append((lines["event"], json.loads(lines["data"])))
    return out


def test_a_turn_streams_and_history_persists(tmp_path: Path) -> None:
    with client_for(tmp_path, FakeOllama([say("Hello.")])) as client:
        response = client.post("/api/intel/chat", json={"message": "hi"}, headers=HEADERS)
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        assert [name for name, _ in events_of(response.text)] == ["turn", "token", "done"]
        history = client.get("/api/intel/chat/history").json()
        assert [m["role"] for m in history["messages"]] == ["user", "assistant"]
        assert client.delete("/api/intel/chat/history").status_code == 204
        assert client.get("/api/intel/chat/history").json()["messages"] == []


def test_regenerate_replaces_the_last_answer(tmp_path: Path) -> None:
    with client_for(tmp_path, FakeOllama([say("First."), say("Second.")])) as client:
        client.post("/api/intel/chat", json={"message": "hi"}, headers=HEADERS)
        response = client.post("/api/intel/chat", json={"regenerate": True}, headers=HEADERS)
        assert response.status_code == 200
        messages = client.get("/api/intel/chat/history").json()["messages"]
        assert [(m["role"], m["content"]) for m in messages] == [("user", "hi"), ("assistant", "Second.")]


def test_cross_site_and_non_json_requests_are_refused(tmp_path: Path) -> None:
    with client_for(tmp_path, FakeOllama([])) as client:
        evil = client.post(
            "/api/intel/chat", json={"message": "hi"}, headers={**HEADERS, "origin": "https://evil.example"}
        )
        assert evil.status_code == 403
        text = client.post(
            "/api/intel/chat",
            content='{"message":"hi"}',
            headers={"content-type": "text/plain", "host": "127.0.0.1"},
        )
        assert text.status_code in (415, 422)
        assert (
            client.delete("/api/intel/chat/history", headers={"sec-fetch-site": "cross-site"}).status_code
            == 403
        )
        assert client.post("/api/intel/chat", json={"message": "  "}, headers=HEADERS).status_code == 422
        too_big = {"message": "hi", "viewport": {"x": "y" * 9000}}
        assert client.post("/api/intel/chat", json=too_big, headers=HEADERS).status_code == 413


def test_tool_results_for_unknown_calls_are_rejected(tmp_path: Path) -> None:
    with client_for(tmp_path, FakeOllama([])) as client:
        body = {"turn_id": "a" * 32, "call_id": "b" * 12, "ok": True, "result": {}}
        assert client.post("/api/intel/chat/tool-result", json=body, headers=HEADERS).status_code == 404
        bad = {**body, "turn_id": "../../x"}
        assert client.post("/api/intel/chat/tool-result", json=bad, headers=HEADERS).status_code == 422


def test_status_reports_an_offline_ollama(tmp_path: Path) -> None:
    with client_for(tmp_path, FakeOllama([], offline=True)) as client:
        status = client.get("/api/intel/chat/status").json()
        assert status["ollama"] == {"reachable": False, "version": None, "error": "offline"}
        assert status["model"] == DEFAULT_MODEL
        assert status["search"]["configured"] is False


def test_status_reports_model_and_load_state(tmp_path: Path) -> None:
    fake = FakeOllama([])

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/version":
            return httpx.Response(200, json={"version": "0.40.11"})
        if request.url.path == "/api/ps":
            return httpx.Response(
                200,
                json={
                    "models": [{"name": DEFAULT_MODEL, "size_vram": 3_400_000_000, "context_length": 16384}]
                },
            )
        return fake(request)

    settings = make_settings(tmp_path, FEEDS_YAML)
    app = create_app(
        settings,
        geoparser=StubParser(),  # type: ignore[arg-type]
        start_scheduler=False,
        ollama_transport=httpx.MockTransport(handler),
        search=SearchService(None),
        tool_registry=ToolRegistry(CLIENT_TOOLS),
    )
    with TestClient(app, base_url="http://127.0.0.1") as client:
        status = client.get("/api/intel/chat/status").json()
    assert status["ollama"] == {"reachable": True, "version": "0.40.11"}
    assert status["tools"] is True and status["loaded"]["size_vram"] == 3_400_000_000


@pytest.mark.parametrize(
    ("body", "problem"),
    [
        ("providers: [unclosed\n", "unreadable (ProviderConfigError)"),
        ("providers: []\n", "has no ollama entry"),
    ],
)
def test_a_bad_provider_file_disables_chat_but_not_the_service(
    tmp_path: Path, body: str, problem: str
) -> None:
    providers_file = tmp_path / "providers.yaml"
    providers_file.write_text(body, encoding="utf-8")
    app = create_app(
        make_settings(tmp_path, FEEDS_YAML),
        geoparser=StubParser(),  # type: ignore[arg-type]
        start_scheduler=False,
        ollama_transport=httpx.MockTransport(FakeOllama([])),
        search=SearchService(None),
        tool_registry=ToolRegistry(CLIENT_TOOLS),
        providers_file=providers_file,
    )
    with TestClient(app, base_url="http://127.0.0.1") as client:
        assert client.get("/api/intel/health").status_code == 200
        status = client.get("/api/intel/chat/status").json()
        turn = client.post("/api/intel/chat", json={"message": "hi"}, headers=HEADERS)
    assert problem in status["chat_problem"]
    assert turn.status_code == 503 and turn.json()["detail"]["code"] == "chat_unavailable"


class StoppingAgent:
    """A turn that is stopped mid-stream and whose generator fails to close."""

    def __init__(self, gate) -> None:  # type: ignore[no-untyped-def]
        self.gate = gate
        self.turns = 0

    async def run(self, turn):  # type: ignore[no-untyped-def]
        self.turns += 1
        try:
            yield "turn", {"turn_id": turn.turn_id}
            self.gate.stop.set()  # as POST /chat/stop would
            yield "token", {"text": "partial"}
        finally:
            if self.turns == 1:
                raise RuntimeError("close failed")


def test_a_stopped_turn_frees_the_gate_even_if_closing_fails(tmp_path: Path) -> None:
    with client_for(tmp_path, FakeOllama([])) as client:
        state = client.app.state
        state.agent = StoppingAgent(state.chat_gate)
        first = client.post("/api/intel/chat", json={"message": "hi"}, headers=HEADERS)
        assert first.status_code == 200
        assert '"code": "stopped"' in first.text
        assert not state.chat_gate.busy()
        again = client.post("/api/intel/chat", json={"message": "hi again"}, headers=HEADERS)
        assert again.status_code == 200


def test_status_never_echoes_a_configured_key(tmp_path: Path) -> None:
    secret = "sk-test-0123456789abcdef"
    settings = make_settings(
        tmp_path, FEEDS_YAML, search_provider="brave", brave_api_key=secret, tavily_api_key=secret
    )
    app = create_app(
        settings,
        geoparser=StubParser(),  # type: ignore[arg-type]
        start_scheduler=False,
        ollama_transport=httpx.MockTransport(FakeOllama([], offline=True)),
        tool_registry=ToolRegistry(CLIENT_TOOLS),
    )
    with TestClient(app, base_url="http://127.0.0.1") as client:
        chat = client.get("/api/intel/chat/status", headers={"host": "127.0.0.1"})
        voice = client.get("/api/intel/voice/status", headers={"host": "127.0.0.1"})
        for response in (chat, voice):
            assert response.status_code == 200
            assert secret not in response.text
        assert chat.json()["search"]["provider"] == "brave"
