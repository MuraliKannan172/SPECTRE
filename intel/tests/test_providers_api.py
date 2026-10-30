"""/api/intel/providers (ADR-002 D5, D6): keys stay write-only, writes need the
session token, local-only mode and consent hold, and a canary key appears in
no response, log line, SSE event, database file or log file."""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from helpers import FEEDS_YAML, make_settings
from test_chat_agent import CLIENT_TOOLS, FakeOllama, say
from test_chat_api import HEADERS, StubParser, events_of

from app.api.providers import parse_gpu
from app.chat.providers import errors
from app.chat.providers.base import ChatRequest, ModelInfo, StreamEvent
from app.chat.providers.errors import ProviderError
from app.chat.providers.registry import KeyGetter, ProviderSpec
from app.chat.tools import ToolRegistry
from app.config import DEFAULT_MODEL
from app.main import create_app
from app.web.search import SearchService

CANARY = "sk-test-CANARY-0123456789abcdef"
PROVIDERS_YAML = """
providers:
  - {id: ollama, label: Ollama, adapter: ollama, kind: local, base_url: 'http://127.0.0.1:11434'}
  - id: acme
    label: Acme AI
    adapter: echo
    kind: cloud
    base_url: https://api.acme.test/v1
    key_env: [ACME_API_KEY]
"""
log = logging.getLogger("spectre.test.echo")


class EchoProvider:
    """A cloud provider that, like real APIs, echoes the key it was sent in
    its errors, and logs it carelessly."""

    kind = "cloud"
    max_attempts = 1

    def __init__(self, spec: ProviderSpec, base_url: str, key: KeyGetter) -> None:
        self.id = spec.id
        self.base_url = base_url
        self._key = key
        self.calls: list[str] = []  # every call would reach the cloud API with the key

    def _refused(self) -> ProviderError:
        log.warning("sent key %s to %s", self._key(), self.base_url)
        return ProviderError(
            errors.AUTH_FAILED, f"Incorrect API key provided: {self._key()}", provider=self.id, status=401
        )

    async def list_models(self) -> list[ModelInfo]:
        self.calls.append("list_models")
        raise self._refused()

    async def model_caps(self, model: str) -> ModelInfo:
        self.calls.append("model_caps")
        return ModelInfo(model, model, "cloud", "yes", capabilities=frozenset({"completion", "tools"}))

    async def test(self) -> dict[str, Any]:
        self.calls.append("test")
        raise self._refused()

    async def stream(self, request: ChatRequest) -> AsyncIterator[StreamEvent]:
        self.calls.append("stream")
        raise self._refused()
        yield  # pragma: no cover - makes this an async generator


def make_app(tmp_path: Path, fake: FakeOllama | None = None, providers_yaml: str = PROVIDERS_YAML) -> Any:
    providers_file = tmp_path / "providers.yaml"
    providers_file.write_text(providers_yaml, encoding="utf-8")
    fake = fake or FakeOllama([])

    def ollama(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/version":
            return httpx.Response(200, json={"version": "0.40.13"})
        if request.url.path == "/api/ps":
            return httpx.Response(200, json={"models": []})
        return fake(request)

    return create_app(
        make_settings(tmp_path, FEEDS_YAML, logs_dir=tmp_path / "logs"),
        geoparser=StubParser(),  # type: ignore[arg-type]
        start_scheduler=False,
        ollama_transport=httpx.MockTransport(ollama),
        search=SearchService(None),
        tool_registry=ToolRegistry(CLIENT_TOOLS),
        providers_file=providers_file,
        environ={},
        provider_factories={"echo": EchoProvider},
    )


@pytest.fixture
def client(tmp_path: Path) -> TestClient:
    with TestClient(make_app(tmp_path), base_url="http://127.0.0.1") as client:
        yield client


def writer(client: TestClient) -> dict[str, str]:
    token = client.get("/api/intel/providers/session").json()["token"]
    return {**HEADERS, "x-spectre-session": token}


def test_the_list_shows_every_provider_without_any_key(client: TestClient) -> None:
    listed = client.get("/api/intel/providers").json()
    assert [p["id"] for p in listed["providers"]] == ["ollama", "acme"]
    ollama, acme = listed["providers"]
    assert (ollama["kind"], ollama["key"]["required"], ollama["base_url_editable"]) == ("local", False, False)
    assert acme["key"] == {
        "required": True,
        "configured": False,
        "source": None,
        "env": ["ACME_API_KEY"],
        "writable": True,
    }
    assert (acme["kind"], acme["consent"]) == ("cloud", False)
    assert listed["policy"] == {"local_only": False, "map_context": True, "session_budget": 100_000}
    assert listed["keyring"] is True


def test_writes_need_the_session_token_and_json(client: TestClient) -> None:
    url = "/api/intel/providers/acme/key"
    assert (
        client.put(url, json={"key": CANARY}, headers=HEADERS).json()["detail"]["code"] == "session_required"
    )
    wrong = {**HEADERS, "x-spectre-session": "guess"}
    assert client.put(url, json={"key": CANARY}, headers=wrong).status_code == 403
    assert client.delete(url, headers=wrong).status_code == 403
    text = {**writer(client), "content-type": "text/plain"}
    assert client.put(url, content=json.dumps({"key": CANARY}), headers=text).status_code in (415, 422)
    assert not client.get("/api/intel/providers").json()["providers"][1]["key"]["configured"]


def test_a_browser_request_is_refused_even_for_reading(client: TestClient) -> None:
    for headers in ({"origin": "http://127.0.0.1:4173"}, {"sec-fetch-site": "cross-site"}):
        assert client.get("/api/intel/providers", headers=headers).status_code == 403
        assert client.get("/api/intel/providers/session", headers=headers).status_code == 403


def test_a_key_is_saved_shown_as_configured_and_removed(client: TestClient, memory_keyring: Any) -> None:
    headers = writer(client)
    saved = client.put("/api/intel/providers/acme/key", json={"key": CANARY}, headers=headers)
    assert saved.status_code == 200 and saved.json()["source"] == "keyring"
    assert list(memory_keyring.values.values()) == [CANARY]
    removed = client.delete(
        "/api/intel/providers/acme/key", headers={"x-spectre-session": headers["x-spectre-session"]}
    )
    assert removed.json()["configured"] is False and memory_keyring.values == {}


@pytest.mark.parametrize(
    ("provider", "body", "status", "code"),
    [
        ("ollama", {"key": CANARY}, 400, "no_key"),
        ("acme", {"key": "short"}, 400, "bad_key"),
        ("nobody", {"key": CANARY}, 404, "unknown_provider"),
    ],
)
def test_bad_key_writes_are_refused(
    client: TestClient, provider: str, body: dict[str, Any], status: int, code: str
) -> None:
    response = client.put(f"/api/intel/providers/{provider}/key", json=body, headers=writer(client))
    assert response.status_code == status and response.json()["detail"]["code"] == code


@pytest.mark.parametrize(
    "body", [{"key": CANARY, "extra": 1}, {"key": CANARY + "x" * 2000}, {"key": [CANARY]}]
)
def test_a_rejected_body_is_not_echoed(client: TestClient, body: dict[str, Any]) -> None:
    response = client.put("/api/intel/providers/acme/key", json=body, headers=writer(client))
    assert response.status_code == 422 and CANARY not in response.text


@pytest.mark.parametrize(
    ("url", "status"),
    [
        ("http://api.example.com/v1", 400),
        ("https://user:pw@api.example.com/v1", 400),
        ("https://api.example.com/v1?key=1", 400),
        ("ftp://api.example.com", 400),
        ("https://gateway.example.com/v1/", 200),
        ("http://127.0.0.1:1234/v1", 200),
    ],
)
def test_a_base_url_must_be_https_or_on_this_machine(client: TestClient, url: str, status: int) -> None:
    response = client.put(
        "/api/intel/providers/acme/settings", json={"base_url": url}, headers=writer(client)
    )
    assert response.status_code == status
    if status == 200:
        assert response.json()["base_url"] == url.rstrip("/")
        assert client.app.state.providers.get("acme").base_url == url.rstrip("/")


def test_ollama_keeps_its_address_from_ollama_host(client: TestClient) -> None:
    response = client.put(
        "/api/intel/providers/ollama/settings",
        json={"base_url": "http://127.0.0.1:9"},
        headers=writer(client),
    )
    assert response.status_code == 409 and response.json()["detail"]["code"] == "set_in_environment"


def test_a_saved_base_url_survives_a_restart(tmp_path: Path) -> None:
    with TestClient(make_app(tmp_path), base_url="http://127.0.0.1") as client:
        body = {"base_url": "https://gateway.example.com/v1", "workspace_id": "ws_1"}
        assert (
            client.put("/api/intel/providers/acme/settings", json=body, headers=writer(client)).status_code
            == 200
        )
    with TestClient(make_app(tmp_path), base_url="http://127.0.0.1") as client:
        acme = client.get("/api/intel/providers").json()["providers"][1]
        assert (acme["base_url"], acme["workspace_id"]) == ("https://gateway.example.com/v1", "ws_1")
        assert client.app.state.providers.get("acme").base_url == "https://gateway.example.com/v1"


def test_consent_is_granted_and_revoked(client: TestClient) -> None:
    headers = writer(client)
    url = "/api/intel/providers/acme/consent"
    assert client.put(url, json={"granted": True}, headers=headers).json() == {"consent": True}
    assert client.get("/api/intel/providers").json()["providers"][1]["consent"] is True
    assert client.put(url, json={"granted": False}, headers=headers).json() == {"consent": False}


def test_local_only_blocks_testing_and_listing_cloud_providers(client: TestClient) -> None:
    headers = writer(client)
    assert client.put("/api/intel/providers/policy", json={"local_only": True}, headers=headers).json() == {
        "local_only": True,
        "map_context": True,
        "session_budget": 100_000,
    }
    tested = client.post("/api/intel/providers/acme/test", json={}, headers=headers)
    listed = client.get("/api/intel/providers/acme/models")
    assert tested.status_code == listed.status_code == 409
    assert tested.json()["detail"]["code"] == "local_only"
    assert client.post("/api/intel/providers/ollama/test", json={}, headers=headers).json() == {
        "ok": True,
        "version": "0.40.13",
    }


def test_local_only_makes_no_call_at_all_to_a_cloud_provider(client: TestClient) -> None:
    headers = writer(client)
    acme = client.app.state.providers.get("acme")
    client.app.state.agent.provider = acme
    client.put("/api/intel/providers/acme/consent", json={"granted": True}, headers=headers)
    client.put("/api/intel/providers/policy", json={"local_only": True}, headers=headers)

    status = client.get("/api/intel/chat/status")
    turn = client.post("/api/intel/chat", json={"message": "hi"}, headers=HEADERS)
    client.post("/api/intel/providers/acme/test", json={}, headers=headers)
    client.get("/api/intel/providers/acme/models")

    assert status.status_code == 200 and events_of(turn.text)[-1][1]["code"] == "local_only"
    assert acme.calls == []


def test_local_only_blocks_an_ollama_cloud_model_before_anything_is_sent(tmp_path: Path) -> None:
    fake = FakeOllama([say("Never sent.")])
    fake.tags = [{"name": DEFAULT_MODEL, "remote_host": "https://ollama.com"}]
    with TestClient(make_app(tmp_path, fake), base_url="http://127.0.0.1") as client:
        client.put("/api/intel/providers/policy", json={"local_only": True}, headers=writer(client))
        turn = client.post("/api/intel/chat", json={"message": "hi"}, headers=HEADERS)
    assert events_of(turn.text)[-1] == (
        "error",
        {
            "code": "local_only",
            "message": "Local-only mode is on, so cloud models are blocked.",
            "provider": "ollama",
            "retryable": False,
        },
    )
    assert fake.requests == []


def test_an_ollama_cloud_model_needs_consent_and_then_runs(tmp_path: Path) -> None:
    fake = FakeOllama([say("From ollama.com.")])
    fake.tags = [{"name": DEFAULT_MODEL, "remote_host": "https://ollama.com"}]
    with TestClient(make_app(tmp_path, fake), base_url="http://127.0.0.1") as client:
        waiting = client.get("/api/intel/chat/status").json()
        refused = client.post("/api/intel/chat", json={"message": "hi"}, headers=HEADERS)
        client.put("/api/intel/providers/ollama/consent", json={"granted": True}, headers=writer(client))
        allowed = client.post("/api/intel/chat", json={"message": "hi"}, headers=HEADERS)
        ready = client.get("/api/intel/chat/status").json()
    assert (waiting["kind"], waiting["problem"]) == ("cloud", "consent_required")
    assert events_of(refused.text)[-1][1]["code"] == "consent_required"
    assert ("token", {"text": "From ollama.com."}) in events_of(allowed.text)
    assert ready["ready"] is True and len(fake.requests) == 1


def test_a_canary_key_appears_in_no_artefact(
    tmp_path: Path, caplog: pytest.LogCaptureFixture, memory_keyring: Any
) -> None:
    seen: list[str] = []
    caplog.set_level(logging.DEBUG)
    with TestClient(make_app(tmp_path), base_url="http://127.0.0.1") as client:
        headers = writer(client)
        token_only = {"x-spectre-session": headers["x-spectre-session"]}

        def keep(response: httpx.Response) -> httpx.Response:
            seen.append(response.text)
            return response

        keep(client.put("/api/intel/providers/acme/key", json={"key": CANARY}, headers=headers))
        keep(client.put("/api/intel/providers/acme/consent", json={"granted": True}, headers=headers))
        keep(client.get("/api/intel/providers"))
        tested = keep(client.post("/api/intel/providers/acme/test", json={}, headers=headers))
        listed = keep(client.get("/api/intel/providers/acme/models"))
        keep(client.get("/api/intel/chat/status"))
        client.app.state.agent.provider = client.app.state.providers.get("acme")
        turn = keep(client.post("/api/intel/chat", json={"message": "hi"}, headers=HEADERS))
        keep(client.get("/api/intel/chat/history"))
        keep(client.put("/api/intel/providers/acme/key", json={"key": CANARY, "x": 1}, headers=headers))
        keep(client.delete("/api/intel/providers/acme/key", headers=token_only))

    assert memory_keyring.values == {}, "the key was stored, then removed"
    assert (tested.json()["ok"], tested.json()["code"]) == (False, "auth_failed")
    assert listed.status_code == 502 and listed.json()["detail"]["code"] == "auth_failed"
    assert events_of(turn.text)[-1][1]["code"] == "auth_failed"
    assert "Incorrect API key provided: [redacted]" in tested.text
    assert "sent key [redacted]" in caplog.text, "the careless log line ran"

    artefacts = {"responses": "\n".join(seen), "logs": caplog.text}
    for path in [*tmp_path.glob("intel.db*"), *(tmp_path / "logs").rglob("*"), tmp_path / ".env"]:
        if path.is_file():
            artefacts[path.name] = path.read_bytes().decode("utf-8", "replace")
    assert {"intel.db", "responses", "logs"} <= set(artefacts)
    leaked = [name for name, text in artefacts.items() if CANARY in text or CANARY[8:] in text]
    assert leaked == []


# -- selection (P3) -----------------------------------------------------------------

CUSTOM_YAML = PROVIDERS_YAML + (
    "  - {id: custom, label: Custom, adapter: echo, kind: local, base_url: 'http://127.0.0.1:1234/v1',"
    " key_env: [SPECTRE_CUSTOM_API_KEY], key_optional: true}\n"
)
SELECTION = "/api/intel/providers/selection"


def test_the_selection_is_a_gated_write_the_chat_body_cannot_change(client: TestClient) -> None:
    body = {"provider": "acme", "model": "big-1"}
    assert client.put(SELECTION, json=body, headers=HEADERS).status_code == 403
    chosen = client.put(SELECTION, json=body, headers=writer(client))
    assert chosen.status_code == 200 and chosen.json()["selection"] == body
    assert client.get("/api/intel/providers").json()["selection"] == body
    sneaky = client.post("/api/intel/chat", json={"message": "hi", "provider": "ollama"}, headers=HEADERS)
    assert sneaky.status_code == 422, "a LAN viewer can chat but not pick the provider"
    unknown = client.put(SELECTION, json={"provider": "nobody", "model": "m"}, headers=writer(client))
    spaced = client.put(SELECTION, json={"provider": "acme", "model": "two words"}, headers=writer(client))
    assert (unknown.status_code, spaced.status_code) == (404, 422)


def test_turns_run_on_the_selection_and_a_new_conversation_keeps_it(client: TestClient) -> None:
    headers = writer(client)
    acme = client.app.state.providers.get("acme")
    client.put(SELECTION, json={"provider": "acme", "model": "big-1"}, headers=headers)
    client.put("/api/intel/providers/acme/consent", json={"granted": True}, headers=headers)
    first = events_of(client.post("/api/intel/chat", json={"message": "hi"}, headers=HEADERS).text)
    assert first[0][1]["provider"] == "acme" and first[-1][1]["provider"] == "acme"
    assert client.delete("/api/intel/chat/history", headers=HEADERS).status_code == 204
    again = events_of(client.post("/api/intel/chat", json={"message": "hi"}, headers=HEADERS).text)
    assert again[0][1]["provider"] == "acme" and acme.calls.count("stream") == 2


def test_a_keyless_custom_server_may_use_http_on_the_network_but_never_with_a_key(tmp_path: Path) -> None:
    with TestClient(make_app(tmp_path, providers_yaml=CUSTOM_YAML), base_url="http://127.0.0.1") as client:
        headers = writer(client)
        lan = {"base_url": "http://192.168.1.5:1234/v1"}
        loopback = {"base_url": "http://127.0.0.1:1234/v1"}
        key = {"key": "lmstudio-key-1"}
        custom = "/api/intel/providers/custom"
        assert client.put(f"{custom}/settings", json=lan, headers=headers).status_code == 200
        refused = client.put(f"{custom}/key", json=key, headers=headers)
        assert refused.status_code == 409 and refused.json()["detail"]["code"] == "key_over_http"
        assert client.put("/api/intel/providers/acme/settings", json=lan, headers=headers).status_code == 400
        assert client.put(f"{custom}/settings", json=loopback, headers=headers).status_code == 200
        assert client.put(f"{custom}/key", json=key, headers=headers).status_code == 200
        assert client.put(f"{custom}/settings", json=lan, headers=headers).status_code == 400


def test_models_marked_for_chat_completions_are_saved(client: TestClient) -> None:
    body = {"chat_completions_models": ["older-1", "older-2"]}
    assert (
        client.put("/api/intel/providers/acme/settings", json=body, headers=writer(client)).status_code == 200
    )
    saved = client.app.state.provider_store.settings("acme")
    assert saved.chat_completions_models == ("older-1", "older-2")


# -- P4a: status, parameters, test tool calling, GPU, budget --------------------------

CLAUDE_YAML = PROVIDERS_YAML + (
    "  - {id: claude, label: Claude, adapter: anthropic, kind: cloud, base_url: 'https://api.anthropic.com',"
    " key_env: [ANTHROPIC_API_KEY]}\n"
)
STATUS = "/api/intel/chat/status"


def test_status_for_a_cloud_selection_uses_local_facts_only(client: TestClient) -> None:
    headers = writer(client)
    acme = client.app.state.providers.get("acme")
    default = client.get(STATUS).json()
    assert (default["provider"], default["kind"], default["ready"], default["problem"]) == (
        "ollama",
        "local",
        True,
        None,
    )
    client.put(SELECTION, json={"provider": "acme", "model": "big-1"}, headers=headers)
    seen = [client.get(STATUS).json()]
    client.put("/api/intel/providers/acme/key", json={"key": CANARY}, headers=headers)
    seen.append(client.get(STATUS).json())
    client.put("/api/intel/providers/acme/consent", json={"granted": True}, headers=headers)
    seen.append(client.get(STATUS).json())
    client.put("/api/intel/providers/policy", json={"local_only": True}, headers=headers)
    seen.append(client.get(STATUS).json())
    assert (seen[0]["provider"], seen[0]["model"], seen[0]["kind"]) == ("acme", "big-1", "cloud")
    assert [s["problem"] for s in seen] == ["no_key", "consent_required", None, "local_only"]
    assert [s["ready"] for s in seen] == [False, False, True, False]
    assert seen[2]["budget"] == {"spent": 0, "allowance": 100_000, "budget": 100_000}
    assert acme.calls == [], "the status poll never calls a cloud API"


def test_parameters_are_validated_per_provider_and_saved(tmp_path: Path) -> None:
    with TestClient(make_app(tmp_path, providers_yaml=CLAUDE_YAML), base_url="http://127.0.0.1") as client:
        headers = writer(client)

        def put(provider: str, params: dict[str, Any]) -> Any:
            return client.put(
                f"/api/intel/providers/{provider}/settings", json={"params": params}, headers=headers
            )

        chosen = {"temperature": 0.7, "max_output_tokens": 800, "price_in": 3, "price_out": 15}
        assert put("acme", chosen).status_code == 200
        assert client.app.state.provider_store.settings("acme").params == {
            "temperature": 0.7,
            "max_output_tokens": 800,
            "price_in": 3.0,
            "price_out": 15.0,
        }
        assert put("acme", {"num_ctx": 8192}).json()["detail"] == {
            "code": "unsupported_param",
            "params": ["num_ctx"],
        }
        assert put("claude", {"temperature": 0.5}).json()["detail"]["params"] == ["temperature"]
        assert put("acme", {"temperature": 3}).status_code == 422
        assert put("ollama", {"num_ctx": 32768, "keep_alive": "10m"}).status_code == 200
        assert put("ollama", {"keep_alive": "forever"}).status_code == 422
        assert put("ollama", {"num_ctx": 1024}).status_code == 422


def test_test_tool_calling_caches_its_answer_and_respects_local_only(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    headers = writer(client)
    url = "/api/intel/providers/acme/probe"

    async def calls_the_tool(provider: Any, model: str) -> str:
        return "yes"

    assert client.post(url, json={"model": "big-1"}, headers=HEADERS).status_code == 403
    assert (
        client.post("/api/intel/providers/ollama/probe", json={"model": "m"}, headers=headers).status_code
        == 400
    )
    failed = client.post(url, json={"model": "big-1"}, headers=headers).json()
    assert (failed["ok"], failed["code"]) == (False, "auth_failed"), "the echo provider refuses the key"
    monkeypatch.setattr("app.api.providers.probe_tools", calls_the_tool)
    assert client.post(url, json={"model": "big-1"}, headers=headers).json() == {
        "ok": True,
        "supports_tools": "yes",
    }
    store = client.app.state.provider_store
    assert store.known_tools("acme", "https://api.acme.test/v1", "big-1") == "yes"
    client.put("/api/intel/providers/policy", json={"local_only": True}, headers=headers)
    assert client.post(url, json={"model": "big-1"}, headers=headers).status_code == 409


def test_the_gpu_reading_is_parsed_and_served(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    assert parse_gpu("NVIDIA GeForce RTX 5060 Laptop GPU, 8151\n") == {
        "name": "NVIDIA GeForce RTX 5060 Laptop GPU",
        "memory_mb": 8151,
    }
    assert parse_gpu("") is None and parse_gpu("no comma here") is None and parse_gpu(", 8151") is None

    async def no_gpu() -> None:
        return None

    monkeypatch.setattr("app.api.providers.nvidia_gpu", no_gpu)
    assert client.get("/api/intel/providers/ollama/gpu").json() == {"gpu": None}
    assert client.get("/api/intel/providers/ollama/gpu", headers={"origin": "http://x"}).status_code == 403


def test_a_save_that_keeps_the_address_keeps_the_adapter(client: TestClient) -> None:
    headers = writer(client)
    url = "/api/intel/providers/acme/settings"
    before = client.app.state.providers.get("acme")
    client.put(
        url, json={"base_url": "https://api.acme.test/v1", "params": {"temperature": 0.5}}, headers=headers
    )
    assert client.app.state.providers.get("acme") is before, "same address: no rebuild, nothing learned lost"
    client.put(url, json={"base_url": "https://gateway.example.com/v1"}, headers=headers)
    assert client.app.state.providers.get("acme") is not before


def test_status_names_the_provider(client: TestClient) -> None:
    client.put(SELECTION, json={"provider": "acme", "model": "big-1"}, headers=writer(client))
    assert client.get(STATUS).json()["provider_label"] == "Acme AI"


def test_continue_allows_one_more_budget_and_is_a_gated_write(client: TestClient) -> None:
    url = "/api/intel/providers/budget/continue"
    assert client.post(url, json={}, headers=HEADERS).status_code == 403
    headers = writer(client)
    assert client.post(url, json={}, headers=headers).status_code == 409, "no conversation yet"
    client.put(SELECTION, json={"provider": "acme", "model": "big-1"}, headers=headers)
    assert client.post(url, json={}, headers=headers).json() == {"allowance": 200_000}
    assert client.get(STATUS).json()["budget"]["allowance"] == 200_000
