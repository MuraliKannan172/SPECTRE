"""Pull model (ADR-002 D11, stretch): Ollama's own progress as SSE, behind
the provider write gate, for a validated model name."""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from test_chat_agent import FakeOllama
from test_chat_api import events_of
from test_providers_api import HEADERS, make_app, writer

URL = "/api/intel/providers/ollama/pull"


class PullingOllama(FakeOllama):
    """Answers /api/pull with scripted NDJSON progress lines."""

    def __init__(self, lines: list[dict[str, object]], status: int = 200) -> None:
        super().__init__([])
        self.lines = lines
        self.status = status
        self.pulled: list[dict[str, object]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/pull":
            self.pulled.append(json.loads(request.content))
            body = "\n".join(json.dumps(line) for line in self.lines).encode()
            return httpx.Response(self.status, content=body)
        return super().__call__(request)


def test_progress_streams_until_done(tmp_path: Path) -> None:
    fake = PullingOllama(
        [
            {"status": "pulling manifest"},
            {"status": "pulling abc", "digest": "sha256:abc", "total": 100, "completed": 40},
            {"status": "pulling abc", "digest": "sha256:abc", "total": 100, "completed": 100},
            {"status": "success"},
        ]
    )
    with TestClient(make_app(tmp_path, fake), base_url="http://127.0.0.1") as client:
        reply = client.post(URL, json={"model": "smollm2:135m"}, headers=writer(client))
    events = events_of(reply.text)
    assert reply.headers["content-type"].startswith("text/event-stream")
    assert [data.get("completed") for name, data in events if name == "progress"] == [None, 40, 100, None]
    assert events[-1] == ("done", {"model": "smollm2:135m"})
    assert fake.pulled == [{"model": "smollm2:135m", "stream": True}]


def test_an_ollama_error_is_an_error_event(tmp_path: Path) -> None:
    fake = PullingOllama(
        [{"status": "pulling manifest"}, {"error": "pull model manifest: file does not exist"}]
    )
    with TestClient(make_app(tmp_path, fake), base_url="http://127.0.0.1") as client:
        reply = client.post(URL, json={"model": "nope:1b"}, headers=writer(client))
    name, data = events_of(reply.text)[-1]
    assert name == "error" and data["code"] == "model_error" and "does not exist" in data["message"]


def test_pulling_is_a_gated_write(tmp_path: Path) -> None:
    fake = PullingOllama([{"status": "success"}])
    with TestClient(make_app(tmp_path, fake), base_url="http://127.0.0.1") as client:
        assert client.post(URL, json={"model": "smollm2:135m"}, headers=HEADERS).status_code == 403
    assert fake.pulled == []


@pytest.mark.parametrize(
    "name", ["", "../etc", "a/../b", "http://evil/x", "-flag", "x" * 300, "model name", "m:tag:extra"]
)
def test_a_bad_model_name_is_refused(tmp_path: Path, name: str) -> None:
    fake = PullingOllama([{"status": "success"}])
    with TestClient(make_app(tmp_path, fake), base_url="http://127.0.0.1") as client:
        assert client.post(URL, json={"model": name}, headers=writer(client)).status_code == 422
    assert fake.pulled == []


@pytest.mark.parametrize("name", ["llama3.2", "qwen3:0.6b", "hf.co/user/repo:Q4_K_M", "library/gemma4:cloud"])
def test_registry_names_are_accepted(tmp_path: Path, name: str) -> None:
    fake = PullingOllama([{"status": "success"}])
    with TestClient(make_app(tmp_path, fake), base_url="http://127.0.0.1") as client:
        assert client.post(URL, json={"model": name}, headers=writer(client)).status_code == 200
