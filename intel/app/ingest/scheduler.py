"""Poll each active feed on its own clock, back off failures, publish new stories."""

from __future__ import annotations

import asyncio
import logging
import math
import random
import time
from collections.abc import Callable
from typing import Any

import httpx

from ..config import Settings
from ..hub import EventHub
from ..schema import feed_state, story
from ..store.news import NewsStore
from .feeds import FeedConfig
from .fetch import fetch
from .parse import FeedParseError, gdelt_params, parse_feed, parse_gdelt
from .pipeline import FeedInfo, Pipeline

log = logging.getLogger("spectre.intel.scheduler")

TICK_SECONDS = 5.0
MAX_BACKOFF_SECONDS = 3600
GDELT_SPACING_SECONDS = 5.5  # GDELT DOC asks for at most one request every five seconds
GDELT_INTERVAL_SECONDS = 900  # GDELT queries are broad: poll them every 15 min at most
GDELT_MAX_RECORDS = 25
PURGE_EVERY_SECONDS = 6 * 3600


class Scheduler:
    def __init__(
        self,
        settings: Settings,
        store: NewsStore,
        pipeline: Pipeline,
        hub: EventHub,
        config: FeedConfig,
        client: httpx.AsyncClient,
        *,
        clock: Callable[[], float] = time.time,
        jitter: Callable[[], float] = random.random,
        gdelt_spacing: float = GDELT_SPACING_SECONDS,
    ) -> None:
        self.settings = settings
        self._store = store
        self._pipeline = pipeline
        self._hub = hub
        self._config = config
        self._client = client
        self._clock = clock
        self._jitter = jitter
        self._gdelt_spacing = gdelt_spacing
        self._queries = {query.id: query for query in config.gdelt_queries}
        self._semaphore = asyncio.Semaphore(settings.max_concurrency)
        self._gdelt_lock = asyncio.Lock()
        self._running: dict[str, asyncio.Task[None]] = {}
        self._last_purge = 0

    @property
    def gdelt_enabled(self) -> bool:
        return self._config.gdelt_enabled and self.settings.gdelt_enabled

    def states(self) -> list[tuple[dict[str, Any], str]]:
        noncommercial = self.settings.noncommercial_enabled()
        return [
            (feed, feed_state(feed, noncommercial=noncommercial, gdelt_enabled=self.gdelt_enabled))
            for feed in self._store.feeds()
        ]

    async def run(self) -> None:
        while True:
            try:
                self.tick()
            except Exception:  # keep polling: one bad cycle must not stop ingest
                log.exception("scheduler tick failed")
            await asyncio.sleep(TICK_SECONDS)

    def tick(self) -> list[str]:
        """Start polls for every due, active feed. Returns the feed ids started."""
        now = int(self._clock())
        if now - self._last_purge >= PURGE_EVERY_SECONDS:
            self._last_purge = now
            removed = self._store.purge_older_than(now - self.settings.retention_days * 86400)
            if removed:
                log.info("retention: removed %d stories", removed)
        started = []
        for feed, state in self.states():
            if state not in ("ok", "error", "pending") or feed["id"] in self._running:
                continue
            if (feed["next_poll_at"] or 0) > now:
                continue
            task = asyncio.get_running_loop().create_task(self.poll(feed))
            self._running[feed["id"]] = task
            task.add_done_callback(lambda _t, feed_id=feed["id"]: self._running.pop(feed_id, None))
            started.append(feed["id"])
        return started

    async def drain(self) -> None:
        """Wait for the polls in flight (tests and shutdown)."""
        while self._running:
            await asyncio.gather(*list(self._running.values()), return_exceptions=True)

    def _interval(self, feed: dict[str, Any]) -> int:
        if feed["kind"] == "gdelt":
            return max(self.settings.poll_seconds, GDELT_INTERVAL_SECONDS)
        return self.settings.poll_seconds

    def _next_success(self, now: int, feed: dict[str, Any]) -> int:
        return now + int(self._interval(feed) * (0.9 + 0.2 * self._jitter()))

    def _next_failure(self, now: int, feed: dict[str, Any], retry_after: int | None) -> int:
        """Back off from the feed's own interval: 1x, 2x, 4x ... capped at 1 h."""
        errors_before = feed["consecutive_errors"]
        delay = min(MAX_BACKOFF_SECONDS, self._interval(feed) * 2 ** min(errors_before, 6))
        delay = delay * (0.8 + 0.4 * self._jitter())
        if retry_after:
            delay = max(delay, min(retry_after, MAX_BACKOFF_SECONDS))
        return now + math.ceil(delay)

    async def poll(self, feed: dict[str, Any]) -> None:
        async with self._semaphore:
            if feed["kind"] == "gdelt":
                query = self._queries.get(feed["id"])
                if query is None:
                    return
                async with self._gdelt_lock:
                    # Look back two intervals so a late or failed poll leaves no gap.
                    timespan = math.ceil(2 * self._interval(feed) / 60)
                    result = await fetch(
                        self._client,
                        feed["url"],
                        params=gdelt_params(query.query, timespan, GDELT_MAX_RECORDS),
                        max_bytes=self.settings.max_feed_bytes,
                    )
                    await asyncio.sleep(self._gdelt_spacing)
            else:
                result = await fetch(
                    self._client,
                    feed["url"],
                    etag=feed["etag"],
                    last_modified=feed["last_modified"],
                    max_bytes=self.settings.max_feed_bytes,
                )

        now = int(self._clock())
        if not result.ok:
            self._fail(feed, now, result.status, result.error or "error", result.retry_after)
            return
        if result.body is None:  # 304 Not Modified
            self._store.record_poll(
                feed["id"],
                attempted_at=now,
                ok=True,
                status=result.status,
                next_poll_at=self._next_success(now, feed),
            )
            return

        oldest = now - self.settings.retention_days * 86400
        try:
            if feed["kind"] == "gdelt":
                items = await asyncio.to_thread(parse_gdelt, result.body, now=now, oldest=oldest)
            else:
                items = await asyncio.to_thread(
                    parse_feed, result.body, source_name=feed["name"], now=now, oldest=oldest
                )
        except FeedParseError:
            self._fail(feed, now, result.status, "parse_error", None)
            return

        info = FeedInfo(feed["id"], feed["category"], feed["region"])
        events = await asyncio.to_thread(self._pipeline.process, info, items, now)
        self._store.record_poll(
            feed["id"],
            attempted_at=now,
            ok=True,
            status=result.status,
            next_poll_at=self._next_success(now, feed),
            etag=result.etag,
            last_modified=result.last_modified,
            item_count=len(items),
        )
        for event in events:
            row = self._store.get_story(event["id"])
            if row is not None:
                self._hub.publish({"type": event["type"], "id": event["id"], "story": story(row)})
        if events:
            log.info("%s: %d new, %d clustered", feed["id"], *_counts(events))

    def _fail(
        self, feed: dict[str, Any], now: int, status: int | None, error: str, retry_after: int | None
    ) -> None:
        log.warning("%s: poll failed (%s)", feed["id"], error)
        self._store.record_poll(
            feed["id"],
            attempted_at=now,
            ok=False,
            status=status,
            error=error,
            next_poll_at=self._next_failure(now, feed, retry_after),
        )


def _counts(events: list[dict[str, Any]]) -> tuple[int, int]:
    new = sum(1 for event in events if event["type"] == "story")
    return new, len(events) - new
