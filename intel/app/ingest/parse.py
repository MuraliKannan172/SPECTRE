"""RSS/Atom and GDELT DOC 2.0 responses to plain, safe news items."""

from __future__ import annotations

import calendar
import datetime as dt
import json
import math
from dataclasses import dataclass
from typing import Any

import feedparser

from .normalize import clean_summary, clean_title, safe_link

FUTURE_SLACK_SECONDS = 600


class FeedParseError(ValueError):
    pass


@dataclass(frozen=True)
class RawItem:
    title: str
    url: str
    summary: str
    published_at: int
    source_name: str
    point: tuple[float, float] | None = None  # (lat, lon) the feed itself supplies


def _valid_point(lat: Any, lon: Any) -> tuple[float, float] | None:
    try:
        lat, lon = float(lat), float(lon)
    except (TypeError, ValueError):
        return None
    if not (math.isfinite(lat) and math.isfinite(lon)) or not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None
    if lat == 0 and lon == 0:
        return None
    return round(lat, 4), round(lon, 4)


def _entry_point(entry: Any) -> tuple[float, float] | None:
    where = entry.get("where")
    if isinstance(where, dict) and where.get("type") == "Point":
        coordinates = where.get("coordinates") or ()
        if len(coordinates) >= 2:
            return _valid_point(coordinates[1], coordinates[0])
    georss = entry.get("georss_point")
    if isinstance(georss, str) and len(georss.split()) == 2:
        lat, lon = georss.split()
        return _valid_point(lat, lon)
    if entry.get("geo_lat") and entry.get("geo_long"):
        return _valid_point(entry.get("geo_lat"), entry.get("geo_long"))
    return None


def _timestamp(entry: Any, now: int) -> int:
    for key in ("published_parsed", "updated_parsed", "created_parsed"):
        parsed = entry.get(key)
        if parsed:
            try:
                return min(calendar.timegm(parsed), now)
            except (TypeError, ValueError, OverflowError):
                continue
    return now


def parse_feed(body: bytes, *, source_name: str, now: int, oldest: int) -> list[RawItem]:
    """Items newer than `oldest` with a title and an http(s) link."""
    parsed = feedparser.parse(body)
    if not parsed.entries:
        if parsed.get("bozo") or not parsed.get("feed"):
            raise FeedParseError("parse_error")
        return []
    items = []
    for entry in parsed.entries:
        title = clean_title(entry.get("title"))
        link = safe_link(entry.get("link"))
        if not title or not link:
            continue
        published = _timestamp(entry, now)
        if published > now + FUTURE_SLACK_SECONDS:
            published = now
        if published < oldest:
            continue
        summary = clean_summary(entry.get("summary") or entry.get("description"), title)
        items.append(RawItem(title, link, summary, published, source_name, _entry_point(entry)))
    return items


GDELT_DOC_URL = "https://api.gdeltproject.org/api/v2/doc/doc"


def gdelt_params(query: str, timespan_minutes: int, max_records: int = 75) -> dict[str, str]:
    return {
        "query": query,
        "mode": "artlist",
        "format": "json",
        "sort": "datedesc",
        "maxrecords": str(max_records),
        "timespan": f"{max(15, timespan_minutes)}min",
    }


def parse_gdelt(body: bytes, *, now: int, oldest: int) -> list[RawItem]:
    """GDELT ArtList JSON: headline, link, outlet domain and time; no summary."""
    text = body.decode("utf-8", "replace").strip()
    if not text:
        return []
    try:
        data = json.loads(text)
    except json.JSONDecodeError as error:
        raise FeedParseError("parse_error") from error
    if not isinstance(data, dict):
        raise FeedParseError("parse_error")
    items = []
    for article in data.get("articles") or []:
        if not isinstance(article, dict):
            continue
        title = clean_title(article.get("title"))
        link = safe_link(article.get("url"))
        if not title or not link:
            continue
        try:
            seen = dt.datetime.strptime(str(article.get("seendate")), "%Y%m%dT%H%M%SZ")
            published = min(calendar.timegm(seen.timetuple()), now)
        except ValueError:
            published = now
        if published < oldest:
            continue
        items.append(RawItem(title, link, "", published, str(article.get("domain") or "GDELT")))
    return items
