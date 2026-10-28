"""/api/intel/voice routes with fake engines: states, guards, limits, refusals."""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from pathlib import Path

from fastapi.testclient import TestClient
from helpers import FEEDS_YAML, make_settings
from test_chat_api import StubParser

from app.api.voice import MAX_UPLOAD_BYTES
from app.main import create_app
from app.voice.engine import Transcript, VoiceError
from app.voice.service import VoiceService

HOST = {"host": "127.0.0.1"}
WEBM = {**HOST, "content-type": "audio/webm;codecs=opus"}
JSON = {**HOST, "content-type": "application/json"}


class FakeTranscriber:
    def __init__(self, text: str = "Fly to Nairobi.") -> None:
        self.text = text
        self.heard: list[bytes] = []

    def transcribe(self, audio: bytes) -> Transcript:
        self.heard.append(audio)
        if not self.text:
            raise VoiceError("no_speech")
        return Transcript(self.text, "en", 0.99, 2.0, 1.5)


class FakeSpeaker:
    def __init__(self) -> None:
        self.said: list[str] = []

    def speak(self, text: str) -> bytes:
        self.said.append(text)
        return b"RIFF-fake-wav"


def client_with(
    tmp_path: Path,
    *,
    transcriber: Callable[[], object] | None = None,
    speaker: Callable[[], object] | None = None,
    reason: str | None = None,
) -> TestClient:
    settings = make_settings(tmp_path, FEEDS_YAML)
    voice = VoiceService(
        settings,
        load_transcriber=transcriber or FakeTranscriber,  # type: ignore[arg-type]
        load_speaker=speaker or FakeSpeaker,  # type: ignore[arg-type]
        check=lambda: reason,
    )
    app = create_app(settings, geoparser=StubParser(), start_scheduler=False, voice=voice)  # type: ignore[arg-type]
    return TestClient(app, base_url="http://127.0.0.1")


def wait_for(client: TestClient, state: str) -> dict:
    deadline = time.monotonic() + 5
    while True:
        status = client.get("/api/intel/voice/status", headers=HOST).json()
        if status["state"] == state or time.monotonic() > deadline:
            return status
        time.sleep(0.02)


def test_a_question_is_transcribed_and_an_answer_spoken(tmp_path: Path) -> None:
    with client_with(tmp_path) as client:
        assert wait_for(client, "ready")["state"] == "ready"
        heard = client.post("/api/intel/voice/transcribe", content=b"opus-bytes", headers=WEBM)
        assert heard.status_code == 200
        assert heard.json()["text"] == "Fly to Nairobi."
        assert heard.json()["language"] == "en"
        spoken = client.post(
            "/api/intel/voice/speak", json={"text": "The camera is over Nairobi [1]."}, headers=JSON
        )
        assert spoken.status_code == 200
        assert spoken.headers["content-type"] == "audio/wav"
        assert float(spoken.headers["x-voice-seconds"]) >= 0
        assert spoken.content == b"RIFF-fake-wav"
        assert client.app.state.voice._speaker.said == ["The camera is over Nairobi."]


def test_until_the_engines_load_requests_are_refused_at_once(tmp_path: Path) -> None:
    release = threading.Event()

    def slow() -> FakeTranscriber:
        release.wait(5)
        return FakeTranscriber()

    try:
        with client_with(tmp_path, transcriber=slow) as client:
            assert wait_for(client, "loading")["state"] == "loading"
            started = time.monotonic()
            refused = client.post("/api/intel/voice/transcribe", content=b"x", headers=WEBM)
            assert refused.status_code == 503
            assert refused.json()["detail"]["code"] == "voice_loading"
            assert time.monotonic() - started < 1
            release.set()
            assert wait_for(client, "ready")["state"] == "ready"
    finally:
        release.set()


def test_a_failed_load_is_reported_and_the_service_keeps_running(tmp_path: Path) -> None:
    def broken() -> FakeSpeaker:
        raise RuntimeError("model file is corrupt")

    with client_with(tmp_path, speaker=broken) as client:
        status = wait_for(client, "failed")
        assert status["state"] == "failed"
        assert "corrupt" in status["error"]
        refused = client.post("/api/intel/voice/speak", json={"text": "hi"}, headers=JSON)
        assert refused.json()["detail"]["code"] == "voice_failed"
        assert client.get("/api/intel/chat/history", headers=HOST).status_code == 200


def test_unavailable_says_why(tmp_path: Path) -> None:
    with client_with(tmp_path, reason="models_missing") as client:
        status = client.get("/api/intel/voice/status", headers=HOST).json()
        assert (status["state"], status["reason"]) == ("unavailable", "models_missing")
        refused = client.post("/api/intel/voice/transcribe", content=b"x", headers=WEBM)
        assert refused.status_code == 503
        assert refused.json()["detail"] == {
            "code": "voice_unavailable",
            "reason": "models_missing",
            "error": None,
        }


def test_cross_site_wrong_type_empty_and_oversize_uploads_are_refused(tmp_path: Path) -> None:
    with client_with(tmp_path) as client:
        wait_for(client, "ready")
        url = "/api/intel/voice/transcribe"
        evil = client.post(url, content=b"x", headers={**WEBM, "origin": "https://evil.example"})
        assert evil.status_code == 403
        cross = client.post(url, content=b"x", headers={**WEBM, "sec-fetch-site": "cross-site"})
        assert cross.status_code == 403
        assert client.post(url, content=b"{}", headers=JSON).status_code == 415
        assert client.post(url, content=b"", headers=WEBM).json()["detail"]["code"] == "no_audio"
        big = client.post(url, content=b"x" * (MAX_UPLOAD_BYTES + 1), headers=WEBM)
        assert big.status_code == 413
        assert client.app.state.voice._transcriber.heard == []


def test_silence_is_not_a_question(tmp_path: Path) -> None:
    with client_with(tmp_path, transcriber=lambda: FakeTranscriber("")) as client:
        wait_for(client, "ready")
        quiet = client.post("/api/intel/voice/transcribe", content=b"hiss", headers=WEBM)
        assert quiet.status_code == 422
        assert quiet.json()["detail"]["code"] == "no_speech"


def test_speak_takes_bounded_json_with_something_to_say(tmp_path: Path) -> None:
    with client_with(tmp_path) as client:
        wait_for(client, "ready")
        url = "/api/intel/voice/speak"
        assert client.post(url, json={"text": "[1][2]"}, headers=JSON).json()["detail"]["code"] == (
            "nothing_to_say"
        )
        assert client.post(url, json={"text": "x" * 1001}, headers=JSON).status_code == 422
        plain = client.post(url, content=b'{"text":"hi"}', headers={**HOST, "content-type": "text/plain"})
        assert plain.status_code in (415, 422)
        evil = client.post(url, json={"text": "hi"}, headers={**JSON, "origin": "https://evil.example"})
        assert evil.status_code == 403
        assert client.app.state.voice._speaker.said == []
