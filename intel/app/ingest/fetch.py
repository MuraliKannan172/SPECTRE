"""Conditional, size-capped HTTP fetches with machine-readable failures."""

from __future__ import annotations

import email.utils
import time
from dataclasses import dataclass

import httpx


@dataclass(frozen=True)
class FetchResult:
    status: int | None
    body: bytes | None  # None when not modified or failed
    etag: str | None = None
    last_modified: str | None = None
    error: str | None = None  # timeout, connect_error, http_503, too_large, ...
    retry_after: int | None = None

    @property
    def ok(self) -> bool:
        return self.error is None


def _retry_after(value: str | None) -> int | None:
    if not value:
        return None
    if value.strip().isdigit():
        return int(value.strip())
    try:
        when = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    return max(0, int(when.timestamp() - time.time()))


def _classify(error: httpx.HTTPError) -> str:
    if isinstance(error, httpx.TimeoutException):
        return "timeout"
    if isinstance(error, httpx.ProxyError):
        return "proxy_error"
    if isinstance(error, httpx.ConnectError):
        return "connect_error"
    if isinstance(error, httpx.TooManyRedirects):
        return "too_many_redirects"
    return "network_error"


async def fetch(
    client: httpx.AsyncClient,
    url: str,
    *,
    params: dict[str, str] | None = None,
    etag: str | None = None,
    last_modified: str | None = None,
    max_bytes: int = 5 * 1024 * 1024,
) -> FetchResult:
    headers = {"Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*;q=0.5"}
    if etag:
        headers["If-None-Match"] = etag
    if last_modified:
        headers["If-Modified-Since"] = last_modified
    try:
        async with client.stream("GET", url, params=params, headers=headers) as response:
            if response.status_code == 304:
                return FetchResult(304, None, etag, last_modified)
            if response.status_code >= 400:
                return FetchResult(
                    response.status_code,
                    None,
                    error=f"http_{response.status_code}",
                    retry_after=_retry_after(response.headers.get("retry-after")),
                )
            declared = response.headers.get("content-length")
            if declared and declared.isdigit() and int(declared) > max_bytes:
                return FetchResult(response.status_code, None, error="too_large")
            chunks, size = [], 0
            async for chunk in response.aiter_bytes():
                size += len(chunk)
                if size > max_bytes:
                    return FetchResult(response.status_code, None, error="too_large")
                chunks.append(chunk)
            return FetchResult(
                response.status_code,
                b"".join(chunks),
                response.headers.get("etag"),
                response.headers.get("last-modified"),
            )
    except httpx.HTTPError as error:
        return FetchResult(None, None, error=_classify(error))
