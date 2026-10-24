# Intel service API

The intel service (`intel/`, FastAPI) ingests news and serves it to the app. It listens on `127.0.0.1:8100` only. From Phase 3 the app's dev server proxies `/api/intel/*` to it, so the browser stays same-origin.

- **Start it:** run `.\scripts\skynet.ps1` in PowerShell from the repository root.
- **Live schema:** OpenAPI at `/api/intel/openapi.json`, interactive docs at `/api/intel/docs`. This page explains the parts a schema can't: states, codes and stream semantics.
- **Host header:** requests must name `127.0.0.1`, `localhost` or `[::1]`; anything else gets a 400. This guards against DNS rebinding. The service sends no CORS headers.

## Endpoints

### `GET /api/intel/news`

Stories, newest first. When `q` is given, the best match comes first instead.

| Parameter | Meaning |
|---|---|
| `q` | Full-text search over headline, summary and place name, up to 200 characters. Every word must match; punctuation is ignored, so no input is a syntax error. |
| `since`, `until` | ISO 8601 times, filtering on the publication time. A time without an offset is taken as UTC. |
| `category` | Comma-separated: `disaster`, `conflict`, `cyber`, `health`, `space`, `science`, `economy`, `politics`, `world`. |
| `region` | The feed region: `world`, `africa`, `americas`, `asia-pacific`, `europe`, `middle-east`. |
| `source` | Comma-separated feed ids or outlet names. |
| `bbox` | `west,south,east,north` in degrees. If `west > east`, the box crosses the antimeridian. Only items placed on the globe are returned. |
| `located` | `true`: only items placed on the globe. |
| `limit` | 1–200, default 50. |
| `cursor` | The `next_cursor` from the previous page. |

The response looks like this:

```json
{
  "items": [Story, ...],
  "next_cursor": "eyJwIjox..." ,
  "freshness": Freshness
}
```

Bad parameters return `422` with `{"detail": {"code": "bad_bbox" | "bad_time" | "bad_category" | "bad_cursor", ...}}`.

### `GET /api/intel/news/{id}`

Returns one `Story`, or `404 {"detail": {"code": "not_found"}}`.

### `GET /api/intel/news/stream`

A Server-Sent Events stream.

| Event | `id:` field | `data` |
|---|---|---|
| `story` | The story id | A new `Story`. |
| `story_update` | none | A `Story` that gained another outlet (`source_count` went up). |
| `ready` | none | `{"latest_id": n, "freshness": Freshness}`, sent once the replay (if any) is done. |
| comment `: heartbeat <time>` | none | Sent every 15 s while idle. |

- **Reconnecting:** send the last story id back in `Last-Event-ID`, or `?last_event_id=` if your client can't set headers. The stream first replays up to 500 stories added since that id, then goes live. The browser's `EventSource` does this automatically; the stream asks it to retry after 5 s.
- **Slow clients:** a client that falls 256 events behind is disconnected rather than buffered. It reconnects and replays the gap from the store.

### `GET /api/intel/health`

```json
{
  "service": "SKYNET-intel/0.1",
  "now": "...", "started_at": "...",
  "freshness": Freshness,
  "noncommercial_sources": false,
  "gdelt_enabled": true,
  "stories": 1234, "located": 870, "newest_first_seen_at": "...",
  "retention_days": 30,
  "stream_subscribers": 1,
  "geoparser": {"model": "en_core_web_sm-3.8.0", "gazetteer_entries": 40295, "on_globe_confidence": 0.6},
  "feeds": [FeedHealth, ...]
}
```

## Shapes

### Story

```json
{
  "id": 42,
  "title": "Magnitude 6.2 earthquake strikes near Hualien, Taiwan",
  "summary": "Plain text, at most 400 characters. Empty when the source gives none.",
  "url": "https://...",
  "published_at": "2026-10-24T10:00:00Z",
  "first_seen_at": "2026-10-24T10:03:12Z",
  "updated_at": "2026-10-24T10:09:40Z",
  "category": "disaster",
  "severity": 3,
  "location": {
    "lat": 23.98, "lon": 121.6, "place_name": "Hualien", "country_code": "TW",
    "confidence": 0.95, "on_globe": true
  },
  "source_count": 2,
  "sources": [{"name": "USGS significant earthquakes", "url": "https://...", "feed_id": "usgs-quakes-significant", "published_at": "..."}]
}
```

- **Links:** `url` and every source `url` are absolute `http`/`https` links. Anything else is dropped at ingest. The text fields are plain text, never HTML.
- **Stored content:** only the headline, a short summary, the source, the link and the time are kept, never the article body.
- **`severity`:** `1` routine, `2` elevated, `3` high, `4` alert. Level 4 is reserved for true alerts, such as red alerts, tsunami warnings and mass casualties.
- **`location`:** `null` when no place was found.
  - `confidence` is the geoparser's score in [0, 1].
  - Place an item on the globe only when `on_globe` is true (`confidence >= 0.6`).
  - Coordinates supplied by the feed itself (GeoRSS) score 0.95.
  - `country_code` is ISO 3166-1 alpha-2, or `null` for seas and multi-country regions.

### Freshness

```json
{
  "state": "live",
  "stale": false,
  "offline": false,
  "updated_at": "2026-10-24T10:05:00Z",
  "age_seconds": 120,
  "poll_seconds": 300,
  "stale_after_seconds": 900
}
```

`updated_at` is the newest successful poll of any active source. It is stored in the database, so it survives a restart.

| `state` | Meaning |
|---|---|
| `live` | A source succeeded within `stale_after_seconds` (3 × the poll interval). |
| `stale` | No source has succeeded for longer than that. Cached stories are still served. |
| `offline` | Every active source that has been tried is failing right now, for example with no network. Cached stories are still served. |
| `starting` | No poll has finished yet. |
| `no_sources` | Every source is disabled. |

`stale` and `offline` are also given as separate booleans; `state` reports the more severe of the two. UIs should show "updated X min ago" from `age_seconds`, and a stale badge when `stale` is true.

### FeedHealth

```json
{
  "id": "nhc-atlantic", "name": "...", "url": "...", "kind": "rss" | "gdelt",
  "category": "disaster", "region": "americas",
  "terms": "open" | "personal", "terms_note": "...",
  "state": "ok" | "error" | "pending" | "disabled" | "disabled_noncommercial",
  "last_attempt_at": "...", "last_success_at": "...", "last_status": 200,
  "last_error": null | "timeout" | "connect_error" | "proxy_error" | "network_error"
              | "too_many_redirects" | "http_<status>" | "parse_error" | "too_large",
  "consecutive_errors": 0, "next_poll_at": "...", "item_count": 25
}
```

`disabled_noncommercial` means the source's terms allow only personal use, or have not been checked. It is polled only while **Non-commercial sources** is on in Provider Settings (`SKYNET_NONCOMMERCIAL_SOURCES=1` in `.env`). The switch is re-read on every poll cycle, so no restart is needed.

## Polling

- **Interval:** every source has its own clock, polled every `SKYNET_INTEL_POLL_SECONDS` (default 300, minimum 30) with ±10% jitter. GDELT queries run every 15 minutes at most and are spaced at least 5.5 s apart.
- **Conditional requests:** feeds are fetched with `If-None-Match` / `If-Modified-Since`, and responses are capped at 5 MB.
- **Failures:** retries back off exponentially from the source's own interval (1×, 2×, 4× …, ±20%, capped at 1 hour), and `Retry-After` is honoured. A failing GDELT query therefore waits at least 15 minutes.

## Configuration (environment or `.env`)

| Variable | Default | |
|---|---|---|
| `SKYNET_INTEL_POLL_SECONDS` | `300` | Poll interval per source. |
| `SKYNET_INTEL_RETENTION_DAYS` | `30` | Stories older than this are deleted every 6 hours. |
| `SKYNET_INTEL_GDELT` | `1` | `0` switches GDELT off. |
| `SKYNET_INTEL_DB` | `intel/data/skynet.db` | SQLite file (gitignored). |
| `SKYNET_INTEL_FEEDS_LOCAL` | `intel/feeds.local.yaml` | Your own feed additions and overrides (gitignored). |
| `SKYNET_NONCOMMERCIAL_SOURCES` | off | Shared with the app's Provider Settings switch. |

`intel/feeds.local.yaml` uses the same shape as `intel/feeds.default.yaml`. Entries merge by `id`, so `- {id: bbc-world, enabled: false}` turns one off, and a new id adds a feed. `gdelt: {enabled: false}` switches GDELT off.
