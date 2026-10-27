"""Thin async client for the local Ollama server (only the calls the Neural
Core needs). Connection failures surface as OllamaError("offline") so the
panel can show an honest offline state."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

import httpx

MAX_LINE_BYTES = 1024 * 1024


class OllamaError(RuntimeError):
    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code


class OllamaClient:
    def __init__(self, base_url: str, client: httpx.AsyncClient) -> None:
        self.base_url = base_url.rstrip("/")
        self._client = client

    async def _json(self, method: str, path: str, **kwargs: Any) -> Any:
        try:
            response = await self._client.request(method, f"{self.base_url}{path}", **kwargs)
        except httpx.ConnectError as error:
            raise OllamaError("offline") from error
        except httpx.TimeoutException as error:
            raise OllamaError("timeout") from error
        except httpx.HTTPError as error:
            raise OllamaError("unavailable", type(error).__name__) from error
        if response.status_code == 404:
            raise OllamaError("not_found", path)
        if response.status_code >= 400:
            raise OllamaError("http_status", str(response.status_code))
        try:
            return response.json()
        except ValueError as error:
            raise OllamaError("bad_response") from error

    async def version(self) -> str:
        return str((await self._json("GET", "/api/version", timeout=3)).get("version", ""))

    async def show(self, model: str) -> dict[str, Any]:
        return await self._json("POST", "/api/show", json={"model": model}, timeout=10)

    async def ps(self) -> list[dict[str, Any]]:
        return list((await self._json("GET", "/api/ps", timeout=3)).get("models", []))

    async def chat(self, payload: dict[str, Any]) -> AsyncIterator[dict[str, Any]]:
        """Stream /api/chat, one parsed NDJSON object per chunk."""
        body = {**payload, "stream": True}
        try:
            async with self._client.stream(
                "POST", f"{self.base_url}/api/chat", json=body, timeout=httpx.Timeout(300, connect=5)
            ) as response:
                if response.status_code == 404:
                    raise OllamaError("model_missing", str(payload.get("model")))
                if response.status_code >= 400:
                    detail = (await response.aread())[:300].decode("utf-8", "replace")
                    raise OllamaError("http_status", f"{response.status_code} {detail}")
                async for line in response.aiter_lines():
                    if not line.strip():
                        continue
                    if len(line) > MAX_LINE_BYTES:
                        raise OllamaError("bad_response", "oversized chunk")
                    try:
                        chunk = json.loads(line)
                    except ValueError as error:
                        raise OllamaError("bad_response") from error
                    if chunk.get("error"):
                        raise OllamaError("model_error", str(chunk["error"])[:300])
                    yield chunk
        except httpx.ConnectError as error:
            raise OllamaError("offline") from error
        except httpx.TimeoutException as error:
            raise OllamaError("timeout") from error
        except httpx.HTTPError as error:
            raise OllamaError("unavailable", type(error).__name__) from error
