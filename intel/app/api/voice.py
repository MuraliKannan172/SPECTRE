"""Neural Core local voice under /api/intel/voice (Phase 5, push-to-talk).

POST /transcribe takes one recorded question (audio, at most 2 MB and 60 s) and
returns its text; the panel then sends that text as an ordinary chat turn, so
every chat rule (the person-lookup refusal, rate limits) applies to it. POST
/speak turns one sentence of an answer into a WAV file. Audio is never stored
or logged. Like the chat routes, both refuse any request carrying an Origin or
a cross-site fetch marker: only the app's own proxy can reach them.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from ..voice.engine import VoiceError
from ..voice.service import VoiceService
from ..voice.text import speakable
from .chat import _json_body, _same_machine

router = APIRouter(prefix="/api/intel/voice")

MAX_UPLOAD_BYTES = 2 * 1024 * 1024
AUDIO_TYPES = frozenset({"audio/webm", "audio/ogg", "audio/wav", "audio/x-wav", "audio/wave", "audio/mp4"})


class SpeakRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str = Field(min_length=1, max_length=1000)


def _voice(request: Request) -> VoiceService:
    voice = getattr(request.app.state, "voice", None)
    if voice is None:
        raise HTTPException(503, {"code": "voice_unavailable", "reason": "not_started"})
    return voice


def _refuse(error: VoiceError, voice: VoiceService) -> HTTPException:
    return HTTPException(error.status, {"code": error.code, "reason": voice.reason, "error": voice.error})


async def _read_audio(request: Request) -> bytes:
    ctype = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if ctype not in AUDIO_TYPES:
        raise HTTPException(415, {"code": "audio_only"})
    try:
        declared = int(request.headers.get("content-length") or 0)
    except ValueError:
        declared = 0
    if declared > MAX_UPLOAD_BYTES:
        raise HTTPException(413, {"code": "too_large"})
    body = bytearray()
    async for chunk in request.stream():
        body += chunk
        if len(body) > MAX_UPLOAD_BYTES:
            raise HTTPException(413, {"code": "too_large"})
    if not body:
        raise HTTPException(422, {"code": "no_audio"})
    return bytes(body)


@router.get("/status")
async def status(request: Request) -> dict[str, Any]:
    return _voice(request).status()


@router.post("/transcribe")
async def transcribe(request: Request) -> dict[str, Any]:
    _same_machine(request)
    voice = _voice(request)
    audio = await _read_audio(request)
    try:
        transcript, seconds = await voice.transcribe(audio)
    except VoiceError as error:
        raise _refuse(error, voice) from None
    return {
        "text": transcript.text,
        "language": transcript.language,
        "language_probability": round(transcript.language_probability, 3),
        "audio_seconds": round(transcript.audio_seconds, 2),
        "speech_seconds": round(transcript.speech_seconds, 2),
        "seconds": round(seconds, 3),
    }


@router.post("/speak")
async def speak(body: SpeakRequest, request: Request) -> Response:
    _json_body(request)
    voice = _voice(request)
    text = speakable(body.text)
    if not text:
        raise HTTPException(422, {"code": "nothing_to_say"})
    try:
        audio, seconds = await voice.speak(text)
    except VoiceError as error:
        raise _refuse(error, voice) from None
    return Response(
        audio,
        media_type="audio/wav",
        headers={"Cache-Control": "no-store", "X-Voice-Seconds": f"{seconds:.3f}"},
    )
