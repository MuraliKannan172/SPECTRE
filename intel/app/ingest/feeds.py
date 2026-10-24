"""Feed configuration: the shipped list plus the user's local overrides.

`feeds.default.yaml` ships with the app. A gitignored `feeds.local.yaml` can
add feeds or override any field of a shipped one by id (for example
`enabled: false`), and can switch GDELT off. Invalid configuration fails at
start-up with a message naming the entry, rather than being half-applied.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import yaml

from ..store.news import FeedDef
from .classify import CATEGORY_ORDER

TERMS = ("open", "personal")
REGIONS = ("world", "africa", "americas", "asia-pacific", "europe", "middle-east")
_ID = re.compile(r"^[a-z0-9][a-z0-9-]{1,63}$")


class FeedConfigError(ValueError):
    pass


@dataclass(frozen=True)
class GdeltQuery:
    id: str
    name: str
    query: str
    category: str


@dataclass(frozen=True)
class FeedConfig:
    feeds: tuple[FeedDef, ...]
    gdelt_enabled: bool
    gdelt_queries: tuple[GdeltQuery, ...]
    gdelt_terms_note: str

    def all_defs(self) -> list[FeedDef]:
        """Every source as a feeds-table row; GDELT queries are kind 'gdelt'."""
        gdelt = [
            FeedDef(
                id=query.id,
                name=query.name,
                url="https://api.gdeltproject.org/api/v2/doc/doc",
                category=query.category,
                terms="open",
                kind="gdelt",
                region="world",
                terms_note=self.gdelt_terms_note,
                enabled=self.gdelt_enabled,
            )
            for query in self.gdelt_queries
        ]
        return [*self.feeds, *gdelt]


def _check_feed(entry: dict[str, Any], where: str) -> FeedDef:
    try:
        feed = FeedDef(
            id=str(entry["id"]),
            name=str(entry["name"]),
            url=str(entry["url"]),
            category=str(entry["category"]),
            terms=str(entry["terms"]),
            region=str(entry.get("region") or "world"),
            terms_note=entry.get("terms_note"),
            enabled=bool(entry.get("enabled", True)),
        )
    except KeyError as error:
        raise FeedConfigError(f"{where}: missing field {error}") from error
    if not _ID.match(feed.id):
        raise FeedConfigError(f"{where}: id must be lowercase letters, digits and dashes")
    parts = urlsplit(feed.url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise FeedConfigError(f"{where}: url must be an absolute http(s) URL")
    if feed.category not in CATEGORY_ORDER:
        raise FeedConfigError(f"{where}: category must be one of {', '.join(CATEGORY_ORDER)}")
    if feed.terms not in TERMS:
        raise FeedConfigError(f"{where}: terms must be 'open' or 'personal'")
    if feed.region not in REGIONS:
        raise FeedConfigError(f"{where}: region must be one of {', '.join(REGIONS)}")
    return feed


def _read_yaml(path: Path) -> dict[str, Any]:
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError as error:
        raise FeedConfigError(f"{path.name}: not valid YAML ({error})") from error
    if not isinstance(data, dict):
        raise FeedConfigError(f"{path.name}: expected a mapping at the top level")
    return data


def load_feed_config(default_path: Path, local_path: Path | None = None) -> FeedConfig:
    base = _read_yaml(default_path)
    feeds: dict[str, FeedDef] = {}
    for index, entry in enumerate(base.get("feeds") or []):
        feed = _check_feed(entry, f"{default_path.name} feeds[{index}]")
        if feed.id in feeds:
            raise FeedConfigError(f"{default_path.name}: duplicate feed id {feed.id}")
        feeds[feed.id] = feed

    gdelt = base.get("gdelt") or {}
    gdelt_enabled = bool(gdelt.get("enabled", True))
    queries = []
    for index, entry in enumerate(gdelt.get("queries") or []):
        where = f"{default_path.name} gdelt.queries[{index}]"
        try:
            query = GdeltQuery(
                str(entry["id"]), str(entry["name"]), str(entry["query"]), str(entry["category"])
            )
        except KeyError as error:
            raise FeedConfigError(f"{where}: missing field {error}") from error
        if not _ID.match(query.id) or query.category not in CATEGORY_ORDER:
            raise FeedConfigError(f"{where}: bad id or category")
        queries.append(query)

    if local_path is not None and local_path.exists():
        local = _read_yaml(local_path)
        for index, entry in enumerate(local.get("feeds") or []):
            where = f"{local_path.name} feeds[{index}]"
            if not isinstance(entry, dict) or "id" not in entry:
                raise FeedConfigError(f"{where}: every entry needs an id")
            existing = feeds.get(str(entry["id"]))
            if existing is not None:
                merged = {**existing.__dict__, **entry}
                feeds[existing.id] = _check_feed(merged, where)
            else:
                feed = _check_feed(entry, where)
                feeds[feed.id] = feed
        if "gdelt" in local and isinstance(local["gdelt"], dict) and "enabled" in local["gdelt"]:
            gdelt_enabled = bool(local["gdelt"]["enabled"])

    return FeedConfig(
        feeds=tuple(feeds.values()),
        gdelt_enabled=gdelt_enabled,
        gdelt_queries=tuple(queries),
        gdelt_terms_note=str(gdelt.get("terms_note") or ""),
    )


def with_gdelt(config: FeedConfig, enabled: bool) -> FeedConfig:
    return replace(config, gdelt_enabled=config.gdelt_enabled and enabled)
