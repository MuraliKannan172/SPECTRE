from __future__ import annotations

import asyncio
from pathlib import Path

import httpx
import pytest
from helpers import FEEDS_YAML, Routes, gdelt, make_settings, rss

from app.geo.gazetteer import Gazetteer
from app.geo.geoparse import GeoParser
from app.hub import EventHub
from app.ingest.feeds import FeedConfigError, load_feed_config
from app.ingest.parse import parse_feed
from app.ingest.pipeline import Pipeline
from app.ingest.scheduler import Scheduler
from app.schema import freshness
from app.store.news import NewsQuery, NewsStore

NOW = 1_793_000_000  # 2026-10-26, after the fixtures' publication dates


@pytest.fixture(scope="module")
def parser() -> GeoParser:
    return GeoParser(Gazetteer.load())


class Clock:
    def __init__(self, now: int) -> None:
        self.now = now

    def __call__(self) -> float:
        return float(self.now)


def build(
    tmp_path: Path, parser: GeoParser, routes: Routes, feeds_yaml: str = FEEDS_YAML, **settings: object
):
    config_settings = make_settings(tmp_path, feeds_yaml, **settings)
    config = load_feed_config(config_settings.feeds_default, config_settings.feeds_local)
    store = NewsStore(str(config_settings.db_path))
    store.sync_feeds(config.all_defs())
    hub = EventHub()
    clock = Clock(NOW)
    client = httpx.AsyncClient(transport=routes.transport(), follow_redirects=True)
    scheduler = Scheduler(
        config_settings,
        store,
        Pipeline(store, parser),
        hub,
        config,
        client,
        clock=clock,
        jitter=lambda: 0.5,
        gdelt_spacing=0,
    )
    return scheduler, store, hub, clock, client


async def run_tick(scheduler: Scheduler) -> list[str]:
    started = scheduler.tick()
    await scheduler.drain()
    return started


# -- configuration --------------------------------------------------------------


def test_feed_config_validates_and_local_overrides_merge(tmp_path: Path) -> None:
    default = tmp_path / "feeds.yaml"
    default.write_text(FEEDS_YAML, encoding="utf-8")
    local = tmp_path / "feeds.local.yaml"
    local.write_text(
        "feeds:\n  - id: alpha\n    enabled: false\n"
        "  - id: mine\n    name: My Feed\n    url: https://mine.example/rss\n"
        "    category: cyber\n    terms: open\ngdelt:\n  enabled: false\n",
        encoding="utf-8",
    )
    config = load_feed_config(default, local)
    by_id = {feed.id: feed for feed in config.all_defs()}
    assert by_id["alpha"].enabled is False
    assert by_id["mine"].category == "cyber"
    assert by_id["gdelt-disasters"].kind == "gdelt" and by_id["gdelt-disasters"].enabled is False

    def feed(
        feed_id: str = "x", url: str = "https://x.example", category: str = "world", terms: str = "open"
    ):
        return (
            f"feeds:\n  - id: {feed_id}\n    name: X\n    url: {url}\n"
            f"    category: {category}\n    terms: {terms}\n"
        )

    for bad in (
        feed(url="javascript:alert(1)"),
        feed(category="gossip"),
        feed(terms="maybe"),
        feed(feed_id="Bad Id"),
        "feeds:\n  - name: no id\n",
    ):
        default.write_text(bad, encoding="utf-8")
        with pytest.raises(FeedConfigError):
            load_feed_config(default)


# -- parsing ----------------------------------------------------------------------


def test_feed_parsing_keeps_safe_plain_items_and_feed_points() -> None:
    body = rss(
        ("Quake hits <b>coast</b>", "https://alpha.example/a", "<p>Strong <i>shaking</i> felt.</p>"),
        ("Bad link", "javascript:alert(1)", "x"),
        ("", "https://alpha.example/untitled", "no title"),
        extra=(
            "<item><title>Pointed</title><link>https://alpha.example/p</link>"
            "<georss:point>35.6 139.7</georss:point>"
            "<pubDate>Sat, 24 Oct 2026 10:00:00 GMT</pubDate></item>"
        ),
    )
    items = parse_feed(body, source_name="Alpha Wire", now=NOW, oldest=NOW - 30 * 86400)
    assert [item.title for item in items] == ["Quake hits coast", "Pointed"]
    assert items[0].summary == "Strong shaking felt."
    assert items[1].point == (35.6, 139.7)
    assert parse_feed(body, source_name="A", now=NOW, oldest=NOW + 1) == []  # all too old


# -- polling ------------------------------------------------------------------------


def test_first_poll_stores_items_then_etag_gives_304(tmp_path: Path, parser: GeoParser) -> None:
    routes = Routes()

    def alpha(request: httpx.Request) -> httpx.Response:
        if request.headers.get("if-none-match") == '"v1"':
            return httpx.Response(304)
        return httpx.Response(
            200,
            headers={"ETag": '"v1"'},
            content=rss(("Floods hit Kenya's coast as rivers burst", "https://alpha.example/1", "")),
        )

    routes.on("alpha.example", alpha)
    routes.on("beta.example", httpx.Response(200, content=rss()))
    routes.on("api.gdeltproject.org", httpx.Response(200, content=gdelt()))
    scheduler, store, hub, clock, client = build(tmp_path, parser, routes)

    async def scenario() -> None:
        queue = hub.subscribe()
        started = await run_tick(scheduler)
        assert sorted(started) == ["alpha", "beta", "gdelt-disasters"]  # gamma is personal-use: off
        event = queue.get_nowait()
        assert event["type"] == "story" and event["story"]["location"]["country_code"] == "KE"
        assert await run_tick(scheduler) == []  # nothing due yet
        clock.now += 400
        await run_tick(scheduler)
        await client.aclose()

    asyncio.run(scenario())
    alpha_requests = [r for r in routes.requests if r.url.host == "alpha.example"]
    assert alpha_requests[1].headers["if-none-match"] == '"v1"'
    feed = store.feed("alpha")
    assert (feed["last_status"], feed["consecutive_errors"], feed["item_count"]) == (304, 0, 1)
    assert store.stats()["stories"] == 1
    gdelt_request = next(r for r in routes.requests if r.url.host == "api.gdeltproject.org")
    assert gdelt_request.url.params["mode"] == "artlist" and gdelt_request.url.params["timespan"] == "15min"


def test_network_off_serves_cache_and_reports_offline_then_stale(tmp_path: Path, parser: GeoParser) -> None:
    routes = Routes()
    routes.on(
        "alpha.example",
        httpx.Response(200, content=rss(("Volcano erupts in Iceland", "https://alpha.example/v", ""))),
    )
    routes.on("beta.example", httpx.Response(200, content=rss()))
    routes.on("api.gdeltproject.org", httpx.Response(200, content=gdelt()))
    scheduler, store, _hub, clock, client = build(tmp_path, parser, routes)
    started_at = NOW

    async def scenario() -> None:
        await run_tick(scheduler)
        routes.handlers.clear()  # every host now refuses to connect
        clock.now += 301
        await run_tick(scheduler)
        await client.aclose()

    asyncio.run(scenario())
    alpha = store.feed("alpha")
    assert (alpha["last_error"], alpha["consecutive_errors"]) == ("connect_error", 1)
    assert alpha["next_poll_at"] == clock.now + 300  # first failure: one interval
    assert store.query(NewsQuery())[0][0]["title"] == "Volcano erupts in Iceland"  # cache still served

    state = freshness(scheduler.states(), now=clock.now, started_at=started_at, poll_seconds=300)
    assert (state["state"], state["offline"], state["stale"]) == ("offline", True, False)
    later = freshness(scheduler.states(), now=NOW + 901, started_at=started_at, poll_seconds=300)
    assert later["stale"] is True and later["age_seconds"] == 901


def test_backoff_grows_and_respects_retry_after(tmp_path: Path, parser: GeoParser) -> None:
    routes = Routes()
    routes.on("alpha.example", httpx.Response(503, headers={"Retry-After": "7200"}))
    routes.on("beta.example", httpx.Response(200, content=b"<html>not a feed</html>"))
    routes.on("api.gdeltproject.org", httpx.Response(200, content=b"x" * 2048))
    scheduler, store, _hub, clock, client = build(tmp_path, parser, routes, max_feed_bytes=1024)

    async def scenario() -> None:
        await run_tick(scheduler)
        await client.aclose()

    asyncio.run(scenario())
    alpha, beta, gdelt_feed = store.feed("alpha"), store.feed("beta"), store.feed("gdelt-disasters")
    assert (alpha["last_error"], alpha["next_poll_at"] - NOW) == ("http_503", 3600)  # capped at 1 h
    assert beta["last_error"] == "parse_error"
    assert gdelt_feed["last_error"] == "too_large"
    # Second consecutive failure doubles the wait (jitter fixed at 1.0x).
    assert scheduler._next_failure(NOW, 1, None) - NOW == 600


def test_personal_use_feeds_follow_the_noncommercial_switch(tmp_path: Path, parser: GeoParser) -> None:
    routes = Routes()
    for host in ("alpha.example", "beta.example", "gamma.example"):
        routes.on(host, httpx.Response(200, content=rss()))
    routes.on("api.gdeltproject.org", httpx.Response(200, content=gdelt()))
    scheduler, _store, _hub, clock, client = build(tmp_path, parser, routes)
    env = tmp_path / ".env"

    async def scenario() -> tuple[list[str], list[str]]:
        off = await run_tick(scheduler)
        env.write_text("SKYNET_NONCOMMERCIAL_SOURCES=1\n", encoding="utf-8")
        clock.now += 400
        on = await run_tick(scheduler)
        await client.aclose()
        return off, on

    off, on = asyncio.run(scenario())
    assert "gamma" not in off
    assert "gamma" in on
    states = dict((feed["id"], state) for feed, state in scheduler.states())
    assert states["gamma"] == "ok"


def test_two_outlets_reporting_one_event_become_one_story(tmp_path: Path, parser: GeoParser) -> None:
    routes = Routes()
    routes.on(
        "alpha.example",
        httpx.Response(
            200,
            content=rss(
                (
                    "Powerful earthquake strikes northern Japan, tsunami alert issued",
                    "https://alpha.example/q",
                    "",
                )
            ),
        ),
    )
    routes.on(
        "beta.example",
        httpx.Response(
            200,
            content=rss(
                (
                    "Powerful earthquake strikes northern Japan; tsunami alert issued",
                    "https://beta.example/q",
                    "",
                )
            ),
        ),
    )
    routes.on(
        "api.gdeltproject.org",
        httpx.Response(
            200,
            content=gdelt(
                (
                    "Powerful earthquake strikes northern Japan - tsunami alert issued",
                    "https://www.alpha.example/q?utm_source=gdelt",
                    "alpha.example",
                )
            ),
        ),
    )
    scheduler, store, _hub, _clock, client = build(tmp_path, parser, routes)

    async def scenario() -> None:
        await run_tick(scheduler)
        await client.aclose()

    asyncio.run(scenario())
    rows, _ = store.query(NewsQuery())
    assert len(rows) == 1
    # GDELT's copy of alpha's link canonicalises to the same URL: two sources,
    # not three (which of alpha or GDELT recorded it first depends on timing).
    assert rows[0]["source_count"] == 2
    assert "Beta News" in {source["source_name"] for source in rows[0]["sources"]}
    assert rows[0]["category"] == "disaster" and rows[0]["severity"] == 4
