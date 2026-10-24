"""Cluster near-duplicate reports from different outlets into one story.

Exact duplicates are caught earlier by canonical-URL hash. This index catches
the same event reported by several outlets: rapidfuzz token_set_ratio >= 88
on normalised titles within a 48 h window, with guards against the ways
token_set_ratio over-matches:

- both titles need at least 4 content words (short titles match anything);
- one outlet's items never cluster with each other (a story is a set of
  outlets; a feed's own follow-ups stay separate);
- two located items in different countries, or more than 500 km apart, are
  different events however alike the wording ("Floods hit X" / "Floods hit Y").
"""

from __future__ import annotations

import math
import re
import unicodedata
from dataclasses import dataclass, field

from rapidfuzz import fuzz, process

WINDOW_SECONDS = 48 * 3600
TITLE_THRESHOLD = 88
MIN_WORDS = 4
MAX_APART_KM = 500.0

_STOPWORDS = frozenset(
    "a an the of in on at to for from by with and or as is are was were be been "
    "after over into amid says said new its it this that".split()
)
_OUTLET_SUFFIX = re.compile(r"\s+[-–—|:]\s+[^-–—|:]{2,40}$")
_NON_WORD = re.compile(r"[^\w\s]", re.UNICODE)


def normalise_title(title: str) -> str:
    """Lowercase ASCII words with the trailing "- Outlet Name" removed."""
    text = _OUTLET_SUFFIX.sub("", title.strip())
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    text = _NON_WORD.sub(" ", text.lower())
    return " ".join(text.split())


def content_words(normalised: str) -> list[str]:
    return [word for word in normalised.split() if word not in _STOPWORDS]


@dataclass
class _Entry:
    story_id: int
    title: str
    first_seen_at: int
    feed_ids: set[str] = field(default_factory=set)
    country_code: str | None = None
    lat: float | None = None
    lon: float | None = None


@dataclass(frozen=True)
class Candidate:
    """What the index needs to know about an incoming item."""

    title: str
    feed_id: str
    seen_at: int
    country_code: str | None = None
    lat: float | None = None
    lon: float | None = None


def _km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371.0 * math.asin(math.sqrt(a))


class DedupeIndex:
    def __init__(self) -> None:
        self._entries: dict[int, _Entry] = {}

    def __len__(self) -> int:
        return len(self._entries)

    def add(
        self,
        story_id: int,
        title: str,
        first_seen_at: int,
        feed_ids: set[str] | None = None,
        *,
        country_code: str | None = None,
        lat: float | None = None,
        lon: float | None = None,
    ) -> None:
        self._entries[story_id] = _Entry(
            story_id,
            normalise_title(title),
            first_seen_at,
            set(feed_ids or ()),
            country_code,
            lat,
            lon,
        )

    def add_feed(self, story_id: int, feed_id: str) -> None:
        entry = self._entries.get(story_id)
        if entry:
            entry.feed_ids.add(feed_id)

    def prune(self, now: int) -> None:
        cutoff = now - WINDOW_SECONDS
        for story_id in [k for k, e in self._entries.items() if e.first_seen_at < cutoff]:
            del self._entries[story_id]

    def match(self, item: Candidate) -> int | None:
        """The story this item reports, or None if it is a new story."""
        title = normalise_title(item.title)
        if len(content_words(title)) < MIN_WORDS:
            return None
        cutoff = item.seen_at - WINDOW_SECONDS
        pool = {
            story_id: entry.title
            for story_id, entry in self._entries.items()
            if entry.first_seen_at >= cutoff and item.feed_id not in entry.feed_ids
        }
        if not pool:
            return None
        hits = process.extract(
            title,
            pool,
            scorer=fuzz.token_set_ratio,
            score_cutoff=TITLE_THRESHOLD,
            limit=5,
        )
        for _, _score, story_id in sorted(hits, key=lambda hit: (-hit[1], hit[2])):
            entry = self._entries[story_id]
            if len(content_words(entry.title)) < MIN_WORDS:
                continue
            if self._places_conflict(entry, item):
                continue
            return story_id
        return None

    @staticmethod
    def _places_conflict(entry: _Entry, item: Candidate) -> bool:
        if entry.country_code and item.country_code and entry.country_code != item.country_code:
            return True
        if None not in (entry.lat, entry.lon, item.lat, item.lon):
            return _km(entry.lat, entry.lon, item.lat, item.lon) > MAX_APART_KM
        return False
