"""News store: feed health, story clusters, and filtered or full-text queries."""

from __future__ import annotations

import base64
import json
import re
import sqlite3
import threading
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

from .db import connect, migrate

MAX_PAGE = 200
_FTS_TOKEN = re.compile(r"\w+", re.UNICODE)


@dataclass(frozen=True)
class FeedDef:
    id: str
    name: str
    url: str
    category: str
    terms: str
    kind: str = "rss"
    region: str | None = None
    terms_note: str | None = None
    enabled: bool = True


@dataclass(frozen=True)
class SourceRow:
    feed_id: str
    source_name: str
    url: str
    url_hash: str
    title: str
    published_at: int
    first_seen_at: int


@dataclass(frozen=True)
class StoryRow:
    title: str
    summary: str
    url: str
    url_hash: str
    published_at: int
    first_seen_at: int
    category: str
    severity: int
    lat: float | None = None
    lon: float | None = None
    geo_confidence: float | None = None
    place_name: str | None = None
    country_code: str | None = None


@dataclass(frozen=True)
class NewsQuery:
    q: str | None = None
    since: int | None = None
    until: int | None = None
    categories: tuple[str, ...] = ()
    region: str | None = None
    sources: tuple[str, ...] = ()
    bbox: tuple[float, float, float, float] | None = None
    min_geo_confidence: float | None = None
    limit: int = 50
    cursor: str | None = None


class CursorError(ValueError):
    pass


def fts_match_expression(text: str) -> str | None:
    """User text to an FTS5 expression: every word quoted, all required.

    Quoting each token means no user input is ever parsed as FTS syntax, so
    stray quotes, NEAR, column filters or a lone '*' cannot raise an error.
    """
    tokens = _FTS_TOKEN.findall(text or "")
    if not tokens:
        return None
    return " ".join(f'"{token}"' for token in tokens[:16])


def _encode_cursor(payload: dict[str, Any]) -> str:
    raw = json.dumps(payload, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _decode_cursor(cursor: str) -> dict[str, Any]:
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded.encode()))
    except (ValueError, json.JSONDecodeError) as error:
        raise CursorError("invalid cursor") from error
    if not isinstance(payload, dict):
        raise CursorError("invalid cursor")
    return payload


class NewsStore:
    """Thread-safe wrapper around one SQLite connection.

    SQL text is only ever assembled from fixed fragments and "?" placeholders
    (the S608 suppressions below); every value is a bound parameter.
    """

    def __init__(self, path: str) -> None:
        self._conn = connect(path)
        self._lock = threading.RLock()
        with self._lock:
            migrate(self._conn)

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # -- feeds -------------------------------------------------------------

    def sync_feeds(self, feeds: Iterable[FeedDef]) -> None:
        """Make the feeds table match the configuration, keeping poll health."""
        feeds = list(feeds)
        with self._lock, self._transaction():
            for feed in feeds:
                self._conn.execute(
                    "INSERT INTO feeds (id, name, url, kind, category, region, terms,"
                    " terms_note, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
                    " ON CONFLICT (id) DO UPDATE SET name = excluded.name,"
                    " url = excluded.url, kind = excluded.kind,"
                    " category = excluded.category, region = excluded.region,"
                    " terms = excluded.terms, terms_note = excluded.terms_note,"
                    " enabled = excluded.enabled,"
                    # A new URL is a new feed: its validators and health reset.
                    " etag = CASE WHEN feeds.url = excluded.url THEN feeds.etag END,"
                    " last_modified = CASE WHEN feeds.url = excluded.url"
                    "   THEN feeds.last_modified END",
                    (
                        feed.id,
                        feed.name,
                        feed.url,
                        feed.kind,
                        feed.category,
                        feed.region,
                        feed.terms,
                        feed.terms_note,
                        int(feed.enabled),
                    ),
                )
            ids = [feed.id for feed in feeds]
            placeholders = ",".join("?" * len(ids)) or "''"
            self._conn.execute(f"DELETE FROM feeds WHERE id NOT IN ({placeholders})", ids)  # noqa: S608

    def feeds(self) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute("SELECT * FROM feeds ORDER BY id").fetchall()
        return [dict(row) for row in rows]

    def feed(self, feed_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._conn.execute("SELECT * FROM feeds WHERE id = ?", (feed_id,)).fetchone()
        return dict(row) if row else None

    def record_poll(
        self,
        feed_id: str,
        *,
        attempted_at: int,
        ok: bool,
        status: int | None,
        next_poll_at: int,
        error: str | None = None,
        etag: str | None = None,
        last_modified: str | None = None,
        item_count: int | None = None,
    ) -> None:
        with self._lock, self._transaction():
            if ok:
                self._conn.execute(
                    "UPDATE feeds SET last_attempt_at = ?, last_success_at = ?,"
                    " last_status = ?, last_error = NULL, consecutive_errors = 0,"
                    " next_poll_at = ?, etag = coalesce(?, etag),"
                    " last_modified = coalesce(?, last_modified),"
                    " item_count = coalesce(?, item_count) WHERE id = ?",
                    (
                        attempted_at,
                        attempted_at,
                        status,
                        next_poll_at,
                        etag,
                        last_modified,
                        item_count,
                        feed_id,
                    ),
                )
            else:
                self._conn.execute(
                    "UPDATE feeds SET last_attempt_at = ?, last_status = ?,"
                    " last_error = ?, consecutive_errors = consecutive_errors + 1,"
                    " next_poll_at = ? WHERE id = ?",
                    (attempted_at, status, error, next_poll_at, feed_id),
                )

    # -- stories -----------------------------------------------------------

    def story_id_for_url_hash(self, url_hash: str) -> int | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT story_id FROM story_sources WHERE url_hash = ?", (url_hash,)
            ).fetchone()
        return row["story_id"] if row else None

    def recent_for_dedupe(self, since: int) -> list[dict[str, Any]]:
        """Stories first seen since `since`, with the feeds that reported each."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT s.id, s.title, s.first_seen_at, s.country_code, s.lat, s.lon,"
                " s.geo_confidence, group_concat(ss.feed_id, ' ') AS feed_ids"
                " FROM stories s JOIN story_sources ss ON ss.story_id = s.id"
                " WHERE s.first_seen_at >= ? GROUP BY s.id ORDER BY s.id",
                (since,),
            ).fetchall()
        return [dict(row) for row in rows]

    def insert_story(self, story: StoryRow, source: SourceRow) -> int:
        with self._lock, self._transaction():
            cursor = self._conn.execute(
                "INSERT INTO stories (title, summary, url, url_hash, published_at,"
                " first_seen_at, updated_at, category, severity, lat, lon,"
                " geo_confidence, place_name, country_code, source_count)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)",
                (
                    story.title,
                    story.summary,
                    story.url,
                    story.url_hash,
                    story.published_at,
                    story.first_seen_at,
                    story.first_seen_at,
                    story.category,
                    story.severity,
                    story.lat,
                    story.lon,
                    story.geo_confidence,
                    story.place_name,
                    story.country_code,
                ),
            )
            story_id = int(cursor.lastrowid)
            self._insert_source(story_id, source)
        return story_id

    def add_source(self, story_id: int, source: SourceRow, *, now: int) -> bool:
        """Attach another outlet's report to a story. False if already known."""
        with self._lock, self._transaction():
            try:
                self._insert_source(story_id, source)
            except sqlite3.IntegrityError:
                return False
            self._conn.execute(
                "UPDATE stories SET source_count = source_count + 1, updated_at = ? WHERE id = ?",
                (now, story_id),
            )
        return True

    def _insert_source(self, story_id: int, source: SourceRow) -> None:
        self._conn.execute(
            "INSERT INTO story_sources (story_id, feed_id, source_name, url, url_hash,"
            " title, published_at, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                story_id,
                source.feed_id,
                source.source_name,
                source.url,
                source.url_hash,
                source.title,
                source.published_at,
                source.first_seen_at,
            ),
        )

    def get_story(self, story_id: int) -> dict[str, Any] | None:
        with self._lock:
            row = self._conn.execute("SELECT * FROM stories WHERE id = ?", (story_id,)).fetchone()
            if not row:
                return None
            sources = self._conn.execute(
                "SELECT feed_id, source_name, url, title, published_at FROM story_sources"
                " WHERE story_id = ? ORDER BY published_at, id",
                (story_id,),
            ).fetchall()
        story = dict(row)
        story["sources"] = [dict(source) for source in sources]
        return story

    def stories_after(self, story_id: int, limit: int = 100) -> list[dict[str, Any]]:
        """Stories added after `story_id`, oldest first (SSE replay)."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM stories WHERE id > ? ORDER BY id LIMIT ?",
                (story_id, limit),
            ).fetchall()
        return [dict(row) for row in rows]

    def latest_story_id(self) -> int:
        with self._lock:
            row = self._conn.execute("SELECT max(id) AS id FROM stories").fetchone()
        return int(row["id"] or 0)

    def stats(self) -> dict[str, Any]:
        with self._lock:
            row = self._conn.execute(
                "SELECT count(*) AS stories, max(first_seen_at) AS newest_first_seen_at,"
                " sum(lat IS NOT NULL) AS located FROM stories"
            ).fetchone()
        return {
            "stories": int(row["stories"]),
            "located": int(row["located"] or 0),
            "newest_first_seen_at": row["newest_first_seen_at"],
        }

    def purge_older_than(self, cutoff: int) -> int:
        with self._lock, self._transaction():
            cursor = self._conn.execute(
                "DELETE FROM stories WHERE max(published_at, updated_at) < ?", (cutoff,)
            )
        return cursor.rowcount

    def query(self, query: NewsQuery) -> tuple[list[dict[str, Any]], str | None]:
        """Filtered stories, newest first (or best match first with `q`)."""
        limit = max(1, min(int(query.limit), MAX_PAGE))
        where, params = self._filters(query)
        match = fts_match_expression(query.q) if query.q else None
        cursor = _decode_cursor(query.cursor) if query.cursor else None

        if query.q and not match:
            return [], None
        if match:
            # Ranked results page by offset: BM25 scores have no stable keyset.
            offset = int(cursor.get("o", 0)) if cursor else 0
            if offset < 0:
                raise CursorError("invalid cursor")
            sql = (
                "SELECT s.* FROM news_fts JOIN stories s ON s.id = news_fts.rowid"  # noqa: S608
                " WHERE news_fts MATCH ?"
                + "".join(f" AND {clause}" for clause in where)
                # A headline hit outweighs a summary or place-name hit.
                + " ORDER BY bm25(news_fts, 3.0, 1.0, 1.0), s.published_at DESC, s.id DESC"
                + " LIMIT ? OFFSET ?"
            )
            args = [match, *params, limit + 1, offset]
            next_payload = {"o": offset + limit}
        else:
            if cursor:
                try:
                    before_published, before_id = int(cursor["p"]), int(cursor["i"])
                except (KeyError, TypeError, ValueError) as error:
                    raise CursorError("invalid cursor") from error
                where.append("(s.published_at < ? OR (s.published_at = ? AND s.id < ?))")
                params.extend([before_published, before_published, before_id])
            sql = (
                "SELECT s.* FROM stories s"  # noqa: S608
                + (" WHERE " + " AND ".join(where) if where else "")
                + " ORDER BY s.published_at DESC, s.id DESC LIMIT ?"
            )
            args = [*params, limit + 1]
            next_payload = None

        with self._lock:
            rows = [dict(row) for row in self._conn.execute(sql, args).fetchall()]
            has_more = len(rows) > limit
            rows = rows[:limit]
            self._attach_sources(rows)
        if not has_more:
            return rows, None
        if next_payload is None:
            last = rows[-1]
            next_payload = {"p": last["published_at"], "i": last["id"]}
        return rows, _encode_cursor(next_payload)

    def _filters(self, query: NewsQuery) -> tuple[list[str], list[Any]]:
        where: list[str] = []
        params: list[Any] = []
        if query.since is not None:
            where.append("s.published_at >= ?")
            params.append(query.since)
        if query.until is not None:
            where.append("s.published_at <= ?")
            params.append(query.until)
        if query.categories:
            where.append(f"s.category IN ({','.join('?' * len(query.categories))})")
            params.extend(query.categories)
        if query.region:
            where.append(
                "EXISTS (SELECT 1 FROM story_sources ss JOIN feeds f ON f.id = ss.feed_id"
                " WHERE ss.story_id = s.id AND f.region = ?)"
            )
            params.append(query.region)
        if query.sources:
            marks = ",".join("?" * len(query.sources))
            where.append(
                "EXISTS (SELECT 1 FROM story_sources ss WHERE ss.story_id = s.id"  # noqa: S608
                f" AND (ss.feed_id IN ({marks}) OR ss.source_name IN ({marks})))"
            )
            params.extend([*query.sources, *query.sources])
        if query.bbox is not None:
            west, south, east, north = query.bbox
            where.append("s.lat BETWEEN ? AND ?")
            params.extend([south, north])
            if west <= east:
                where.append("s.lon BETWEEN ? AND ?")
                params.extend([west, east])
            else:  # crosses the antimeridian
                where.append("(s.lon >= ? OR s.lon <= ?)")
                params.extend([west, east])
        if query.min_geo_confidence is not None:
            where.append("s.geo_confidence >= ?")
            params.append(query.min_geo_confidence)
        return where, params

    def _attach_sources(self, rows: list[dict[str, Any]]) -> None:
        if not rows:
            return
        ids = [row["id"] for row in rows]
        sources = self._conn.execute(
            "SELECT story_id, feed_id, source_name, url, published_at FROM story_sources"  # noqa: S608
            f" WHERE story_id IN ({','.join('?' * len(ids))}) ORDER BY published_at, id",
            ids,
        ).fetchall()
        by_story: dict[int, list[dict[str, Any]]] = {}
        for source in sources:
            entry = dict(source)
            by_story.setdefault(entry.pop("story_id"), []).append(entry)
        for row in rows:
            row["sources"] = by_story.get(row["id"], [])

    # -- helpers -----------------------------------------------------------

    class _Tx:
        def __init__(self, conn: sqlite3.Connection) -> None:
            self._conn = conn

        def __enter__(self) -> None:
            self._conn.execute("BEGIN IMMEDIATE")

        def __exit__(self, exc_type: Any, *_: Any) -> None:
            self._conn.execute("ROLLBACK" if exc_type else "COMMIT")

    def _transaction(self) -> NewsStore._Tx:
        return NewsStore._Tx(self._conn)
