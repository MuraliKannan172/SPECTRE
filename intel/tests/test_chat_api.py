"""/api/intel/chat routes: SSE turn, cross-origin refusal, history, status."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
from fastapi.testclient import TestClient
from helpers import FEEDS_YAML, make_settings
from test_chat_agent import CLIENT_TOOLS, FakeOllama, say

from app.chat.tools import ToolRegistry
from app.main import create_app
from app.web.search import SearchService

HEADERS = {"content-type": "application/json", "host": "127.0.0.1"}


class StubParser:
    nlp = None

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
        assert status["model"] == "bonsai-2:9b"
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
                    "models": [{"name": "bonsai-2:9b", "size_vram": 3_400_000_000, "context_length": 16384}]
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
