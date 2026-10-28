"""The local voice engines' lifetime: loaded once in the background, one job at a time each.

Requests never wait for a load: until both engines are ready they get 503 with
the state, so the proxy's 15 s timeout is never the thing that answers.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable
from typing import Any, Protocol

from ..config import Settings
from .engine import KokoroSpeaker, Transcript, VoiceError, WhisperTranscriber, english_lang
from .models import unavailable_reason

log = logging.getLogger("skynet.intel.voice")


class Transcriber(Protocol):
    def transcribe(self, audio: bytes) -> Transcript: ...


class Speaker(Protocol):
    def speak(self, text: str) -> bytes: ...


class VoiceService:
    def __init__(
        self,
        settings: Settings,
        *,
        load_transcriber: Callable[[], Transcriber] | None = None,
        load_speaker: Callable[[], Speaker] | None = None,
        check: Callable[[], str | None] | None = None,
    ) -> None:
        """`check` replaces the install and model check (tests use it)."""
        self.settings = settings
        if check is None:
            self.reason = unavailable_reason(enabled=settings.voice_enabled, voice_dir=settings.voice_dir)
        else:
            self.reason = check()
        self.state = "unavailable" if self.reason else "idle"
        self.error: str | None = None
        self._load_transcriber = load_transcriber or (
            lambda: WhisperTranscriber(settings.voice_dir, settings.voice_threads)
        )
        self._load_speaker = load_speaker or (
            lambda: KokoroSpeaker(settings.voice_dir, settings.voice_threads, settings.tts_voice)
        )
        self._transcriber: Transcriber | None = None
        self._speaker: Speaker | None = None
        self._stt_lock = asyncio.Lock()
        self._tts_lock = asyncio.Lock()

    async def load(self) -> None:
        """Load both engines off the event loop; failures are reported, never raised."""
        if self.state != "idle":
            return
        self.state = "loading"
        started = time.perf_counter()
        try:
            self._transcriber, self._speaker = await asyncio.gather(
                asyncio.to_thread(self._load_transcriber), asyncio.to_thread(self._load_speaker)
            )
        except Exception as error:  # a broken install or model must not stop the service
            self.state = "failed"
            self.error = f"{type(error).__name__}: {error}"[:300]
            log.exception("local voice failed to load")
            return
        self.state = "ready"
        log.info("local voice ready in %.1fs", time.perf_counter() - started)

    def status(self) -> dict[str, Any]:
        return {
            "state": self.state,
            "reason": self.reason,
            "error": self.error,
            "stt": {"model": "whisper-base", "device": "cpu"},
            "tts": {
                "model": "kokoro-82m",
                "voice": self.settings.tts_voice,
                "lang": english_lang(self.settings.tts_voice),
            },
            "speaks": ["en"],
        }

    def _ready(self) -> None:
        if self.state != "ready":
            raise VoiceError(f"voice_{self.state}", 503)

    async def transcribe(self, audio: bytes) -> tuple[Transcript, float]:
        self._ready()
        assert self._transcriber is not None
        async with self._stt_lock:
            started = time.perf_counter()
            transcript = await asyncio.to_thread(self._transcriber.transcribe, audio)
            return transcript, time.perf_counter() - started

    async def speak(self, text: str) -> tuple[bytes, float]:
        self._ready()
        assert self._speaker is not None
        async with self._tts_lock:
            started = time.perf_counter()
            audio = await asyncio.to_thread(self._speaker.speak, text)
            return audio, time.perf_counter() - started
