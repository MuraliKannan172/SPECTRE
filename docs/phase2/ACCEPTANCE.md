# Phase 2 acceptance: intel service

Run on 2026-10-24/25 (UTC 18:39–18:49) on the development machine: Windows 11, Python 3.12.11 via uv 0.11.6. Every result below comes from a command that was actually run.

## 1. Tests

| Command (PowerShell, repo root) | Result |
|---|---|
| `uv run --project intel pytest intel/tests` | **48 passed**. Covers migrations, store and FTS, normalisation, classifier, dedupe, geoparse, feed config, polling, health, API and SSE. |
| `uv run ruff check .`, `uv run ruff format --check .` (in `intel/`) | Both clean. |
| `npm test` | 8,144 tests: 8,132 pass, 10 skipped, 2 fail. Both failures are the known environmental ones (`skyAssets.paintOut` and `terrainHeightsBounds`; see CLAUDE.md), so the baseline is unchanged. |
| `npm run check:boundaries`, `npm run format:check` | Both pass. |
| `npm run dev` with `intel/` and its venv present | The app boots: title SKYNET, 30 layers, no server errors. The watcher ignores `intel/.venv`, `intel/data` and `.skynet-logs`. |

## 2. Feeds

`uv run --project intel python intel/scripts/verify_feeds.py` → [feed-verification.md](feed-verification.md).

- **RSS and Atom:** all 38 shipped sources pass (HTTP 200, a parse, at least one item, newest item under 90 days old).
- **Dropped:** 9 candidates failed and sit under `dropped:` in `intel/feeds.default.yaml`; they are not polled. Five returned 403 to a non-browser User-Agent (CISA ×2, NIH, State Department, JPL); two returned a 202 bot challenge (ReliefWeb ×2); one had no items (PTWC); one does not parse (NASA Earth Observatory).
- **GDELT: all 4 queries fail with HTTP 429** for User-Agent `SKYNET-intel/0.1`, including on the very first request and again after waiting four minutes. A diagnostic request with httpx's default User-Agent got 200. I did not try further User-Agents: that would be working around a block. GDELT stays configured, as decided in Q5. While the 429s continue, health shows `http_429` and backoff slows retries to at most once an hour per query. This is open; see the Phase 2 report.

## 3. Network on: new items within one poll interval

Setup:
- `SKYNET_INTEL_POLL_SECONDS=120`, scratch database;
- the 11 `terms: open` feeds plus one local fixture feed (`http://127.0.0.1:8765/feed.xml`) added through `SKYNET_INTEL_FEEDS_LOCAL`.

After the first cycle, health showed:
- `freshness.state = live`;
- 115 stories, 67 of them placed on the globe;
- 11 feeds `ok`, 27 `disabled_noncommercial`, and 4 GDELT queries `error` (`http_429`).

An SSE client stayed connected while one item was appended to the fixture feed:

```
stream 200 text/event-stream; charset=utf-8
18:42:41Z ready latest_id=116 state=live
appended fixture item at 18:42:46Z
18:42:56Z heartbeat … (every 15 s)
18:44:33Z story #117 [disaster/1] 'Fixture update: flooding reported in Porto, Portugal' src=local-fixture loc=Porto/PT/0.833
FIXTURE ARRIVED 108 s after the append (poll interval 120 s)
```

No shipped feed published a new item during that 113 s window. They are slow government and press-office feeds.

## 4. Network off: cached items served, flagged stale

The same database was used with `HTTPS_PROXY=HTTP_PROXY=http://127.0.0.1:9` (a dead local port), so every fetch fails inside the process. The Windows network was not touched. `SKYNET_INTEL_POLL_SECONDS=60`.

| When | `freshness` (health and `/news` agree) | `/news` | Feed errors |
|---|---|---|---|
| +30 s | `state: offline`, `offline: true`, `stale: false`, `age_seconds: 127` | 3 cached items served | 11 `connect_error`, 4 `http_429` (left from the online run) |
| +210 s | `state: offline`, `offline: true`, **`stale: true`**, `age_seconds: 307` | 3 cached items served | 15 `connect_error` |

`updated_at` (18:43:59Z) came from the online run in an earlier process. The "updated X min ago" time survives a restart.

## 5. Geoparser quality

- **Fixture:** `intel/scripts/geo_eval.py` on 39 hand-labelled headlines gives precision **1.0** (33 of 33 placed are correct) and recall **0.917**. The same fixture was used for tuning, so it is not independent.
- **Held-out check:** 30 placed stories were sampled at random (seed 7) from the live run and judged by hand. Nine of them are USGS items that carry the feed's own coordinates, so they do not test the geoparser. The figures below cover only the **21 text-geoparsed items**.
  - **First pass, all 21 placed:** 13 at the event or subject, 2 at the issuing government's country, 5 debatable (three press-release datelines and two "UK" items resolved to England) and 1 wrong.
  - **Fixes:** the "UK" alias had gone to England's constituent-country entry instead of the United Kingdom, and a place followed by a comma and a date is now treated as a dateline. The same 21 were re-scored.
  - **After the fixes, 17 are still placed:** 13 at the event or subject, 2 at the issuing government's country (United Kingdom), 1 debatable (a UK–France exercise placed in the UK) and 1 wrong (a UK statement on trafficking placed in the UK, its speaker).
  - **Withheld (4):** the three Brussels datelines, correctly, and one Prague speech whose dateline was also the venue (a recall loss).

## 6. GDELT and the app's existing headline path

The app's Phase 1 regional brief also uses GDELT for headlines when Non-commercial sources is off. That is the default, with User-Agent `SKYNET-regional-news/0.1`.

One normal request, `GET /api/regional-brief?latitude=51.507&longitude=-0.128` on the dev server, returned `newsStatus: "unavailable"` with no articles. The provider swallows the upstream error, so the status code was not logged.

What was observed: on 2026-10-24, GDELT requests from this machine failed for both SKYNET components. The cause is not established.
