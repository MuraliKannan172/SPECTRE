"""Turn raw feed fields into safe, plain, comparable values."""

from __future__ import annotations

import hashlib
import html
import re
from html.parser import HTMLParser
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

SUMMARY_MAX = 400
TITLE_MAX = 300

_TRACKING_KEYS = frozenset(
    {
        "fbclid",
        "gclid",
        "dclid",
        "msclkid",
        "igshid",
        "mc_cid",
        "mc_eid",
        "ocid",
        "cmpid",
        "cmp",
        "at_medium",
        "at_campaign",
        "at_link",
        "at_ptr_name",
        "ns_mchannel",
        "ns_source",
        "ns_campaign",
        "ns_linkname",
        "ns_fee",
        "rss",
        "from_rss",
        "feed",
    }
)
_TRACKING_PREFIXES = ("utm_", "at_custom")
_WHITESPACE = re.compile(r"\s+")
_WORDPRESS_FOOTER = re.compile(r"\s*The post .{1,300}? appeared first on .{1,200}?\.?\s*$", re.S)
_READ_MORE = re.compile(
    r"\s*(\[(?:…|\.\.\.)\]|(?:Read|Continue reading) (?:more|the full story)\W*)\s*$", re.I
)


class _TextExtractor(HTMLParser):
    _SKIP = frozenset({"script", "style", "noscript", "iframe", "svg"})
    _BREAK = frozenset({"p", "br", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6"})

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skip_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in self._SKIP:
            self._skip_depth += 1
        elif tag in self._BREAK:
            self.parts.append(" ")

    def handle_endtag(self, tag: str) -> None:
        if tag in self._SKIP and self._skip_depth:
            self._skip_depth -= 1
        elif tag in self._BREAK:
            self.parts.append(" ")

    def handle_data(self, data: str) -> None:
        if not self._skip_depth:
            self.parts.append(data)


def plain_text(value: str | None) -> str:
    """HTML or entity-laden feed text to one line of plain text."""
    if not value:
        return ""
    extractor = _TextExtractor()
    try:
        extractor.feed(value)
        extractor.close()
        text = "".join(extractor.parts)
    except Exception:  # malformed markup: fall back to the escaped-entity text
        text = re.sub(r"<[^>]*>", " ", value)
    return _WHITESPACE.sub(" ", html.unescape(text)).strip()


def _truncate(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    cut = text[: limit - 1]
    space = cut.rfind(" ")
    if space > limit * 0.6:
        cut = cut[:space]
    return cut.rstrip(" ,;:-") + "…"


def clean_title(value: str | None) -> str:
    return _truncate(plain_text(value), TITLE_MAX)


def clean_summary(value: str | None, title: str = "") -> str:
    """A short plain-text summary; never an article body."""
    text = plain_text(value)
    text = _WORDPRESS_FOOTER.sub("", text)
    text = _READ_MORE.sub("", text).strip()
    if title and text.casefold() == title.casefold():
        return ""
    return _truncate(text, SUMMARY_MAX)


def safe_link(value: str | None) -> str | None:
    """Only absolute http(s) links survive: anything else is unsafe to render."""
    if not value:
        return None
    value = value.strip()
    try:
        parts = urlsplit(value)
    except ValueError:
        return None
    if parts.scheme.lower() not in ("http", "https") or not parts.hostname:
        return None
    if any(ch in value for ch in "\r\n\t\x00 \"'<>`"):
        return None
    return value


def canonical_url(url: str) -> str:
    """Comparable form of a link: scheme-less, tracking- and AMP-free."""
    parts = urlsplit(url.strip())
    host = (parts.hostname or "").lower().rstrip(".")
    path = parts.path or "/"

    # Google's AMP cache: https://cdn.ampproject.org/c/s/example.com/a/b
    if host.endswith(".cdn.ampproject.org") or host == "cdn.ampproject.org":
        match = re.match(r"^/(?:[a-z]/)+(?:s/)?([^/]+)(/.*)?$", path)
        if match:
            host, path = match.group(1).lower(), match.group(2) or "/"

    for prefix in ("www.", "amp.", "m."):
        if host.startswith(prefix) and host.count(".") >= 2:
            host = host[len(prefix) :]
    port = parts.port
    if port and port not in (80, 443):
        host = f"{host}:{port}"

    path = re.sub(r"(/amp/?|\.amp|/amp\.html)$", "", path, flags=re.I) or "/"
    if len(path) > 1:
        path = path.rstrip("/")

    query = [
        (key, value)
        for key, value in parse_qsl(parts.query, keep_blank_values=True)
        if key.lower() not in _TRACKING_KEYS
        and not key.lower().startswith(_TRACKING_PREFIXES)
        and key.lower() != "amp"
    ]
    return urlunsplit(("", host, path, urlencode(sorted(query)), "")).lstrip("/")


def url_hash(url: str) -> str:
    # A dedupe key, not a security boundary.
    return hashlib.sha1(canonical_url(url).encode("utf-8"), usedforsecurity=False).hexdigest()
