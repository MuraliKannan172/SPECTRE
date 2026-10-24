"""Check every shipped source: HTTP 200, parses, has items, is not dead.

A feed passes when it answers 200 (after redirects), parses, yields at least
one usable item (title plus http(s) link), and its newest item is under
MAX_AGE_DAYS old. A feed that parses but has not published for months is
dead and fails too. GDELT queries pass on 200, valid JSON and one article.

Run from the repository root (PowerShell):
    uv run --project intel python intel/scripts/verify_feeds.py
It writes docs/phase2/feed-verification.md and exits 1 if any source fails.
"""

from __future__ import annotations

import argparse
import datetime as dt
import sys
import time
from pathlib import Path

import httpx
import yaml

INTEL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(INTEL))

from app.config import load_settings  # noqa: E402
from app.ingest.feeds import load_feed_config  # noqa: E402
from app.ingest.parse import FeedParseError, gdelt_params, parse_feed, parse_gdelt  # noqa: E402

MAX_AGE_DAYS = 90
GDELT_SPACING = 20  # well above GDELT's one-request-per-five-seconds limit
REPORT = INTEL.parent / "docs" / "phase2" / "feed-verification.md"


def check(client: httpx.Client, url: str, params: dict[str, str] | None, kind: str, name: str) -> dict:
    now = int(time.time())
    started = time.perf_counter()
    try:
        response = client.get(url, params=params)
    except httpx.HTTPError as error:
        return {"ok": False, "status": None, "reason": type(error).__name__, "items": 0, "newest": None}
    elapsed = round(time.perf_counter() - started, 2)
    result = {"status": response.status_code, "seconds": elapsed, "items": 0, "newest": None}
    if response.status_code != 200:
        return {**result, "ok": False, "reason": f"HTTP {response.status_code}"}
    try:
        if kind == "gdelt":
            items = parse_gdelt(response.content, now=now, oldest=0)
        else:
            items = parse_feed(response.content, source_name=name, now=now, oldest=0)
    except FeedParseError:
        return {**result, "ok": False, "reason": "does not parse"}
    if not items:
        return {**result, "ok": False, "reason": "no usable items"}
    newest = max(item.published_at for item in items)
    age_days = (now - newest) / 86400
    result.update(items=len(items), newest=newest)
    if age_days > MAX_AGE_DAYS:
        return {**result, "ok": False, "reason": f"newest item {age_days:.0f} days old"}
    return {**result, "ok": True, "reason": ""}


def main() -> int:
    args = argparse.ArgumentParser()
    args.add_argument("--report", type=Path, default=REPORT)
    report_path = args.parse_args().report
    settings = load_settings()
    config = load_feed_config(settings.feeds_default)
    dropped = yaml.safe_load(settings.feeds_default.read_text(encoding="utf-8")).get("dropped") or []
    rows = []
    dropped_rows = []
    with httpx.Client(
        follow_redirects=True,
        max_redirects=5,
        timeout=httpx.Timeout(20.0),
        headers={"User-Agent": settings.user_agent},
    ) as client:
        for feed in config.feeds:
            outcome = check(client, feed.url, None, "rss", feed.name)
            rows.append((feed.id, feed.terms, feed.url, outcome))
            verdict = "PASS" if outcome["ok"] else "FAIL"
            print(f"{verdict} {feed.id:28} {outcome.get('status')} {outcome['reason']}")
        for query in config.gdelt_queries:
            outcome = check(
                client,
                "https://api.gdeltproject.org/api/v2/doc/doc",
                gdelt_params(query.query, 60, 25),
                "gdelt",
                "",
            )
            rows.append((query.id, "open", f"GDELT DOC 2.0: {query.query}", outcome))
            verdict = "PASS" if outcome["ok"] else "FAIL"
            print(f"{verdict} {query.id:28} {outcome.get('status')} {outcome['reason']}")
            time.sleep(GDELT_SPACING)
        for entry in dropped:
            outcome = check(client, entry["url"], None, "rss", entry["name"])
            dropped_rows.append((entry["id"], entry.get("reason", ""), outcome))
            print(f"(dropped) {'PASS' if outcome['ok'] else 'FAIL'} {entry['id']:28} {outcome['reason']}")

    when = dt.datetime.now(dt.UTC).strftime("%Y-%m-%d %H:%M UTC")
    passed = sum(1 for *_, outcome in rows if outcome["ok"])
    lines = [
        "# Feed verification",
        "",
        f"Run {when} by `intel/scripts/verify_feeds.py` from this machine"
        f" with User-Agent `{settings.user_agent}`: {passed} of {len(rows)} sources pass.",
        "A source passes on HTTP 200, a parse, at least one item,"
        f" and a newest item under {MAX_AGE_DAYS} days old.",
        "",
        "| Source | Terms | Result | HTTP | Items | Newest item | Reason |",
        "|---|---|---|---|---|---|---|",
    ]
    for feed_id, terms, _url, outcome in rows:
        newest = (
            dt.datetime.fromtimestamp(outcome["newest"], dt.UTC).strftime("%Y-%m-%d")
            if outcome["newest"]
            else ""
        )
        verdict = "pass" if outcome["ok"] else "**fail**"
        lines.append(
            f"| `{feed_id}` | {terms} | {verdict} | {outcome.get('status') or ''}"
            f" | {outcome['items']} | {newest} | {outcome['reason']} |"
        )
    if dropped_rows:
        lines += [
            "",
            "## Dropped candidates (not polled)",
            "",
            "| Source | Why it was dropped | Result now | HTTP |",
            "|---|---|---|---|",
        ]
        for feed_id, reason, outcome in dropped_rows:
            now_result = "pass: can be restored" if outcome["ok"] else f"fail: {outcome['reason']}"
            lines.append(f"| `{feed_id}` | {reason} | {now_result} | {outcome.get('status') or ''} |")
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"{passed}/{len(rows)} pass; report: {report_path}")
    return 0 if passed == len(rows) else 1


if __name__ == "__main__":
    raise SystemExit(main())
