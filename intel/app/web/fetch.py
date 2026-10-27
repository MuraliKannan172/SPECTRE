"""fetch_page: read one public web page as plain text for the Neural Core.

Every request goes through the SSRF guard (guard.py). Redirects are followed
here, at most MAX_REDIRECTS, and each hop is checked again. robots.txt is
honoured for the service's own User-Agent. Bodies are capped at MAX_BYTES and
only text content types are read; trafilatura extracts the main text. Nothing
fetched is stored: the text goes to the model, the URL to the tool log.
"""

from __future__ import annotations

import time
import urllib.robotparser
from dataclasses import dataclass
from urllib.parse import urljoin, urlsplit

import httpx
import trafilatura

from .guard import BlockedURL, check_url

MAX_REDIRECTS = 3
MAX_BYTES = 1024 * 1024
TIMEOUT_SECONDS = 10.0
ROBOTS_TTL_SECONDS = 3600
TEXT_TYPES = ("text/html", "application/xhtml+xml", "text/plain")


class FetchError(RuntimeError):
    """A page could not be read; `code` is safe to show the model."""

    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code


@dataclass(frozen=True)
class Page:
    url: str
    title: str | None
    text: str
    truncated: bool


async def _read_capped(response: httpx.Response, limit: int) -> bytes:
    body = bytearray()
    async for chunk in response.aiter_bytes():
        body.extend(chunk)
        if len(body) > limit:
            raise FetchError("too_large", f"over {limit} bytes")
    return bytes(body)


class PageFetcher:
    def __init__(self, client: httpx.AsyncClient, *, user_agent_token: str) -> None:
        self._client = client
        self._agent = user_agent_token
        self._robots: dict[str, tuple[float, urllib.robotparser.RobotFileParser | None]] = {}

    async def _get(self, url: str) -> httpx.Response:
        """One guarded request, following redirects by hand."""
        for _ in range(MAX_REDIRECTS + 1):
            check_url(url)
            request = self._client.build_request("GET", url)
            response = await self._client.send(request, stream=True)
            if response.is_redirect:
                location = response.headers.get("location", "")
                await response.aclose()
                if not location:
                    raise FetchError("bad_redirect")
                url = urljoin(url, location)
                continue
            return response
        raise FetchError("too_many_redirects", f"more than {MAX_REDIRECTS}")

    async def _allowed(self, url: str) -> bool:
        parts = urlsplit(url)
        origin = f"{parts.scheme.lower()}://{parts.netloc.lower()}"
        cached = self._robots.get(origin)
        now = time.monotonic()
        if cached is None or now - cached[0] > ROBOTS_TTL_SECONDS:
            parser: urllib.robotparser.RobotFileParser | None
            try:
                response = await self._get(f"{origin}/robots.txt")
                try:
                    if response.status_code >= 500:
                        parser = urllib.robotparser.RobotFileParser()
                        parser.disallow_all = True  # RFC 9309: unreachable means disallow
                    elif response.status_code >= 400:
                        parser = None  # no robots.txt: everything allowed
                    else:
                        text = (await _read_capped(response, 512 * 1024)).decode("utf-8", "replace")
                        parser = urllib.robotparser.RobotFileParser()
                        parser.parse(text.splitlines())
                finally:
                    await response.aclose()
            except BlockedURL:
                raise
            except (httpx.HTTPError, FetchError):
                parser = urllib.robotparser.RobotFileParser()
                parser.disallow_all = True
            cached = (now, parser)
            self._robots[origin] = cached
        parser = cached[1]
        return parser is None or parser.can_fetch(self._agent, url)

    async def fetch(self, url: str, *, max_chars: int) -> Page:
        """Fetch and extract one page. Raises BlockedURL or FetchError."""
        check_url(url)
        try:
            if not await self._allowed(url):
                raise FetchError("robots_disallowed")
            response = await self._get(url)
        except httpx.TimeoutException as error:
            raise FetchError("timeout") from error
        except httpx.HTTPError as error:
            cause = error.__cause__ or error.__context__
            if isinstance(cause, BlockedURL):
                raise cause from error
            raise FetchError("network", type(error).__name__) from error
        try:
            if response.status_code >= 400:
                raise FetchError("http_status", str(response.status_code))
            ctype = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
            if ctype not in TEXT_TYPES:
                raise FetchError("not_text", ctype or "unknown")
            body = await _read_capped(response, MAX_BYTES)
            final_url = str(response.url)
        finally:
            await response.aclose()
        html = body.decode(response.encoding or "utf-8", "replace")
        title: str | None = None
        if ctype == "text/plain":
            text = html
        else:
            extracted = trafilatura.bare_extraction(
                html, url=final_url, include_comments=False, include_tables=False, favor_precision=True
            )
            data = extracted.as_dict() if hasattr(extracted, "as_dict") else (extracted or {})
            text = (data.get("text") or "").strip()
            title = data.get("title") or None
        if not text:
            raise FetchError("no_text")
        truncated = len(text) > max_chars
        return Page(url=final_url, title=title, text=text[:max_chars], truncated=truncated)
