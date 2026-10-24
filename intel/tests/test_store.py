from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from app.store.db import MigrationError, connect, migrate
from app.store.news import (
    CursorError,
    FeedDef,
    NewsQuery,
    NewsStore,
    SourceRow,
    StoryRow,
    fts_match_expression,
)


def _story(n: int, **overrides: object) -> tuple[StoryRow, SourceRow]:
    feed_id = str(overrides.pop("feed_id", "feed-a"))
    fields = dict(
        title=f"Story number {n}",
        summary=f"Summary {n}",
        url=f"https://example.org/{n}",
        url_hash=f"hash{n}",
        published_at=1_000 + n,
        first_seen_at=2_000 + n,
        category="world",
        severity=1,
    )
    fields.update(overrides)
    story = StoryRow(**fields)  # type: ignore[arg-type]
    source = SourceRow(
        feed_id=feed_id,
        source_name="Example",
        url=story.url,
        url_hash=story.url_hash,
        title=story.title,
        published_at=story.published_at,
        first_seen_at=story.first_seen_at,
    )
    return story, source


def test_migrations_apply_once_and_record_checksums(tmp_path: Path) -> None:
    conn = connect(tmp_path / "m.db")
    assert migrate(conn) == [1]
    assert migrate(conn) == []
    row = conn.execute("SELECT version, name FROM schema_migrations").fetchone()
    assert (row["version"], row["name"]) == (1, "0001_init.sql")
    assert conn.execute("PRAGMA journal_mode").fetchone()[0] == "wal"


def test_an_edited_applied_migration_is_refused(tmp_path: Path) -> None:
    migrations = tmp_path / "migrations"
    migrations.mkdir()
    (migrations / "0001_a.sql").write_text("CREATE TABLE a (x INTEGER);", encoding="utf-8")
    conn = connect(tmp_path / "m.db")
    migrate(conn, migrations)
    (migrations / "0001_a.sql").write_text("CREATE TABLE a (y INTEGER);", encoding="utf-8")
    with pytest.raises(MigrationError, match="changed after it was applied"):
        migrate(conn, migrations)


def test_a_failing_migration_rolls_back_whole(tmp_path: Path) -> None:
    migrations = tmp_path / "migrations"
    migrations.mkdir()
    (migrations / "0001_a.sql").write_text(
        "CREATE TABLE a (x INTEGER);\nCREATE TABLE a (x INTEGER);", encoding="utf-8"
    )
    conn = connect(tmp_path / "m.db")
    with pytest.raises(sqlite3.OperationalError):
        migrate(conn, migrations)
    tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert "a" not in tables
    assert conn.execute("SELECT count(*) FROM schema_migrations").fetchone()[0] == 0


def test_migration_numbers_must_not_skip(tmp_path: Path) -> None:
    migrations = tmp_path / "migrations"
    migrations.mkdir()
    (migrations / "0002_b.sql").write_text("SELECT 1;", encoding="utf-8")
    with pytest.raises(MigrationError, match="without gaps"):
        migrate(connect(":memory:"), migrations)


def test_feed_sync_keeps_health_and_drops_removed_feeds(store: NewsStore) -> None:
    a = FeedDef(id="a", name="A", url="https://a.example/rss", category="world", terms="open")
    b = FeedDef(id="b", name="B", url="https://b.example/rss", category="cyber", terms="open")
    store.sync_feeds([a, b])
    store.record_poll("a", attempted_at=100, ok=True, status=200, next_poll_at=400, etag='"v1"', item_count=7)
    store.sync_feeds([FeedDef(**{**a.__dict__, "name": "A renamed"})])
    feeds = store.feeds()
    assert [feed["id"] for feed in feeds] == ["a"]
    assert feeds[0]["name"] == "A renamed"
    assert (feeds[0]["etag"], feeds[0]["last_success_at"], feeds[0]["item_count"]) == ('"v1"', 100, 7)

    # A changed URL is a different feed: its HTTP validators no longer apply.
    store.sync_feeds([FeedDef(**{**a.__dict__, "url": "https://a.example/atom"})])
    assert store.feed("a")["etag"] is None


def test_poll_errors_accumulate_and_success_resets(store: NewsStore) -> None:
    store.sync_feeds([FeedDef(id="a", name="A", url="https://a.example", category="world", terms="open")])
    store.record_poll("a", attempted_at=10, ok=False, status=503, next_poll_at=20, error="http_503")
    store.record_poll("a", attempted_at=20, ok=False, status=None, next_poll_at=40, error="timeout")
    feed = store.feed("a")
    assert (feed["consecutive_errors"], feed["last_error"], feed["last_success_at"]) == (2, "timeout", None)
    store.record_poll("a", attempted_at=50, ok=True, status=304, next_poll_at=350)
    feed = store.feed("a")
    assert (feed["consecutive_errors"], feed["last_error"], feed["last_success_at"]) == (0, None, 50)


def test_sources_cluster_under_one_story(store: NewsStore) -> None:
    story, source = _story(1)
    story_id = store.insert_story(story, source)
    other = SourceRow("feed-b", "Other", "https://other.example/x", "hashX", "Same event", 1_005, 2_010)
    assert store.add_source(story_id, other, now=3_000) is True
    assert store.add_source(story_id, other, now=3_001) is False  # already attached
    full = store.get_story(story_id)
    assert full["source_count"] == 2
    assert full["updated_at"] == 3_000
    assert [s["source_name"] for s in full["sources"]] == ["Example", "Other"]
    assert store.story_id_for_url_hash("hashX") == story_id


def test_full_text_search_ranks_and_survives_hostile_input(store: NewsStore) -> None:
    store.insert_story(*_story(1, title="Earthquake strikes northern Japan", url_hash="h1"))
    store.insert_story(*_story(2, title="Markets rally", summary="Japan stocks rise", url_hash="h2"))
    store.insert_story(*_story(3, title="Flooding in Kenya", url_hash="h3"))

    rows, _ = store.query(NewsQuery(q="japan"))
    assert [row["title"] for row in rows] == ["Earthquake strikes northern Japan", "Markets rally"]
    for hostile in ['"', "NEAR(", "title:*", "AND OR NOT", "*", 'japan"; DROP TABLE stories;--']:
        store.query(NewsQuery(q=hostile))  # never raises
    assert store.query(NewsQuery(q="!!!"))[0] == []
    assert fts_match_expression('kenya "flood') == '"kenya" "flood"'


def test_fts_follows_updates_and_deletes(store: NewsStore) -> None:
    story_id = store.insert_story(*_story(1, title="Volcano erupts", url_hash="h1"))
    assert store.query(NewsQuery(q="volcano"))[0]
    store._conn.execute("UPDATE stories SET title = 'Glacier retreats' WHERE id = ?", (story_id,))
    assert store.query(NewsQuery(q="volcano"))[0] == []
    assert store.query(NewsQuery(q="glacier"))[0]
    assert store.purge_older_than(10_000) == 1
    assert store.query(NewsQuery(q="glacier"))[0] == []
    assert store._conn.execute("SELECT count(*) FROM story_sources").fetchone()[0] == 0


def test_filters_and_keyset_pagination(store: NewsStore) -> None:
    store.sync_feeds(
        [
            FeedDef(id="feed-a", name="A", url="https://a", category="world", terms="open", region="africa"),
        ]
    )
    for n in range(1, 8):
        store.insert_story(
            *_story(
                n,
                category="disaster" if n % 2 else "economy",
                lat=float(n),
                lon=float(n),
                geo_confidence=0.9 if n > 2 else 0.4,
            )
        )
    page, cursor = store.query(NewsQuery(limit=3))
    assert [row["id"] for row in page] == [7, 6, 5]
    page2, cursor2 = store.query(NewsQuery(limit=3, cursor=cursor))
    assert [row["id"] for row in page2] == [4, 3, 2]
    page3, cursor3 = store.query(NewsQuery(limit=3, cursor=cursor2))
    assert ([row["id"] for row in page3], cursor3) == ([1], None)

    assert {r["category"] for r in store.query(NewsQuery(categories=("disaster",)))[0]} == {"disaster"}
    assert [r["id"] for r in store.query(NewsQuery(bbox=(2.5, 2.5, 4.5, 4.5)))[0]] == [4, 3]
    assert [r["id"] for r in store.query(NewsQuery(since=1_006))[0]] == [7, 6]
    assert len(store.query(NewsQuery(min_geo_confidence=0.6))[0]) == 5
    assert len(store.query(NewsQuery(region="africa"))[0]) == 7
    assert len(store.query(NewsQuery(sources=("Example",)))[0]) == 7
    assert store.query(NewsQuery(region="europe"))[0] == []
    assert page[0]["sources"][0]["source_name"] == "Example"
    with pytest.raises(CursorError):
        store.query(NewsQuery(cursor="not-a-cursor"))


def test_bbox_across_the_antimeridian(store: NewsStore) -> None:
    store.insert_story(*_story(1, lat=-17.7, lon=178.0, url_hash="fiji"))
    store.insert_story(*_story(2, lat=-14.3, lon=-170.7, url_hash="samoa"))
    store.insert_story(*_story(3, lat=0.0, lon=0.0, url_hash="null-island"))
    rows, _ = store.query(NewsQuery(bbox=(170.0, -30.0, -160.0, 0.0)))
    assert sorted(row["url_hash"] for row in rows) == ["fiji", "samoa"]


def test_replay_and_stats(store: NewsStore) -> None:
    for n in range(1, 4):
        store.insert_story(*_story(n, lat=1.0 if n == 2 else None, lon=1.0 if n == 2 else None))
    assert [row["id"] for row in store.stories_after(1)] == [2, 3]
    assert store.latest_story_id() == 3
    assert store.stats() == {"stories": 3, "located": 1, "newest_first_seen_at": 2_003}
