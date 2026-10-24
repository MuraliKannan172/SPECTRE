"""HTTP API under /api/intel: news list, one story, live stream, health."""

from __future__ import annotations

import asyncio
import datetime as dt
import json
import time
from collections.abc import AsyncIterator
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from ..geo.geoparse import ON_GLOBE_CONFIDENCE
from ..hub import LAGGED
from ..ingest.classify import CATEGORY_ORDER
from ..schema import feed_health, freshness, iso, story
from ..store.news import MAX_PAGE, CursorError, NewsQuery

router = APIRouter(prefix="/api/intel")
REPLAY_LIMIT = 500


def _time(value: str | None, name: str) -> int | None:
    if not value:
        return None
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise HTTPException(422, {"code": "bad_time", "param": name}) from error
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.UTC)
    return int(parsed.timestamp())


def _bbox(value: str | None) -> tuple[float, float, float, float] | None:
    if not value:
        return None
    try:
        west, south, east, north = (float(part) for part in value.split(","))
    except ValueError as error:
        raise HTTPException(422, {"code": "bad_bbox"}) from error
    if not (-180 <= west <= 180 and -180 <= east <= 180 and -90 <= south <= north <= 90):
        raise HTTPException(422, {"code": "bad_bbox"})
    return west, south, east, north


def _list(value: str | None) -> tuple[str, ...]:
    return tuple(part.strip() for part in (value or "").split(",") if part.strip())[:20]


def _freshness(request: Request) -> dict[str, Any]:
    state = request.app.state
    return freshness(
        state.scheduler.states(),
        now=int(time.time()),
        started_at=state.started_at,
        poll_seconds=state.settings.poll_seconds,
    )


@router.get("/news")
def list_news(
    request: Request,
    q: Annotated[str | None, Query(max_length=200)] = None,
    since: str | None = None,
    until: str | None = None,
    category: str | None = None,
    region: str | None = None,
    source: str | None = None,
    bbox: str | None = None,
    located: bool = False,
    limit: Annotated[int, Query(ge=1, le=MAX_PAGE)] = 50,
    cursor: Annotated[str | None, Query(max_length=400)] = None,
) -> dict[str, Any]:
    categories = _list(category)
    unknown = [c for c in categories if c not in CATEGORY_ORDER]
    if unknown:
        raise HTTPException(422, {"code": "bad_category", "allowed": list(CATEGORY_ORDER)})
    box = _bbox(bbox)
    query = NewsQuery(
        q=q,
        since=_time(since, "since"),
        until=_time(until, "until"),
        categories=categories,
        region=region,
        sources=_list(source),
        bbox=box,
        # A bbox asks "what is on the globe here": only confidently placed items.
        min_geo_confidence=ON_GLOBE_CONFIDENCE if (located or box) else None,
        limit=limit,
        cursor=cursor,
    )
    try:
        rows, next_cursor = request.app.state.store.query(query)
    except CursorError as error:
        raise HTTPException(422, {"code": "bad_cursor"}) from error
    return {
        "items": [story(row) for row in rows],
        "next_cursor": next_cursor,
        "freshness": _freshness(request),
    }


@router.get("/news/stream")
async def stream_news(request: Request) -> StreamingResponse:
    last_id = request.headers.get("last-event-id") or request.query_params.get("last_event_id")
    try:
        after = int(last_id) if last_id else None
    except ValueError:
        after = None
    return StreamingResponse(
        news_events(request, after),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def _sse(event: str, data: Any, event_id: int | None = None) -> str:
    lines = [f"event: {event}"]
    if event_id is not None:
        lines.append(f"id: {event_id}")
    lines.append("data: " + json.dumps(data, separators=(",", ":")))
    return "\n".join(lines) + "\n\n"


async def news_events(request: Request, after: int | None) -> AsyncIterator[str]:
    """New stories as SSE `story` events (id = story id), cluster growth as
    `story_update`, and a comment heartbeat. Subscribing happens before the
    replay so nothing published in between is lost."""
    state = request.app.state
    queue = state.hub.subscribe()
    try:
        yield "retry: 5000\n\n"
        high_water = after if after is not None else state.store.latest_story_id()
        if after is not None:
            for row in state.store.stories_after(after, REPLAY_LIMIT):
                full = state.store.get_story(row["id"])
                if full:
                    yield _sse("story", story(full), full["id"])
                    high_water = full["id"]
        yield _sse("ready", {"latest_id": high_water, "freshness": _freshness(request)})
        while True:
            if await request.is_disconnected():
                return
            try:
                event = await asyncio.wait_for(queue.get(), timeout=state.settings.heartbeat_seconds)
            except TimeoutError:
                yield f": heartbeat {iso(int(time.time()))}\n\n"
                continue
            if event is LAGGED:
                return
            if event["type"] == "story":
                if event["id"] <= high_water:
                    continue
                high_water = event["id"]
                yield _sse("story", event["story"], event["id"])
            else:
                yield _sse(event["type"], event["story"])
    finally:
        state.hub.unsubscribe(queue)


@router.get("/news/{story_id}")
def get_news(request: Request, story_id: int) -> dict[str, Any]:
    row = request.app.state.store.get_story(story_id)
    if row is None:
        raise HTTPException(404, {"code": "not_found"})
    return story(row)


@router.get("/health")
def health(request: Request) -> dict[str, Any]:
    state = request.app.state
    states = state.scheduler.states()
    stats = state.store.stats()
    geoparser = state.geoparser
    return {
        "service": state.settings.user_agent,
        "now": iso(int(time.time())),
        "started_at": iso(state.started_at),
        "freshness": freshness(
            states,
            now=int(time.time()),
            started_at=state.started_at,
            poll_seconds=state.settings.poll_seconds,
        ),
        "noncommercial_sources": state.settings.noncommercial_enabled(),
        "gdelt_enabled": state.scheduler.gdelt_enabled,
        "stories": stats["stories"],
        "located": stats["located"],
        "newest_first_seen_at": iso(stats["newest_first_seen_at"]),
        "retention_days": state.settings.retention_days,
        "stream_subscribers": len(state.hub),
        "geoparser": {
            "model": geoparser.model_name,
            "gazetteer_entries": len(geoparser.gazetteer),
            "on_globe_confidence": ON_GLOBE_CONFIDENCE,
        },
        "feeds": [feed_health(feed, feed_state) for feed, feed_state in states],
    }
