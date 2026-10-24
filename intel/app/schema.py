"""API shapes: stories, feed health and freshness.

States and errors are machine codes (live, stale, offline, starting,
disabled_noncommercial, http_503, ...) so the UI can translate them.
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Iterable
from typing import Any

from .geo.geoparse import ON_GLOBE_CONFIDENCE


def iso(timestamp: int | None) -> str | None:
    if timestamp is None:
        return None
    return dt.datetime.fromtimestamp(timestamp, dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def story(row: dict[str, Any]) -> dict[str, Any]:
    location = None
    if row.get("lat") is not None and row.get("lon") is not None:
        confidence = row.get("geo_confidence") or 0.0
        location = {
            "lat": row["lat"],
            "lon": row["lon"],
            "place_name": row.get("place_name"),
            "country_code": row.get("country_code"),
            "confidence": confidence,
            "on_globe": confidence >= ON_GLOBE_CONFIDENCE,
        }
    return {
        "id": row["id"],
        "title": row["title"],
        "summary": row["summary"],
        "url": row["url"],
        "published_at": iso(row["published_at"]),
        "first_seen_at": iso(row["first_seen_at"]),
        "updated_at": iso(row["updated_at"]),
        "category": row["category"],
        "severity": row["severity"],
        "location": location,
        "source_count": row["source_count"],
        "sources": [
            {
                "name": source["source_name"],
                "url": source["url"],
                "feed_id": source["feed_id"],
                "published_at": iso(source["published_at"]),
            }
            for source in row.get("sources", [])
        ],
    }


def feed_state(feed: dict[str, Any], *, noncommercial: bool, gdelt_enabled: bool) -> str:
    if not feed["enabled"] or (feed["kind"] == "gdelt" and not gdelt_enabled):
        return "disabled"
    if feed["terms"] == "personal" and not noncommercial:
        return "disabled_noncommercial"
    if feed["last_attempt_at"] is None:
        return "pending"
    return "error" if feed["consecutive_errors"] else "ok"


def feed_health(feed: dict[str, Any], state: str) -> dict[str, Any]:
    return {
        "id": feed["id"],
        "name": feed["name"],
        "url": feed["url"],
        "kind": feed["kind"],
        "category": feed["category"],
        "region": feed["region"],
        "terms": feed["terms"],
        "terms_note": feed["terms_note"],
        "state": state,
        "last_attempt_at": iso(feed["last_attempt_at"]),
        "last_success_at": iso(feed["last_success_at"]),
        "last_status": feed["last_status"],
        "last_error": feed["last_error"],
        "consecutive_errors": feed["consecutive_errors"],
        "next_poll_at": iso(feed["next_poll_at"]),
        "item_count": feed["item_count"],
    }


def freshness(
    feeds: Iterable[tuple[dict[str, Any], str]],
    *,
    now: int,
    started_at: int,
    poll_seconds: int,
) -> dict[str, Any]:
    """live / stale / offline / starting, from the active feeds' poll health.

    stale: the newest successful poll of any active feed is older than three
    poll intervals. offline: every active feed that has been tried is failing
    right now. The two are independent; `state` reports the more severe.
    """
    stale_after = 3 * poll_seconds
    active = [feed for feed, state in feeds if state in ("ok", "error", "pending")]
    successes = [feed["last_success_at"] for feed in active if feed["last_success_at"]]
    updated_at = max(successes) if successes else None
    tried = [feed for feed in active if feed["last_attempt_at"] is not None]
    offline = bool(tried) and all(feed["consecutive_errors"] for feed in tried)
    if updated_at is None:
        stale = now - started_at > stale_after
    else:
        stale = now - updated_at > stale_after
    if not active:
        state = "no_sources"
    elif offline:
        state = "offline"
    elif stale:
        state = "stale"
    elif updated_at is None:
        state = "starting"
    else:
        state = "live"
    return {
        "state": state,
        "stale": stale,
        "offline": offline,
        "updated_at": iso(updated_at),
        "age_seconds": None if updated_at is None else max(0, now - updated_at),
        "poll_seconds": poll_seconds,
        "stale_after_seconds": stale_after,
    }
