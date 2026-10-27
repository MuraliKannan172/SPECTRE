"""web_search providers (ADR-001 D5, "Web check").

* ddgs: keyless DuckDuckGo results through the `ddgs` package. Best effort:
  it is rate-limited and can stop working when the site changes; the status
  says so.
* searxng: the owner's SearXNG instance (SEARXNG_URL), recommended.
* brave / tavily: keyed APIs (BRAVE_API_KEY / TAVILY_API_KEY).

Provider calls go to fixed, configured endpoints (not model-chosen URLs), so
they use an ordinary client; only fetch_page needs the SSRF guard.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Any, Protocol

import httpx

RECENCIES = ("day", "week", "month", "any")
MAX_RESULTS = 8


@dataclass(frozen=True)
class SearchResult:
    title: str
    url: str
    snippet: str
    published: str | None = None


class SearchError(RuntimeError):
    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code


class SearchProvider(Protocol):
    name: str
    keyless: bool

    async def search(self, query: str, recency: str, limit: int) -> list[SearchResult]: ...


def _clean(results: list[SearchResult], limit: int) -> list[SearchResult]:
    seen: set[str] = set()
    kept: list[SearchResult] = []
    for result in results:
        if not result.url.startswith(("http://", "https://")) or result.url in seen:
            continue
        seen.add(result.url)
        kept.append(
            SearchResult(
                title=" ".join(result.title.split())[:200],
                url=result.url[:2000],
                snippet=" ".join(result.snippet.split())[:400],
                published=result.published,
            )
        )
        if len(kept) >= limit:
            break
    return kept


class DdgsProvider:
    name = "ddgs"
    keyless = True
    _TIMELIMIT = {"day": "d", "week": "w", "month": "m"}

    async def search(self, query: str, recency: str, limit: int) -> list[SearchResult]:
        from ddgs import DDGS  # imported lazily: it is heavy and optional at runtime

        def run() -> list[dict[str, Any]]:
            return list(
                DDGS(timeout=10).text(
                    query, timelimit=self._TIMELIMIT.get(recency), max_results=limit, backend="auto"
                )
            )

        try:
            rows = await asyncio.wait_for(asyncio.to_thread(run), timeout=20)
        except TimeoutError as error:
            raise SearchError("timeout") from error
        except Exception as error:  # ddgs raises its own exception types, rate limits included
            raise SearchError("provider_failed", type(error).__name__) from error
        return _clean(
            [
                SearchResult(row.get("title") or "", row.get("href") or "", row.get("body") or "")
                for row in rows
            ],
            limit,
        )


class SearxngProvider:
    name = "searxng"
    keyless = True

    def __init__(self, base_url: str, client: httpx.AsyncClient) -> None:
        self._base = base_url.rstrip("/")
        self._client = client

    async def search(self, query: str, recency: str, limit: int) -> list[SearchResult]:
        params = {"q": query, "format": "json"}
        if recency in ("day", "week", "month"):
            params["time_range"] = recency
        try:
            response = await self._client.get(f"{self._base}/search", params=params, timeout=15)
            response.raise_for_status()
            rows = response.json().get("results", [])
        except (httpx.HTTPError, ValueError) as error:
            raise SearchError("provider_failed", type(error).__name__) from error
        return _clean(
            [
                SearchResult(
                    row.get("title") or "",
                    row.get("url") or "",
                    row.get("content") or "",
                    row.get("publishedDate"),
                )
                for row in rows
                if isinstance(row, dict)
            ],
            limit,
        )


class BraveProvider:
    name = "brave"
    keyless = False
    _FRESHNESS = {"day": "pd", "week": "pw", "month": "pm"}

    def __init__(self, api_key: str, client: httpx.AsyncClient) -> None:
        self._key = api_key
        self._client = client

    async def search(self, query: str, recency: str, limit: int) -> list[SearchResult]:
        params: dict[str, Any] = {"q": query, "count": limit}
        if recency in self._FRESHNESS:
            params["freshness"] = self._FRESHNESS[recency]
        try:
            response = await self._client.get(
                "https://api.search.brave.com/res/v1/web/search",
                params=params,
                headers={"X-Subscription-Token": self._key, "Accept": "application/json"},
                timeout=15,
            )
            response.raise_for_status()
            rows = response.json().get("web", {}).get("results", [])
        except (httpx.HTTPError, ValueError) as error:
            raise SearchError("provider_failed", type(error).__name__) from error
        return _clean(
            [
                SearchResult(
                    row.get("title") or "", row.get("url") or "", row.get("description") or "", row.get("age")
                )
                for row in rows
                if isinstance(row, dict)
            ],
            limit,
        )


class TavilyProvider:
    name = "tavily"
    keyless = False
    _DAYS = {"day": 1, "week": 7, "month": 31}

    def __init__(self, api_key: str, client: httpx.AsyncClient) -> None:
        self._key = api_key
        self._client = client

    async def search(self, query: str, recency: str, limit: int) -> list[SearchResult]:
        body: dict[str, Any] = {"query": query, "max_results": limit}
        if recency in self._DAYS:
            body.update(topic="news", days=self._DAYS[recency])
        try:
            response = await self._client.post(
                "https://api.tavily.com/search",
                json=body,
                headers={"Authorization": f"Bearer {self._key}"},
                timeout=20,
            )
            response.raise_for_status()
            rows = response.json().get("results", [])
        except (httpx.HTTPError, ValueError) as error:
            raise SearchError("provider_failed", type(error).__name__) from error
        return _clean(
            [
                SearchResult(
                    row.get("title") or "",
                    row.get("url") or "",
                    row.get("content") or "",
                    row.get("published_date"),
                )
                for row in rows
                if isinstance(row, dict)
            ],
            limit,
        )


class SearchService:
    """The configured provider plus its health, for the panel and `doctor`."""

    def __init__(self, provider: SearchProvider | None, *, problem: str | None = None) -> None:
        self.provider = provider
        self.problem = problem
        self.last_ok_at: float | None = None
        self.last_error: str | None = None

    def status(self) -> dict[str, Any]:
        return {
            "provider": self.provider.name if self.provider else None,
            "keyless": bool(self.provider and self.provider.keyless),
            "best_effort": bool(self.provider and self.provider.name == "ddgs"),
            "configured": self.provider is not None,
            "problem": self.problem,
            "last_ok_at": self.last_ok_at,
            "last_error": self.last_error,
        }

    async def search(self, query: str, recency: str, limit: int) -> list[SearchResult]:
        if self.provider is None:
            raise SearchError("not_configured", self.problem or "")
        recency = recency if recency in RECENCIES else "any"
        limit = max(1, min(MAX_RESULTS, int(limit)))
        try:
            results = await self.provider.search(query, recency, limit)
        except SearchError as error:
            self.last_error = error.code
            raise
        self.last_ok_at = time.time()
        self.last_error = None
        return results


def make_search_service(
    name: str,
    *,
    searxng_url: str | None,
    brave_key: str | None,
    tavily_key: str | None,
    client: httpx.AsyncClient,
) -> SearchService:
    name = (name or "ddgs").strip().lower()
    if name == "ddgs":
        return SearchService(DdgsProvider())
    if name == "searxng":
        if not searxng_url:
            return SearchService(None, problem="SEARXNG_URL is not set")
        return SearchService(SearxngProvider(searxng_url, client))
    if name == "brave":
        if not brave_key:
            return SearchService(None, problem="BRAVE_API_KEY is not set")
        return SearchService(BraveProvider(brave_key, client))
    if name == "tavily":
        if not tavily_key:
            return SearchService(None, problem="TAVILY_API_KEY is not set")
        return SearchService(TavilyProvider(tavily_key, client))
    return SearchService(None, problem=f"unknown search provider {name!r}")
