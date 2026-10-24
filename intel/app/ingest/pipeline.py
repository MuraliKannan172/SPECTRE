"""Parsed items to stored stories: skip known links, classify, geoparse, cluster."""

from __future__ import annotations

import math
import threading
from dataclasses import dataclass
from typing import Any

from ..geo.geoparse import ON_GLOBE_CONFIDENCE, GeoParser, GeoResult
from ..store.news import NewsStore, SourceRow, StoryRow
from .classify import classify
from .dedupe import WINDOW_SECONDS, Candidate, DedupeIndex
from .normalize import url_hash
from .parse import RawItem

FEED_POINT_CONFIDENCE = 0.95
NAME_MATCH_KM = 300.0


@dataclass(frozen=True)
class FeedInfo:
    id: str
    category: str
    region: str | None


@dataclass(frozen=True)
class Location:
    lat: float
    lon: float
    place_name: str | None
    country_code: str | None
    confidence: float


def _km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371.0 * math.asin(math.sqrt(h))


def locate(item: RawItem, geo: GeoResult | None) -> Location | None:
    """Coordinates the feed supplies win; the text names the place if it agrees."""
    if item.point is not None:
        lat, lon = item.point
        named = geo is not None and _km(lat, lon, geo.lat, geo.lon) <= NAME_MATCH_KM
        return Location(
            lat,
            lon,
            geo.place_name if named else None,
            geo.country_code if named else None,
            FEED_POINT_CONFIDENCE,
        )
    if geo is None:
        return None
    return Location(geo.lat, geo.lon, geo.place_name, geo.country_code, geo.confidence)


class Pipeline:
    def __init__(self, store: NewsStore, geoparser: GeoParser) -> None:
        self._store = store
        self._geo = geoparser
        self._index = DedupeIndex()
        self._lock = threading.Lock()

    def warm(self, now: int) -> int:
        """Load the last 48 h of stories so clustering survives a restart."""
        with self._lock:
            for row in self._store.recent_for_dedupe(now - WINDOW_SECONDS):
                confident = (row["geo_confidence"] or 0) >= ON_GLOBE_CONFIDENCE
                self._index.add(
                    row["id"],
                    row["title"],
                    row["first_seen_at"],
                    set((row["feed_ids"] or "").split()),
                    country_code=row["country_code"] if confident else None,
                    lat=row["lat"] if confident else None,
                    lon=row["lon"] if confident else None,
                )
            return len(self._index)

    def process(self, feed: FeedInfo, items: list[RawItem], now: int) -> list[dict[str, Any]]:
        """Store what is new. Returns events: {"type": "story"|"story_update", "id": n}."""
        with self._lock:
            fresh: list[tuple[RawItem, str]] = []
            seen: set[str] = set()
            for item in items:
                key = url_hash(item.url)
                if key in seen or self._store.story_id_for_url_hash(key) is not None:
                    continue
                seen.add(key)
                fresh.append((item, key))
            if not fresh:
                return []

            geos = self._geo.parse_many((item.title, item.summary, feed.region) for item, _ in fresh)
            self._index.prune(now)
            events: list[dict[str, Any]] = []
            for (item, key), geo in zip(fresh, geos, strict=True):
                location = locate(item, geo)
                on_globe = location is not None and location.confidence >= ON_GLOBE_CONFIDENCE
                source = SourceRow(
                    feed.id, item.source_name, item.url, key, item.title, item.published_at, now
                )
                candidate = Candidate(
                    item.title,
                    feed.id,
                    now,
                    location.country_code if on_globe else None,
                    location.lat if on_globe else None,
                    location.lon if on_globe else None,
                )
                match = self._index.match(candidate)
                if match is not None and self._store.add_source(match, source, now=now):
                    self._index.add_feed(match, feed.id)
                    events.append({"type": "story_update", "id": match})
                    continue

                labels = classify(item.title, item.summary, feed.category)
                story_id = self._store.insert_story(
                    StoryRow(
                        title=item.title,
                        summary=item.summary,
                        url=item.url,
                        url_hash=key,
                        published_at=item.published_at,
                        first_seen_at=now,
                        category=labels.category,
                        severity=labels.severity,
                        lat=location.lat if location else None,
                        lon=location.lon if location else None,
                        geo_confidence=location.confidence if location else None,
                        place_name=location.place_name if location else None,
                        country_code=location.country_code if location else None,
                    ),
                    source,
                )
                self._index.add(
                    story_id,
                    item.title,
                    now,
                    {feed.id},
                    country_code=candidate.country_code,
                    lat=candidate.lat,
                    lon=candidate.lon,
                )
                events.append({"type": "story", "id": story_id})
            return events
