"""Builders for ingest and API tests: settings, feed files, canned responses."""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path

import httpx
from keyring.backend import KeyringBackend
from keyring.errors import PasswordDeleteError

from app.config import Settings


class MemoryKeyring(KeyringBackend):
    """A keyring in a dict: tests never touch the OS credential store."""

    priority = 1  # type: ignore[assignment]

    def __init__(self) -> None:
        super().__init__()
        self.values: dict[tuple[str, str], str] = {}

    def get_password(self, service: str, username: str) -> str | None:
        return self.values.get((service, username))

    def set_password(self, service: str, username: str, password: str) -> None:
        self.values[(service, username)] = password

    def delete_password(self, service: str, username: str) -> None:
        if self.values.pop((service, username), None) is None:
            raise PasswordDeleteError(username)


def make_settings(tmp_path: Path, feeds_yaml: str, **overrides: object) -> Settings:
    feeds = tmp_path / "feeds.yaml"
    feeds.write_text(feeds_yaml, encoding="utf-8")
    fields: dict[str, object] = dict(
        db_path=tmp_path / "intel.db",
        feeds_default=feeds,
        feeds_local=tmp_path / "feeds.local.yaml",
        env_file=tmp_path / ".env",
        poll_seconds=300,
        voice_dir=tmp_path / "voice",  # never intel/data/voice: no real models in tests
    )
    fields.update(overrides)
    return Settings(**fields)  # type: ignore[arg-type]


FEEDS_YAML = """
feeds:
  - id: alpha
    name: Alpha Wire
    url: https://alpha.example/rss
    category: world
    region: world
    terms: open
  - id: beta
    name: Beta News
    url: https://beta.example/atom
    category: world
    region: africa
    terms: open
  - id: gamma
    name: Gamma Daily
    url: https://gamma.example/rss
    category: world
    terms: personal
    terms_note: Publisher RSS terms say personal use only.
gdelt:
  enabled: true
  terms_note: GDELT Project; citation required.
  queries:
    - id: gdelt-disasters
      name: GDELT disasters
      category: disaster
      query: earthquake sourcelang:english
"""


def rss(*items: tuple[str, str, str], extra: str = "") -> bytes:
    """items: (title, link, description) in an RSS 2.0 channel."""
    body = "".join(
        f"<item><title>{t}</title><link>{link}</link><description><![CDATA[{d}]]></description>"
        f"<pubDate>Sat, 24 Oct 2026 10:00:00 GMT</pubDate></item>"
        for t, link, d in items
    )
    return (
        '<?xml version="1.0"?><rss version="2.0" xmlns:georss="http://www.georss.org/georss">'
        f"<channel><title>Feed</title>{body}{extra}</channel></rss>"
    ).encode()


def gdelt(*articles: tuple[str, str, str]) -> bytes:
    """articles: (title, url, domain)."""
    return json.dumps(
        {
            "articles": [
                {"url": u, "title": t, "seendate": "20261024T100000Z", "domain": d, "language": "English"}
                for t, u, d in articles
            ]
        }
    ).encode()


Responder = Callable[[httpx.Request], httpx.Response]


class Routes:
    """A MockTransport keyed by host, recording every request it serves."""

    def __init__(self) -> None:
        self.handlers: dict[str, Responder] = {}
        self.requests: list[httpx.Request] = []

    def on(self, host: str, handler: Responder | httpx.Response) -> None:
        self.handlers[host] = handler if callable(handler) else (lambda _r, resp=handler: resp)

    def transport(self) -> httpx.MockTransport:
        def handle(request: httpx.Request) -> httpx.Response:
            self.requests.append(request)
            handler = self.handlers.get(request.url.host)
            if handler is None:
                raise httpx.ConnectError("no route", request=request)
            return handler(request)

        return httpx.MockTransport(handle)
