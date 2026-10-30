"""Fake upstream servers for the SDK adapters: SSE frames streamed through
`httpx2.MockTransport`, with a record of what each server saw."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Callable
from typing import Any

import httpx2

from app.redact import install_log_redaction, register

CANARY = "sk-test-CANARY-0123456789abcdef"
register(CANARY)  # as the key store does for every key it hands out
install_log_redaction()  # as the service does at start-up


class Upstream:
    """What a fake server saw: request bodies and headers, and streams the
    client closed before reading them to the end."""

    def __init__(self) -> None:
        self.bodies: list[dict[str, Any]] = []
        self.headers: list[httpx2.Headers] = []
        self.paths: list[str] = []
        self.closed_early = 0


class SSEStream(httpx2.AsyncByteStream):
    def __init__(self, frames: list[bytes], upstream: Upstream) -> None:
        self.frames = frames
        self.upstream = upstream
        self.done = False

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for frame in self.frames:
            yield frame
            await asyncio.sleep(0)
        self.done = True

    async def aclose(self) -> None:
        if not self.done:
            self.upstream.closed_early += 1


def data_frames(*payloads: dict[str, Any] | str, done: bool = True) -> list[bytes]:
    """OpenAI-style SSE: `data:` lines, then `[DONE]`. A str is sent verbatim."""
    frames = [(p if isinstance(p, str) else f"data: {json.dumps(p)}\n\n").encode() for p in payloads]
    return [*frames, b"data: [DONE]\n\n"] if done else frames


def event_frames(*events: dict[str, Any]) -> list[bytes]:
    """Anthropic- and Responses-style SSE: every frame names its event."""
    return [f"event: {e['type']}\ndata: {json.dumps(e)}\n\n".encode() for e in events]


Reply = tuple[int, dict[str, str], Any]  # status, headers, frames (list[bytes]) or a JSON body


def fake_server(
    upstream: Upstream, replies: list[Reply], models: Callable[[], dict[str, Any]]
) -> httpx2.AsyncClient:
    """A client whose transport answers GET …/models and plays `replies` in
    order for every POST."""

    def handle(request: httpx2.Request) -> httpx2.Response:
        upstream.paths.append(request.url.path)
        upstream.headers.append(request.headers)
        if request.method == "GET" and request.url.path.endswith("/models"):
            return httpx2.Response(200, json=models())
        upstream.bodies.append(json.loads(request.content or b"{}"))
        status, headers, payload = replies.pop(0)
        if isinstance(payload, list):
            return httpx2.Response(
                status,
                headers={"content-type": "text/event-stream", **headers},
                stream=SSEStream(payload, upstream),
            )
        return httpx2.Response(status, headers=headers, json=payload)

    return httpx2.AsyncClient(transport=httpx2.MockTransport(handle))
