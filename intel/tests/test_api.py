from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient
from helpers import FEEDS_YAML, Routes, gdelt, make_settings, rss

from app.api.routes import news_events
from app.geo.gazetteer import Gazetteer
from app.geo.geoparse import GeoParser
from app.hub import LAGGED, EventHub
from app.main import create_app
from app.store.news import FeedDef, NewsStore, SourceRow, StoryRow


@pytest.fixture(scope="module")
def parser() -> GeoParser:
    return GeoParser(Gazetteer.load())


@pytest.fixture
def served(tmp_path: Path, parser: GeoParser):
    routes = Routes()
    routes.on(
        "alpha.example",
        httpx.Response(
            200,
            content=rss(
                (
                    "Wildfire forces evacuations north of Los Angeles",
                    "https://alpha.example/fire",
                    "Crews battle flames.",
                ),
                ("Central bank holds interest rates", "https://alpha.example/rates", ""),
            ),
        ),
    )
    routes.on("beta.example", httpx.Response(200, content=rss()))
    routes.on("api.gdeltproject.org", httpx.Response(200, content=gdelt()))
    settings = make_settings(tmp_path, FEEDS_YAML)
    app = create_app(settings, transport=routes.transport(), geoparser=parser, start_scheduler=False)
    with TestClient(app, base_url="http://127.0.0.1:8100") as client:
        scheduler = app.state.scheduler

        async def poll_all() -> None:
            scheduler.tick()
            await scheduler.drain()

        client.portal.call(poll_all)
        yield client, app


def test_news_list_filters_and_shapes(served) -> None:
    client, _app = served
    body = client.get("/api/intel/news").json()
    assert {item["title"] for item in body["items"]} == {
        "Wildfire forces evacuations north of Los Angeles",
        "Central bank holds interest rates",
    }
    fire = next(item for item in body["items"] if item["title"].startswith("Wildfire"))
    assert fire["category"] == "disaster"
    assert fire["location"]["country_code"] == "US" and fire["location"]["on_globe"] is True
    assert fire["sources"][0] == {
        "name": "Alpha Wire",
        "url": "https://alpha.example/fire",
        "feed_id": "alpha",
        "published_at": "2026-10-24T10:00:00Z",
    }
    assert body["freshness"]["state"] == "live"

    assert len(client.get("/api/intel/news", params={"q": "wildfire"}).json()["items"]) == 1
    assert (
        client.get("/api/intel/news", params={"category": "economy"})
        .json()["items"][0]["title"]
        .startswith("Central bank")
    )
    located = client.get("/api/intel/news", params={"located": "true"}).json()["items"]
    assert [item["title"][:8] for item in located] == ["Wildfire"]
    assert (
        client.get("/api/intel/news", params={"bbox": "-125,30,-110,40"}).json()["items"][0]["id"]
        == fire["id"]
    )
    assert client.get(f"/api/intel/news/{fire['id']}").json()["title"] == fire["title"]


def test_bad_input_is_a_422_or_404_never_a_500(served) -> None:
    client, _app = served
    for params in (
        {"category": "gossip"},
        {"bbox": "1,2,3"},
        {"bbox": "0,95,1,96"},
        {"since": "yesterday"},
        {"cursor": "%%%"},
        {"limit": "0"},
        {"limit": "1000"},
    ):
        response = client.get("/api/intel/news", params=params)
        assert response.status_code == 422, params
    assert client.get("/api/intel/news", params={"q": '" OR 1=1 --'}).status_code == 200
    assert client.get("/api/intel/news/999999").status_code == 404


def test_health_reports_every_feed_and_the_switch(served) -> None:
    client, _app = served
    health = client.get("/api/intel/health").json()
    states = {feed["id"]: feed["state"] for feed in health["feeds"]}
    assert states == {
        "alpha": "ok",
        "beta": "ok",
        "gamma": "disabled_noncommercial",
        "gdelt-disasters": "ok",
    }
    assert health["noncommercial_sources"] is False
    assert health["stories"] == 2 and health["located"] >= 1
    assert health["geoparser"]["model"].startswith("en_core_web_sm")
    alpha = next(feed for feed in health["feeds"] if feed["id"] == "alpha")
    assert alpha["last_status"] == 200 and alpha["item_count"] == 2 and alpha["last_error"] is None


def test_personal_use_stories_are_hidden_while_the_switch_is_off(tmp_path: Path, parser: GeoParser) -> None:
    routes = Routes()
    routes.on("alpha.example", httpx.Response(200, content=rss()))
    routes.on("beta.example", httpx.Response(200, content=rss()))
    routes.on(
        "gamma.example",
        httpx.Response(200, content=rss(("Volcano erupts in Iceland", "https://gamma.example/v", ""))),
    )
    routes.on("api.gdeltproject.org", httpx.Response(200, content=gdelt()))
    settings = make_settings(tmp_path, FEEDS_YAML)
    settings.env_file.write_text("SPECTRE_NONCOMMERCIAL_SOURCES=1\n", encoding="utf-8")
    app = create_app(settings, transport=routes.transport(), geoparser=parser, start_scheduler=False)
    with TestClient(app, base_url="http://127.0.0.1:8100") as client:
        scheduler = app.state.scheduler

        async def poll_all() -> None:
            scheduler.tick()
            await scheduler.drain()

        client.portal.call(poll_all)  # collected while the switch is on
        items = client.get("/api/intel/news").json()["items"]
        assert [item["title"] for item in items] == ["Volcano erupts in Iceland"]
        story_id = items[0]["id"]

        settings.env_file.write_text("", encoding="utf-8")  # switch turned off
        assert client.get("/api/intel/news").json()["items"] == []
        assert client.get(f"/api/intel/news/{story_id}").status_code == 404

        settings.env_file.write_text("SPECTRE_NONCOMMERCIAL_SOURCES=1\n", encoding="utf-8")
        assert client.get(f"/api/intel/news/{story_id}").status_code == 200


def test_requests_for_other_hosts_are_refused(served) -> None:
    client, _app = served
    assert client.get("/api/intel/health", headers={"Host": "attacker.example"}).status_code == 400
    assert client.get("/api/intel/health", headers={"Host": "localhost:8100"}).status_code == 200


# -- the SSE generator, driven directly (an in-process transport would wait for
# -- the end of an endless body) --------------------------------------------


class FakeRequest:
    def __init__(self, state: SimpleNamespace) -> None:
        self.app = SimpleNamespace(state=state)
        self.disconnected = False

    async def is_disconnected(self) -> bool:
        return self.disconnected


def _seed(store: NewsStore, n: int) -> int:
    url = f"https://alpha.example/{n}"
    return store.insert_story(
        StoryRow(f"Story {n}", "", url, f"h{n}", 1_000 + n, 2_000 + n, "world", 1),
        SourceRow("alpha", "Alpha Wire", url, f"h{n}", f"Story {n}", 1_000 + n, 2_000 + n),
    )


def test_stream_replays_after_last_event_id_then_goes_live(tmp_path: Path) -> None:
    store = NewsStore(str(tmp_path / "s.db"))
    store.sync_feeds(
        [FeedDef(id="alpha", name="Alpha Wire", url="https://alpha.example", category="world", terms="open")]
    )
    for n in range(1, 4):
        _seed(store, n)
    hub = EventHub()
    state = SimpleNamespace(
        store=store,
        hub=hub,
        settings=make_settings(tmp_path, FEEDS_YAML, heartbeat_seconds=0.05),
        scheduler=SimpleNamespace(states=lambda: []),
        started_at=0,
    )
    request = FakeRequest(state)

    async def scenario() -> list[str]:
        stream = news_events(request, after=1)
        chunks = [await anext(stream) for _ in range(4)]  # retry, story 2, story 3, ready
        new_id = _seed(store, 4)
        hub.publish({"type": "story", "id": 2, "story": {"id": 2}})  # already sent: skipped
        hub.publish({"type": "story", "id": new_id, "story": {"id": new_id}})
        chunks.append(await anext(stream))
        chunks.append(await anext(stream))  # idle: heartbeat
        hub.publish(LAGGED)
        with pytest.raises(StopAsyncIteration):
            await anext(stream)
        return chunks

    chunks = asyncio.run(scenario())
    assert chunks[0] == "retry: 5000\n\n"
    assert chunks[1].startswith("event: story\nid: 2\n")
    assert chunks[2].startswith("event: story\nid: 3\n")
    assert chunks[3].startswith("event: ready\n") and '"latest_id":3' in chunks[3]
    assert chunks[4].startswith("event: story\nid: 4\n")
    assert chunks[5].startswith(": heartbeat ")
    assert len(hub) == 0  # unsubscribed when the stream ended
    store.close()


def test_a_slow_subscriber_is_cut_loose_not_buffered() -> None:
    async def scenario() -> None:
        hub = EventHub(max_queue=2)
        queue = hub.subscribe()
        for n in range(3):
            hub.publish({"type": "story", "id": n})
        assert len(hub) == 0
        assert queue.get_nowait() is LAGGED

    asyncio.run(scenario())
