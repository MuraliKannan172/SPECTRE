# SKYNET — Claude Code Build Prompt

You are the lead engineer on **SKYNET**: an open-source, local-first global intelligence globe. It merges two codebases:

1. **God's Eye View (GEV)** — upstream MIT project: `https://github.com/bilawalsidhu/gods-eye-view` (CesiumJS + Vite + vanilla JS, Node proxy server, 20 live layers, 30 voice tools, cockpit mode, sensor shaders, share links, MCP server).
2. **WorldMonitor AI v2** — my existing project: `C:\Users\Murali Kannan\Workspace\Claude\World Monitor AI version 2\worldmonitor-ai` (verify the path exists). Treat it as a **read-only reference**; do not modify it. I own that code, so you may port from it.

Result: GEV's 3D globe and every GEV feature, plus WorldMonitor v2's real-time news intelligence and local Ollama analyst, rebranded as SKYNET in a **Vanta-black + Ferrari-red** theme. Everything must run locally on Windows 11 (RTX 5060 8 GB, 16 GB RAM) with no required paid keys.

---

## 0. Operating rules (follow throughout)

- **Plan before code.** Phase 0 produces a plan and stops for my approval. After that, work **one phase at a time**; run the phase's smoke tests and report results before starting the next phase.
- **Never claim something works unless you ran it.** Report exact commands and outputs for builds/tests. If you cannot verify something, say so.
- **Token-efficient edits:** targeted reads (offset/limit, Grep) over full-file reads; `Edit` diffs over rewrites; no boilerplate commentary.
- **Additive and reversible:** keep GEV features working. Every new capability sits behind a layer/panel toggle; disabling it returns the app to prior behavior.
- **Ask a 2-line clarifying question** rather than guess when a missing answer would change architecture. Otherwise proceed with stated assumptions.
- **No stubs presented as features.** A feature either works end-to-end or is visibly marked disabled with the reason in the UI.
- Use PowerShell-compatible commands (Windows 11). Say which terminal each command runs in.
- Optionally use parallel subagents for Phase 0 recon (GEV audit vs WM v2 audit), each with a written scope; you own integration.

---

## 1. Objective and non-goals

**Objective:** a fully functional, MIT-licensed open-source app with:
- **All GEV features** (see Phase 0 inventory; nothing silently dropped).
- **WorldMonitor v2 features** found in the audit (RSS ingestion, geoparsed news on the globe, satellite/pass prediction, EONET/disaster layers, AI analyst panel, etc.).
- **Real-time news** pipeline with geolocation, dedupe, search, and live push to the UI.
- **Neural Core:** a local-Ollama chatbot that can search the web, read pages, query our news store, and control the globe, answering with citations and "as of" timestamps.
- **SKYNET branding** with Vanta-black + Ferrari-red theme.

**Non-goals / hard lines:** no named-person search, face recognition, or tracking individuals (keep GEV's stated line). The app models events, assets, infrastructure and systems. Not for navigation, emergency response, or other safety-critical use; keep GEV's disclaimer visible.

---

## 2. Licensing and attribution rules (open-source hygiene)

- Fork GEV into `C:\Users\Murali Kannan\Workspace\Claude\SKYNET\`. Keep upstream `LICENSE` (MIT, © Bilawal Sidhu) and add our copyright line; add `NOTICE.md` crediting upstream and listing what we changed.
- MIT covers **code only**. Read `DATA_SOURCES.md`, `THIRD_PARTY_NOTICES.md`, and `public/models/README.md` in Phase 0 and produce a **license triage table** (item, license, bundled or runtime, action).
- **Do not bundle non-commercial or restrictive data in the default build:**
  - Remove `src/data/local_data/telegeography_submarine_cables/` (CC BY-NC-SA). Optionally provide `scripts/fetch-optional-data.ps1` that lets a user download it themselves, off by default.
  - Google News RSS is personal/non-commercial only: do not use it as a default source. Use user-configurable RSS feeds and GDELT (citation required).
  - OpenSky is non-commercial: keep it optional, with adsb.lol as the default flight source if that works within its terms; verify and document.
  - Audit each 3D model in `public/models/` against its stated license; replace or remove anything that does not permit redistribution.
  - Esri imagery is not covered in `DATA_SOURCES.md`: check its terms and document the result.
- Keep ODbL attribution (OSM-derived data) and the on-globe Google/Cesium credit + "Data attribution" popover visible at all times. Register every new source in `src/data/dataCredits.js` and `DATA_SOURCES.md`.
- News: store **headline, short summary, source, URL, timestamp** only. Do not republish full article text.
- Put all branding strings (name, wordmark, tagline, colors) in one `src/branding.js` so a rename is a one-file change. Do not use "God's Eye View" or Halfpixel names/logos/GIFs in our branding.

---

## 3. Target architecture

```
SKYNET/
├── CLAUDE.md                 # project rules (create in Phase 1 from section 0)
├── src/                      # GEV frontend (Vite + vanilla JS + CesiumJS), extended
│   ├── branding.js
│   ├── theme/skynet.css      # tokens + overrides, loaded last
│   ├── layers/news/          # NEW: news layer (globe markers, clusters, ticker)
│   ├── panels/neuralCore/    # NEW: chat panel (streaming, citations, tool-status)
│   └── tools/registry.js     # unified tool registry (globe + news + web), see §5
├── server/                   # GEV Node proxy (keep; extend /api proxying to the intel service)
├── intel/                    # NEW: FastAPI service (Python 3.11+)
│   ├── app/main.py
│   ├── app/ingest/           # RSS/Atom + GDELT pollers, dedupe, scheduler
│   ├── app/geo/              # geoparsing (spaCy NER + gazetteer)
│   ├── app/store/            # SQLite + FTS5, migrations
│   ├── app/chat/             # Ollama client, agent loop, tools, SSE
│   ├── app/web/              # search providers, page fetch/extract, SSRF guard
│   └── tests/
├── scripts/                  # skynet.ps1 (one-command start), doctor extensions
├── docs/                     # ARCHITECTURE.md, KEYS_AND_COSTS.md, DATA_SOURCES additions
└── compose.yaml              # optional; must not break native start
```

- **Shell:** GEV (Cesium globe, layer registry, HUD, share links, Director scenes, cockpit, sensor shaders).
- **Intel service:** FastAPI on `127.0.0.1:8100`, started alongside GEV by `scripts/skynet.ps1`; GEV's dev server proxies `/api/intel/*` to it. Bind to localhost only.
- **Contracts:** HTTP/JSON + SSE. Write `docs/API.md` (OpenAPI auto-generated by FastAPI is fine) before building the frontend against it.
- If the Phase 0 audit shows WM v2's backend is already FastAPI, **port its modules** into `intel/` rather than rewriting. If you recommend a different split, justify it in the ADR.

---

## 4. Phases

### Phase 0 — Recon and ADR (no feature code)
1. Clone GEV; `node -v` (needs 24.14+ or 26.x), `npm ci`, `npm run doctor`, `npm run dev`; confirm it runs keyless at `http://localhost:4173`. Run `npm test` and report the baseline.
2. **GEV inventory:** every layer, panel, voice tool (list all ~30 in `src/voice/`), share-link schema, MCP server, scripts. Output a table: feature, file(s), keys needed, license concerns.
3. **WM v2 inventory** (read-only): stack (my past notes conflict: vanilla JS + SQLite vs React/Vite/Tailwind, so verify), RSS feed list, NER/geoparsing, DB schema, RAG/FTS5, satellite/TLE logic, EONET layer, AI analyst panel, Ollama config. Output the same table.
4. **License triage table** (section 2).
5. **Ollama check:** `ollama list`, `ollama show <model>`; pick the default chat model that supports native tool calling and fits 8 GB VRAM alongside Cesium rendering. Test tool-calling on the candidates with a 5-prompt probe and report pass/fail honestly.
6. **ADR** (`docs/ADR-001.md`): merge strategy, service split, data model, chat/agent design, risks (GPU contention between WebGL and Ollama, Windows pathing, rate limits), and a phase plan with acceptance tests.
**STOP and wait for my approval.**

### Phase 1 — Fork, rebrand, license hygiene, theme
- Apply section 2 removals; add `NOTICE.md`; create `CLAUDE.md`; implement `branding.js`.
- Implement the theme (section 7) as additive CSS loaded last plus Cesium UI overrides. Keep sensor styles (CRT/NVG/FLIR) working.
- **Acceptance:** app boots keyless; all GEV layers behave as before; no references to upstream branding in UI; `npm test` baseline unchanged; screenshots (desktop + narrow width) attached.

### Phase 2 — Intel service: real-time news
- Spec in section 6. Deliver ingest, dedupe, geoparse, FTS5 store, REST + SSE, health endpoint, tests.
- **Acceptance:** `pytest` passes; `/api/intel/health` shows per-feed status; with the network on, new items appear within one poll interval; with the network off, the service degrades gracefully (serves cached items, flags stale).

### Phase 3 — Frontend integration
- News layer on the globe (markers sized/colored by category and recency, cluster at low zoom, click opens article list with source links), live ticker, news panel with filters (category, region, time, source), "fly to" from an item.
- Port WM v2 layers found in the audit (e.g., satellites + pass prediction, EONET/disasters) as GEV layers through the existing layer registry. Reuse GEV's satellite layer where it already covers the need; do not duplicate.
- Layers appear in **Data Layers** with the correct grouping and license credits.
- **Acceptance:** each layer toggles on/off cleanly; share links round-trip the new layer states; Playwright or Puppeteer smoke test loads the app and asserts the news layer renders points from a fixture feed.

### Phase 4 — Neural Core (Ollama chatbot with web check)
- Spec in section 5.
- **Acceptance:** scripted eval of 15 prompts (5 globe-control, 5 news-store, 5 web-search questions needing fresh info) with pass/fail per prompt; every factual web answer carries citations and an "as of" timestamp; with Ollama stopped, the panel shows a clear offline state.

### Phase 5 — (Stretch) Local voice
- Keep GEV's OpenAI/Gemini voice providers. Add an optional **local** provider: faster-whisper (STT) + Piper or Kokoro (TTS) feeding the same tool registry through the Neural Core agent. Push-to-talk first. Report measured end-to-end latency on this machine; do not promise numbers you did not measure.

### Phase 6 — Hardening and release
- Security checklist (section 8), `npm run doctor` extended (Ollama reachable, model present, intel service healthy, search provider status), Windows one-command start (`scripts/skynet.ps1`), README (quick start, keyless vs keyed, costs, screenshots), `docs/ARCHITECTURE.md`, `CONTRIBUTING.md`, CI for lint + tests, tagged `v0.1.0`.

---

## 5. Neural Core — local Ollama chatbot spec

**Model/runtime**
- Ollama `/api/chat` with `tools` and streaming. Model chosen in Phase 0 (from `ollama list`); configurable in Settings and `.env` (`OLLAMA_HOST`, `OLLAMA_MODEL`). Cap `num_ctx` (default 8192; make it configurable) and set `keep_alive` sensibly so the model does not starve WebGL of VRAM.
- If the selected model lacks native tool calling, fall back to a constrained JSON tool-call parser and flag degraded mode in the UI.
- Display model name, load state, and tokens/sec in the panel header (that is the "neural core" readout: real data only).

**Unified tool registry** (`src/tools/registry.js` for client tools; `intel/app/chat/tools.py` for server tools). One schema serves OpenAI voice, Ollama chat, and the MCP server.
- Globe tools: reuse GEV's existing voice-tool definitions (fly to, track, toggle layer, set style, annotate, measure, reset). Execution stays client-side.
- `news_search(query, since, region, category, limit)` and `news_near(lat, lon, radius_km, since)` → the FTS5 store.
- `web_search(query, recency, limit)` and `fetch_page(url)` → section below.
- `layer_state()` and `viewport()` → returns active layers, camera, bbox, and current time. **Inject this context into the system prompt each turn** so answers are map-aware.
- No shell, file, or code-execution tools are ever exposed to the model.

**Web check**
- `SearchProvider` interface with implementations: `ddgs` (keyless default, best-effort; may rate-limit), `searxng` (self-hosted, recommended for reliability), optional `brave`/`tavily` (key). Show provider status in Settings and `doctor`.
- `fetch_page`: httpx + trafilatura extraction; respect robots.txt; 10 s timeout; 1 MB cap; text only; follow ≤3 redirects with re-validation.
- **SSRF guard:** resolve DNS and reject private, loopback, link-local, and reserved ranges (IPv4 and IPv6) on every hop; allow only http(s) on ports 80/443.
- **Prompt-injection defense:** wrap fetched/search text in `<untrusted_web_content source="...">` delimiters; system prompt states it is data, never instructions; tool calls triggered right after reading web content must still validate against the tool schema; log every tool call with arguments.

**Agent loop**
- Max 4 tool iterations per turn; stream tokens plus tool-status events ("searching…", "reading example.com…") over SSE.
- Freshness policy: for any "latest/now/today/current" question, search before answering. Prefer primary sources; when sources conflict, say so.
- Answer format: short, direct, numbered citations `[1]` linking to the URL; end factual answers with `As of <local time>`. If search is unavailable or returns nothing relevant, say that rather than answering from model memory.
- Conversation history persisted locally (SQLite), with a clear-history control. Panel UX: streaming, copy, stop/regenerate, citation chips, typing/tool indicators, auto-scroll, auto-growing input, error and offline states.

---

## 6. News intelligence spec

- **Sources:** `intel/feeds.default.yaml`. Reuse WM v2's 50+ feeds if they exist; otherwise select reputable RSS/Atom feeds across world, regions, defence, cyber, science, economy, disasters, and space. **Verify every URL returns 200 and parses** at build time, record terms-of-use notes per feed, and drop failures. Add GDELT DOC 2.0 as an optional source. Users can add or disable feeds in Settings.
- **Polling:** async scheduler; default 5 min per feed; ETag/If-Modified-Since; exponential backoff on failure; per-feed health (last success, error, item count) exposed at `/api/intel/health`.
- **Dedupe:** canonical-URL hash plus title similarity (e.g., rapidfuzz) within a 48 h window; cluster near-duplicates into one story with multiple sources.
- **Geoparsing:** reuse WM v2's pipeline if present; else spaCy NER (`GPE`/`LOC`/`FAC`) with a bundled gazetteer (GeoNames cities, CC BY 4.0, add attribution; Natural Earth already ships with GEV). Store confidence; items without a confident location still appear in the panel and ticker but not on the globe. No per-item calls to Nominatim.
- **Categorization:** rules/keywords first (cheap and deterministic); optional batched local-LLM tagging behind a setting. Never block ingestion on the LLM.
- **Store:** SQLite with FTS5 (BM25), indexes on `published_at`, `category`, `lat/lon`; retention setting (default 30 days). Schema in Alembic-style migrations.
- **API:** `GET /api/intel/news` (filters + pagination), `GET /api/intel/news/stream` (SSE, new items), `GET /api/intel/news/{id}`, `GET /api/intel/health`.
- **Freshness UX:** every news surface shows "updated X min ago" and a stale badge past 3× the poll interval.

---

## 7. Theme — Vanta Black + Ferrari Red

Define in `src/theme/skynet.css` as CSS variables; override Cesium widgets, HUD, panels, and chat. Bundle fonts locally (`@fontsource/jetbrains-mono` for data/HUD, `@fontsource/rajdhani` for headings/wordmark); no runtime Google Fonts calls, so the app works offline.

```css
:root {
  --sk-bg:        #000000;   /* Vanta black */
  --sk-bg-1:      #050507;
  --sk-surface:   #0B0B0E;
  --sk-surface-2: #121217;
  --sk-border:    #22222A;
  --sk-red:       #FF2800;   /* Ferrari red: text, icons, active states */
  --sk-red-deep:  #D40000;   /* Rosso Corsa: fills, borders (not small text) */
  --sk-red-glow:  rgba(255, 40, 0, 0.35);
  --sk-text:      #ECECEF;
  --sk-text-dim:  #8B8B94;
  --sk-warn:      #FFD400;
  --sk-ok:        #34D399;
}
```

- Style: near-black glass panels, 1 px hairline borders, red used sparingly for focus, active layer toggles, selection, and the wordmark. Subtle red glow on hover/active. Respect `prefers-reduced-motion`.
- **Semantic collision:** red is both brand and danger. Encode severity by **icon, label, and shape/animation**, not hue alone. Reserve solid red fill plus pulse for true alerts (emergency squawk, critical news); normal accents use red outlines only.
- Verify contrast for WCAG AA on all text; use `--sk-red` (not `--sk-red-deep`) for red text on black and check the ratio.
- Wordmark: **SKYNET** with a "Neural Core" sub-label on the chat panel. Optional boot sequence (skippable, off with reduced motion). No fake "AI is thinking" effects: any animation tied to the model reflects real state (loading, streaming, tool call).
- Keep both light-clean and recording modes working with the new theme; sensor shaders (CRT/NVG/FLIR/Noir/Snow) stay.

---

## 8. Security and reliability

- Bind all servers to `127.0.0.1`; keep GEV's LAN-sharing opt-in and its warnings. CORS limited to the app origin.
- Secrets only in `.env` / the in-app Provider Settings (owner-only file permissions as GEV does). Never hardcode keys; never send keys to the browser except those GEV already requires (restrict at provider).
- Validate all inputs (Pydantic); rate-limit chat and web-fetch endpoints; cap response sizes; sanitize errors.
- Log tool calls and fetched URLs locally (no content logging by default); `.gev-logs`-style log folder, gitignored.
- Graceful degradation everywhere: feed down, Ollama down, search blocked, no keys. Each case has a visible state in the UI.
- GPU budget: document VRAM usage for the chosen model + Cesium; provide a "low-resource mode" (smaller model, shorter context, reduced layer density).

---

## 9. Testing and Definition of Done

- Python: `pytest` for ingest, dedupe, geoparse, FTS queries, SSRF guard (including DNS-rebinding and redirect-to-private cases), agent loop with a mocked Ollama.
- Frontend: reuse GEV's `npm test`; add tests for the tool registry and news layer; a browser smoke test (Playwright or Puppeteer) that loads the app, toggles layers, and sends a chat message against a mock.
- Manual verification script `docs/VERIFY.md` with exact steps and expected results.
- **Done =** keyless boot works; every GEV layer works or is clearly marked disabled with a reason; news flows live; Neural Core passes the Phase 4 eval; license triage applied; docs complete; CI green; and a final report that states what was verified, what was not, and known limitations.

---

## 10. Your first action

Do **Phase 0 only**. Start with one sentence saying what you are doing, then run the recon. Deliver the inventories, license triage table, Ollama probe results, and `docs/ADR-001.md`, then stop and ask for approval to begin Phase 1.
