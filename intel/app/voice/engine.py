"""Speech to text (faster-whisper) and text to speech (Kokoro), on the CPU.

The voice packages are imported inside the loaders, never at module level, so
the service runs without them. Both engines run on the CPU by default: the GPU
is the language model's, and an 8 GB card has no room for both.
"""

from __future__ import annotations

import io
import wave
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .models import KOKORO_MODEL, KOKORO_VOICES, WHISPER_DIR

SAMPLE_RATE = 16_000
MAX_AUDIO_SECONDS = 60.0
# Whisper invents words ("Thank you.") for noise; less speech than this is a
# misfire, not a question.
MIN_SPEECH_SECONDS = 0.4


class VoiceError(Exception):
    """A failure the panel explains by its code."""

    def __init__(self, code: str, status: int = 422) -> None:
        super().__init__(code)
        self.code = code
        self.status = status


@dataclass(frozen=True)
class Transcript:
    text: str
    language: str
    language_probability: float
    audio_seconds: float
    speech_seconds: float


class WhisperTranscriber:
    """faster-whisper base, int8 on the CPU, loaded once from the pinned files."""

    def __init__(self, voice_dir: Path, threads: int) -> None:
        from faster_whisper import WhisperModel

        self.model = WhisperModel(
            str(voice_dir / WHISPER_DIR),
            device="cpu",
            compute_type="int8",
            cpu_threads=threads,
            local_files_only=True,
        )

    def transcribe(self, audio: bytes) -> Transcript:
        from faster_whisper.audio import decode_audio

        try:
            samples = decode_audio(io.BytesIO(audio), sampling_rate=SAMPLE_RATE)
        except Exception as error:  # PyAV raises its own error family for bad input
            raise VoiceError("bad_audio") from error
        seconds = len(samples) / SAMPLE_RATE
        if seconds > MAX_AUDIO_SECONDS:
            raise VoiceError("too_long")
        segments, info = self.model.transcribe(
            samples,
            beam_size=1,
            vad_filter=True,
            without_timestamps=True,
            condition_on_previous_text=False,
        )
        text = " ".join(segment.text.strip() for segment in segments).strip()
        speech = float(info.duration_after_vad)
        if not text or speech < MIN_SPEECH_SECONDS:
            raise VoiceError("no_speech")
        return Transcript(text, info.language, float(info.language_probability), seconds, speech)


def english_lang(voice: str) -> str | None:
    """Kokoro's English voices: American (a*) and British (b*). Others are not supported here."""
    return {"a": "en-us", "b": "en-gb"}.get(voice[:1]) if len(voice) > 3 and voice[2] == "_" else None


class KokoroSpeaker:
    """Kokoro-82M int8 through ONNX Runtime on the CPU, one English voice."""

    def __init__(self, voice_dir: Path, threads: int, voice: str) -> None:
        import onnxruntime as ort
        from kokoro_onnx import Kokoro

        self.lang = english_lang(voice)
        if self.lang is None:
            raise ValueError(f"SPECTRE_TTS_VOICE must be an English Kokoro voice (af_, bm_...), not {voice}")
        options = ort.SessionOptions()
        options.intra_op_num_threads = threads
        session = ort.InferenceSession(
            str(voice_dir / KOKORO_MODEL), options, providers=["CPUExecutionProvider"]
        )
        self.kokoro = Kokoro.from_session(session, str(voice_dir / KOKORO_VOICES))
        if voice not in self.kokoro.get_voices():
            raise ValueError(f"SPECTRE_TTS_VOICE is not in the voice pack: {voice}")
        self.voice = voice

    def speak(self, text: str) -> bytes:
        samples, rate = self.kokoro.create(text, voice=self.voice, speed=1.0, lang=self.lang)
        return wav_bytes(samples, rate)


def wav_bytes(samples: np.ndarray, rate: int) -> bytes:
    """Mono float samples in [-1, 1] as a 16-bit PCM WAV file."""
    pcm = (np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0) * 32767).astype("<i2")
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(int(rate))
        out.writeframes(pcm.tobytes())
    return buffer.getvalue()
