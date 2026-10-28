"""The real local voice engines (opt-in: they need the voice install and a copy of the models).

Skipped unless SKYNET_VOICE_TEST_DIR names a directory laid out like the voice
directory (never intel/data itself), for example:

    $env:SKYNET_VOICE_TEST_DIR = "C:\\temp\\voice"   # a copy of intel\\data\\voice
    uv run --project intel pytest intel/tests/test_voice_engines.py
"""

from __future__ import annotations

import io
import os
import wave
from pathlib import Path

import numpy as np
import pytest

from app.voice.engine import (
    MAX_AUDIO_SECONDS,
    SAMPLE_RATE,
    KokoroSpeaker,
    VoiceError,
    WhisperTranscriber,
    wav_bytes,
)
from app.voice.models import missing_files, packages_installed

VOICE_DIR = (
    Path(os.environ.get("SKYNET_VOICE_TEST_DIR", "")) if os.environ.get("SKYNET_VOICE_TEST_DIR") else None
)
pytestmark = pytest.mark.skipif(
    VOICE_DIR is None or not packages_installed() or bool(missing_files(VOICE_DIR)),
    reason="set SKYNET_VOICE_TEST_DIR to a copy of the voice models, with the voice install",
)


@pytest.fixture(scope="module")
def transcriber() -> WhisperTranscriber:
    assert VOICE_DIR is not None
    return WhisperTranscriber(VOICE_DIR, threads=8)


@pytest.fixture(scope="module")
def speaker() -> KokoroSpeaker:
    assert VOICE_DIR is not None
    return KokoroSpeaker(VOICE_DIR, threads=8, voice="af_heart")


def quiet_wav(seconds: float) -> bytes:
    noise = np.random.default_rng(7).normal(0, 0.002, int(seconds * SAMPLE_RATE)).astype(np.float32)
    return wav_bytes(noise, SAMPLE_RATE)


def test_spoken_words_come_back_as_text(transcriber: WhisperTranscriber, speaker: KokoroSpeaker) -> None:
    audio = speaker.speak("Fly the camera to Nairobi and turn on the earthquakes layer.")
    with wave.open(io.BytesIO(audio)) as clip:
        assert clip.getnchannels() == 1 and clip.getsampwidth() == 2
        assert clip.getnframes() / clip.getframerate() > 2
    heard = transcriber.transcribe(audio)
    assert heard.language == "en"
    assert "nairobi" in heard.text.lower()
    assert "earthquake" in heard.text.lower()


def test_silence_and_hiss_are_not_questions(transcriber: WhisperTranscriber) -> None:
    with pytest.raises(VoiceError) as caught:
        transcriber.transcribe(quiet_wav(3))
    assert caught.value.code == "no_speech"


def test_garbage_and_overlong_audio_are_refused(transcriber: WhisperTranscriber) -> None:
    with pytest.raises(VoiceError) as caught:
        transcriber.transcribe(b"\x1a\x45\xdf\xa3 not really webm")
    assert caught.value.code == "bad_audio"
    with pytest.raises(VoiceError) as caught:
        transcriber.transcribe(quiet_wav(MAX_AUDIO_SECONDS + 1))
    assert caught.value.code == "too_long"


def test_only_english_voices_are_accepted() -> None:
    assert VOICE_DIR is not None
    with pytest.raises(ValueError, match="English"):
        KokoroSpeaker(VOICE_DIR, threads=2, voice="ef_dora")
