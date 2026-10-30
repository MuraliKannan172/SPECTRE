# Intel service API

The intel service (`intel/`, FastAPI) ingests news and serves it to the app. It listens on `127.0.0.1:8100` only. From Phase 3 the app's dev server proxies `/api/intel/*` to it, so the browser stays same-origin.

- **Start it:** run `.\scripts\spectre.ps1` in PowerShell from the repository root.
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
  "service": "SPECTRE-intel/0.1",
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

## Neural Core (`/api/intel/chat`)

The app's proxy (`server/providers/intel.js`) answers these only for requests from this machine (unless `SPECTRE_CHAT_ALLOW_LAN=1`). Writes need a same-origin JSON body of at most 64 KB. The service itself refuses any request that carries an `Origin` header, so only the proxy can write to it. One turn runs at a time (`409 {"detail": {"code": "busy"}}`), at most `SPECTRE_CHAT_TURNS_PER_MINUTE` a minute (`429`).

### `POST /api/intel/chat`

Body: `{"message": "...", "conversation_id": null, "regenerate": false, "viewport": {...}, "layer_state": {...}}`. With no `conversation_id`, the current conversation continues. `regenerate: true` replaces the last answer. `viewport` and `layer_state` are injected into the system prompt and are at most 8 KB each.

The response is `text/event-stream`:

| Event | Data |
|---|---|
| `turn` | `{"turn_id", "conversation_id", "provider", "model"}` |
| `token` | `{"text"}`: the next piece of the answer |
| `tool_status` | `{"tool", "state": "start" \| "done" \| "error", "host"?, "code"?}` |
| `client_tool` | `{"turn_id", "call_id", "name", "args"}`: a globe tool for the browser to run |
| `citation` | `{"n", "url", "title", "source"}`: source `[n]` of this turn |
| `done` | `{"model", "provider", "usage": {"input", "output"}, "stop_reason", "tokens_per_s", "eval_count", "prompt_eval_count", "as_of", "citations", "degraded", "rounds", "seconds", "refused"?}` |
| `error` | `{"code", "message", "provider"?, "retryable"?}`, e.g. `ollama_offline`, `ollama_model_missing`, `stopped`, `consent_required`, `local_only`, `lan_viewer`, `auth_failed`, `rate_limited`; a rejected key's message is always "The provider rejected the key." |
| `budget` | `{"spent", "allowance", "budget"}`: the conversation reached its cloud token budget, and nothing was sent |
| `thinking` | `{"text"}`: the model's thinking when reasoning is on; shown collapsed, never stored |

At most 4 tool rounds run per turn, and the final request asks for an answer, not a call. `as_of` is set when news or web results were used. `usage` counts every round. The turn runs on the conversation's selected provider and model (`PUT /api/intel/providers/selection`); the chat body cannot change it, and a selection that cannot run is an `error`, never a switch. Before each round the request is trimmed to the model's input limit: the oldest tool results first, then the oldest history ([ADR-002](ADR-002-providers.md) D9).

### `POST /api/intel/chat/tool-result`

`{"turn_id", "call_id", "ok", "result", "error"}` for a `client_tool` call (result at most 32 KB). The turn waits 15 s before telling the model the call timed out. `204`, or `404` for an unknown call.

### `POST /api/intel/chat/stop`

`{"turn_id"}` ends that turn after the current event. `204`.

### `GET /api/intel/chat/history` and `DELETE /api/intel/chat/history`

The current conversation as `{"conversation_id", "messages": [{"role", "content", "citations", "meta", "created_at"}]}`; `DELETE` clears every conversation (`204`).

### `GET /api/intel/chat/status`

```json
{
  "model": "qwen3.5-9b-64k-gpu:latest", "num_ctx": 16384, "low_resource": false,
  "ollama": {"reachable": true, "version": "0.40.11"},
  "model_present": true, "tools": true,
  "loaded": {"size_vram": 3360948223, "size": 3360948223, "expires_at": "...", "context_length": 16384},
  "search": {"provider": "ddgs", "keyless": true, "best_effort": true, "configured": true, "problem": null, "last_ok_at": null, "last_error": null},
  "chat_problem": null
}
```

`loaded` comes from Ollama's `/api/ps` and is `null` until the first answer loads the model.

The selection adds `provider`, `provider_label`, `kind` (`local`, `remote` or `cloud`), `ready`, `problem` (for example `no_key`, `consent_required`, `local_only`, `ollama_offline`), `usage` (`{"input", "output", "cloud"}` tokens for the conversation, and `priced`: the selected model's own `{"input", "output"}`, which a price applies to) and `budget` (`{"spent", "allowance", "budget"}`, or `null` when off). An API provider is judged from local facts only: the poll never calls a cloud API.

### Chat providers (`/api/intel/providers`)

The proxy answers every route for this machine only, even with `SPECTRE_CHAT_ALLOW_LAN=1`, and refuses a `Sec-Fetch-Site` other than `same-origin` or `none`. The service itself refuses any `Origin`, and any `Sec-Fetch-Site` except `none`: the proxy forwards neither. On chat routes the proxy adds `X-Spectre-Viewer: lan` for a viewer on another machine; such a viewer never runs a cloud model (`lan_viewer`). Writes need the session token from `GET …/session` in `X-Spectre-Session`, an exact local `Origin` at the proxy, and a JSON body (`DELETE …/key` has none). No route ever returns a key.

| Route | Does |
|---|---|
| `GET /api/intel/providers` | `{"providers": [{"id", "label", "kind", "adapter", "docs", "base_url", "base_url_editable", "workspace_id", "params", "chat_completions_models", "key": {"required", "configured", "source", "env", "writable"}, "key_reaches_address", "consent"}], "policy", "keyring", "selection"}` |
| `GET /api/intel/providers/session` | `{"token"}` for writes |
| `PUT /api/intel/providers/policy` | `{"local_only"?, "map_context"?, "session_budget"?, "context_ceiling"?}`: `session_budget` in cloud tokens, `0` off; `context_ceiling` in tokens (4096 to 1048576, default 16384) for API models |
| `PUT /api/intel/providers/selection` | `{"provider", "model"}` for the current conversation and new ones |
| `PUT /api/intel/providers/{id}/key` | `{"key"}`, stored in the OS keyring (or `.env` without one); returns the `key` status |
| `DELETE /api/intel/providers/{id}/key` | removes the stored key; an environment key stays |
| `PUT /api/intel/providers/{id}/settings` | `{"base_url"?, "workspace_id"?, "chat_completions_models"?, "params"?}`; `params`: `temperature` (not for Anthropic), `max_output_tokens`, `price_in`, `price_out` (USD per 1M tokens), `reasoning` (Ollama, DeepSeek, OpenRouter, OpenAI only), and for Ollama `num_ctx`, `keep_alive` |
| `PUT /api/intel/providers/{id}/consent` | `{"granted"}` |
| `POST /api/intel/providers/{id}/test` | `{}`; `{"ok": true, ...}` or `{"ok": false, "code", "message", "retryable"}` |
| `GET /api/intel/providers/{id}/models` | `{"models": [{"id", "label", "kind", "supports_tools", "capabilities", "context_window", "details"}]}` |
| `POST /api/intel/providers/{id}/probe` | `{"model"}`: one tiny tool-calling request; `{"ok", "supports_tools"}` |
| `GET /api/intel/providers/ollama/gpu` | `{"gpu"}` from `nvidia-smi`, or `null` |
| `POST /api/intel/providers/budget/continue` | `{}`: one more budget for the current conversation; `{"allowance"}` |

Local-only mode refuses a cloud provider's test, model list and probe (`409 {"code": "local_only"}`). Provider failures are `502 {"code", "message", "retryable"}` with the codes of ADR-002 D8.

### Local voice (`/api/intel/voice`, opt-in)

Push-to-talk for the Neural Core. The routes answer this machine only and, like the chat routes, refuse any request carrying an Origin header or a cross-site fetch marker.

- `GET /api/intel/voice/status`: `{"state": "unavailable" | "idle" | "loading" | "ready" | "failed", "reason": "disabled" | "not_installed" | "models_missing" | null, "error", "stt": {"model": "whisper-base", "device": "cpu"}, "tts": {"model": "kokoro-82m", "voice", "lang"}, "speaks": ["en"]}`. The engines load once, in the background, when the service starts; until then the other routes answer `503` with `voice_loading`.
- `POST /api/intel/voice/transcribe`: the body is one recording (`audio/webm`, `audio/ogg`, `audio/wav` or `audio/mp4`, at most 2 MB and 60 s). Returns `{"text", "language", "language_probability", "audio_seconds", "speech_seconds", "seconds"}`. Silence or under 0.4 s of speech is `422 no_speech`; unreadable audio is `422 bad_audio`. Audio is never stored or logged.
- `POST /api/intel/voice/speak`: `{"text"}` (at most 1000 characters; citation numbers, markdown, links and an "As of" line are dropped first) returns `audio/wav`, with the synthesis time in `X-Voice-Seconds`. Nothing left to say is `422 nothing_to_say`.

Tool schemas live in `shared/tools/neural-core.tools.json`. `npm run tools:export` writes its client half from `src/tools/registry.js`, and `uv run --project intel python intel/scripts/export_tools.py` writes the server half.

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

`disabled_noncommercial` means the source's terms allow only personal use, or have not been checked. It is polled only while **Non-commercial sources** is on in Provider Settings (`SPECTRE_NONCOMMERCIAL_SOURCES=1` in `.env`). The switch is re-read on every poll cycle, so no restart is needed.

While the switch is off, the API also stops serving what such sources reported, including stories collected while it was on. `/news`, `/news/{id}` and the stream serve only stories whose first (primary) source is an open feed, and list only the open sources in `sources`. A hidden story answers `404`. Turning the switch back on shows them again; nothing is deleted.

## Polling

- **Interval:** every source has its own clock, polled every `SPECTRE_INTEL_POLL_SECONDS` (default 300, minimum 30) with ±10% jitter. GDELT queries run every 15 minutes at most and are spaced at least 5.5 s apart.
- **Conditional requests:** feeds are fetched with `If-None-Match` / `If-Modified-Since`, and responses are capped at 5 MB.
- **Failures:** retries back off exponentially from the source's own interval (1×, 2×, 4× …, ±20%, capped at 1 hour), and `Retry-After` is honoured. A failing GDELT query therefore waits at least 15 minutes.

## Configuration (environment or `.env`)

| Variable | Default | |
|---|---|---|
| `SPECTRE_INTEL_POLL_SECONDS` | `300` | Poll interval per source. |
| `SPECTRE_INTEL_RETENTION_DAYS` | `30` | Stories older than this are deleted every 6 hours. |
| `SPECTRE_INTEL_GDELT` | `1` | `0` switches GDELT off. |
| `SPECTRE_INTEL_DB` | `intel/data/spectre.db` | SQLite file (gitignored). |
| `SPECTRE_INTEL_FEEDS_LOCAL` | `intel/feeds.local.yaml` | Your own feed additions and overrides (gitignored). |
| `SPECTRE_NONCOMMERCIAL_SOURCES` | off | Shared with the app's Provider Settings switch. |
| `OLLAMA_HOST` | `127.0.0.1:11434` | Ollama's address. |
| `OLLAMA_MODEL` | `qwen3.5-9b-64k-gpu:latest` (`bonsai-2:9b` in low-resource mode) | The chat model, chosen by the Phase 4 eval; it must list the `tools` capability for native tool calls. |
| `OLLAMA_NUM_CTX` | `16384` | Context window. |
| `OLLAMA_KEEP_ALIVE` | `5m` | How long the model stays loaded after a turn. |
| `SPECTRE_LOW_RESOURCE` | off | 8k context and smaller history and web budgets. |
| `SPECTRE_SEARCH_PROVIDER` | `ddgs` | `ddgs`, `searxng` (with `SEARXNG_URL`), `brave` (`BRAVE_API_KEY`) or `tavily` (`TAVILY_API_KEY`). |
| `SPECTRE_CHAT_TURNS_PER_MINUTE` | `12` | Chat rate limit. |
| `SPECTRE_VOICE` | on when installed | `0` turns local voice off. |
| `SPECTRE_VOICE_THREADS` | `8` | CPU threads for speech to text, and again for text to speech. |
| `SPECTRE_TTS_VOICE` | `af_heart` | An English Kokoro voice (`af_*`, `am_*`, `bf_*`, `bm_*`). |
| `SPECTRE_VOICE_DIR` | `intel/data/voice` | Where `fetch_voice_models.py` puts the models. |

`intel/feeds.local.yaml` uses the same shape as `intel/feeds.default.yaml`. Entries merge by `id`, so `- {id: bbc-world, enabled: false}` turns one off, and a new id adds a feed. `gdelt: {enabled: false}` switches GDELT off.
