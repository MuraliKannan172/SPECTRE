# WorldMonitor AI v2 ("Cyberdyne Systems Global Intelligence Dashboard") — Inventory

Phase 0 recon for the SKYNET merge. **Read-only audit**; nothing in the WM v2 folder was modified, installed, built or run.

- **Actual path:** `C:\Users\Murali Kannan\Workspace\Claude\World Monitor AI version 2\world-monitor` (the brief's `...\worldmonitor-ai` path does not exist).
- **Design notes read:** `..\V2.md` (original "World Monitor" build spec) and `..\up2.md` (the "Cyberdyne Systems" update spec: Ollama chatbot, multi-source news, glass theme).
- **Sibling folder `..\Skynet\`:** holds only `1.png` to `4.png`. I viewed `1.png`, which is a screenshot of WM v2 itself (cyan "Obsidian" theme). Images 2 to 4 were not viewed.
- **Snapshot:** this inventory reflects the **working tree**, which is dirty. HEAD is `58e3fa4`, and 4 files are modified but uncommitted (see §1.4).
- **Legend:** **[V]** = verified from code, grep or installed `node_modules`. **[U]** = unverified (general knowledge or inference). "Absent (grep-confirmed)" means I searched the source for it and found nothing.

**Bottom line:**
- The backend is **Node.js / Express 4 (CommonJS)**. It is **not FastAPI**, has **no database**, and keeps only in-memory caches.
- The client is **React 18 + TypeScript + Vite 5 + Tailwind 3 + CesiumJS (used directly, no Resium) + Zustand**.
- The older notes saying "vanilla JS + SQLite" are **wrong**. The only "vanilla JS" part is the CommonJS server.
- Recommendation: **port logic, not modules.**

---

## 1. Stack (verified)

### 1.1 Client — `client/`

| Item | Declared (`client/package.json`) | Installed (`node_modules`) [V] |
|---|---|---|
| Framework | react / react-dom `^18.3.1` | 18.3.1 |
| Language | typescript `~5.6.2` (strict, `noUnusedLocals`) | 5.6.3 |
| Build | vite `^5.4.8` + `@vitejs/plugin-react ^4.3.1` + `vite-plugin-cesium ^1.2.23` | vite 5.4.21, plugin-cesium 1.2.23 |
| Map engine | cesium `^1.126.0`, **used directly via the Cesium API, not Resium** (README "Design Notes") | **1.143.0** |
| Styling | tailwindcss `^3.4.10` + postcss + autoprefixer, plus hand CSS (`src/styles/theme.css`, `glass.css`) | 3.4.19 |
| State | zustand `^4.5.5` (`store/mapStore.ts`, `newsStore.ts`, `themeStore.ts`) | 4.5.7 |
| Other | axios `^1.7.7`, react-markdown `^9.1.0` (renders assistant replies) | axios 1.18.1, react-markdown 9.1.0 |

- **Package name:** `cyberdyne-dashboard` v2.0.0.
- **Entry:** `index.html` → `src/main.tsx` → `App.tsx`.
- **Dev server:** port **5173**. It proxies `/api` → `http://localhost:5000` (`vite.config.ts`).
- **Build artifacts:** `client/dist/` and `tsconfig.tsbuildinfo` already exist from an earlier build.
- **Fonts:** Google Fonts (Orbitron, Rajdhani, IBM Plex Mono), loaded in `index.html`.
- **Basemap:**
  - Working tree: Esri Canvas World Dark/Light Gray Base + Reference tiles, keyless, `maximumLevel` 16 (`utils/constants.ts`).
  - HEAD still uses CARTO tiles. The uncommitted diff switches them because "CARTO's free tiles now return an API KEY REQUIRED placeholder".
- **Cesium Ion:** an optional `VITE_CESIUM_ION_TOKEN`.
- **Size:** about 5,200 lines of TypeScript/TSX/CSS in `client/src` (server is about 870 lines of JS). Largest files are `layerService.ts` (308 lines) and `types/index.ts` (299 lines).

### 1.2 Server — `server/`

| Item | Value [V] |
|---|---|
| Language / runtime | Node.js, **CommonJS** (`require`), no TypeScript. Docker image `node:20-alpine`; README says Node 20+. |
| Framework | **Express `^4.21.0`** (installed 4.22.2). **Not FastAPI or Flask; no Python anywhere in the repo.** |
| Dependencies | axios, cors, dotenv, **rss-parser `^3.13.0`**, **satellite.js `^5.0.0`** (installed 5.0.0). Dev dependency: nodemon. |
| Database | **None.** No sqlite or ORM dependency. All state is module-level in-memory variables (§2.3). |
| Entrypoint | `server/index.js` → `app.listen(PORT=5000)` |
| Routes | `GET /api/health`<br>`/api/news` (`routes/news.js`)<br>`/api/layers/static` (`routes/layers.js`, a static index only)<br>`/api/layers/live/{flights,ships,satellites}` (`routes/live.js`)<br>`/api/geocode?q=` (`routes/geocode.js`)<br>Unknown `/api/*` → 404 JSON; the central error handler returns 500 JSON. |
| Middleware | `middleware/cors.js` (allowlist from `CORS_ORIGINS`)<br>`middleware/rateLimiter.js` (in-memory sliding window, 120 req/min per IP) |
| Env vars actually read | `PORT`, `CORS_ORIGINS`, `RATE_LIMIT_PER_MINUTE`, `NEWS_API_KEY`, `NEWS_API_BASE`, `GNEWS_API_KEY`, `RSS_FEEDS`, `OPENSKY_API_URL`, `NOMINATIM_URL` |
| Declared but **never read** | `MARINETRAFFIC_API_KEY`, `MARINETRAFFIC_API_URL`, `OLLAMA_URL`, `OLLAMA_MODEL`, `OLLAMA_CONTEXT_SIZE`, `OLLAMA_TEMPERATURE`, `CESIUM_ION_TOKEN` (all in root `.env.example`). The client reads only the `VITE_*` equivalents. |

### 1.3 Ports and launchers

| Process | Port | Started by |
|---|---|---|
| Express API | 5000 | `run.bat` → new window, `cd server && npm run dev` (nodemon) |
| Vite client | 5173 | `run.bat` → new window, `cd client && npm run dev` |
| Ollama | 11434 | **Not started by the project.** The browser calls it directly. |

- **`run.bat`:**
  - Checks that `node` is on PATH.
  - Runs `npm install` in `server/` and `client/` on first run.
  - Checks `where ollama` and prints "AI assistant enabled (model: llama3.2)". It does **not** check that the model is pulled.
  - Opens two `cmd /k` windows, waits 8 s, then opens `http://localhost:5173`.
- **`docker-compose.yml`:**
  - Two `node:20-alpine` services bind-mount `./server` and `./client` and run `npm install` at container start.
  - The server runs `npm run start` on port 5000 and receives only `PORT`, `NODE_ENV`, `NEWS_API_KEY` and `CORS_ORIGINS`. **`GNEWS_API_KEY` and `RSS_FEEDS` are not passed through.**
  - The client runs the **Vite dev server** (`npm run dev -- --host 0.0.0.0`) on port 5173 with `VITE_API_BASE=http://localhost:5000`.
  - There is no Ollama service. It uses the obsolete `version: '3.9'` key.

### 1.4 Git [V]

- **Branch:** `main`, tracking `origin/main`.
- **Remote:** `origin` → `https://github.com/MuraliKannan172/Cyberdyne-Global-intelligence-Dashboard.git`
- **`git log --oneline -10`** (only 3 commits):
  ```
  58e3fa4 Update LICENSE copyright holder to Cyberdyne Systems
  2059eab Add screenshots to README
  242807b Initial commit: Cyberdyne Systems global intelligence dashboard
  ```
- **Uncommitted changes:** `README.md`, `client/.env.example`, `client/src/services/cesiumService.ts` and `client/src/utils/constants.ts` (basemap CARTO → Esri; 51 insertions, 25 deletions).
- **Git commands I ran:** `log`, `remote -v`, `status`, `branch -a`, `diff`. All are read-only, although `git status` may refresh git's index stat cache.

---

## 2. Feature inventory

Root for paths below: `world-monitor/`.

**Recommendation key:**
- **port as-is** — copy the code and translate it.
- **port logic** — reimplement the idea or algorithm in SKYNET's stack.
- **skip — GEV covers** — the GEV fork already has this source. I checked this by grepping `SKYNET/DATA_SOURCES.md` only, not GEV code.
- **skip — quality** — not worth porting.

| Feature | File(s) | Keys needed | Data source / license concern | Recommendation |
|---|---|---|---|---|
| **RSS ingestion** | `server/routes/news.js` (`DEFAULT_RSS_FEEDS`, `fetchRssFeed`, `configuredRssFeeds`) | none | 3 publisher feeds (§2.1). Publisher RSS terms usually allow headline+link display for non-commercial use [U]. | **port logic** into the Python intel service (feedparser). The feed list is too small to matter; SKYNET needs a curated list. |
| NewsAPI (primary when keyed) | `news.js` `fetchNewsApi` → `/v2/top-headlines?language=en&pageSize=30` | `NEWS_API_KEY` | Free tier is development-only, not for production [U]. | **skip — license.** Optional adapter at most. |
| GNews (backup) | `news.js` `fetchGNews` → `gnews.io/api/v4/top-headlines` | `GNEWS_API_KEY` | Free tier is non-commercial [U]. | **skip** (optional adapter) |
| **Google News RSS** | **absent (grep-confirmed)** | — | Not used, so no non-commercial flag applies to WM v2. | n/a |
| **GDELT** | **absent (grep-confirmed)** | — | — | n/a. Build new in intel service. |
| **NER / geoparsing** | **absent (grep-confirmed).** News items have **no coordinates at all** and are never plotted on the globe. | — | — | n/a. Build new (spaCy + gazetteer). |
| **Dedupe** | `news.js` `dedupeKey` / `mergeAndDeduplicate` | — | — | **port logic, tier 0 only.** Key is lowercased title, non-alphanumerics stripped, first 64 chars, exact match. It misses cross-outlet paraphrases. |
| **Categorization** | `news.js` `categorize(title)`. 8 categories: `cyber, conflicts, security, politics, economy, climate, technology, global` | — | — | **skip — quality.** Naive substring match; see §4. The keyword lists could seed a rules fallback. |
| Multi-source fan-out + fallback | `news.js` `fetchAllNews` (`Promise.allSettled`), 55 s cache, 24 h `lastGood`, `simulatedArticles()` | — | — | **port logic** for allSettled + last-good. **Drop** the simulated fallback (§4). |
| **DB schema** | **none.** No DDL, ORM or migrations. Module-level caches only (§2.3). | — | — | n/a. Design the SQLite + FTS5 schema fresh. |
| **RAG / FTS5 / embeddings** | **absent (grep-confirmed)** | — | — | n/a |
| **Satellites / TLE** | `server/routes/live.js` (`ensureSatRecords`, `propagateGeodetic`, `parametricPosition`, `classifyPurpose`); `server/data/tles.js` (embedded fallback) | none | CelesTrak `gp.php?GROUP=visual&FORMAT=tle` (~bright objects), capped at **60** records. Uses **satellite.js 5.0.0** SGP4. CelesTrak attribution expected [U]. | **skip — GEV covers** (CelesTrak listed in GEV `DATA_SOURCES.md`; verify in code). See §4 for TLE problems. |
| Pass prediction / ground tracks | **absent** | — | — | n/a |
| Satellite sensor cones (visual) | `client/src/services/sensorCones.ts` (205 lines; Cesium `Primitive` cylinders for LEO < 3,000 km; colours by purpose) | — | — | **port as-is (optional, cosmetic).** It is plain Cesium API, so it ports to vanilla JS by stripping types. Check GEV's own satellite rendering first. |
| **EONET / disasters** | **absent (grep-confirmed).** `weatherAlerts` and `climateAnomalies` are static fabricated polygons (§2.2). | — | — | n/a. GEV covers FIRMS and NOAA/NHC weather per its `DATA_SOURCES.md`. |
| Earthquakes / wildfires | **absent** | — | — | n/a. GEV covers USGS and FIRMS per its `DATA_SOURCES.md` (verify). |
| **Flights** (aviation + militaryActivity) | `live.js` `fetchOpenSky`, `buildSimulatedFleet` / `advanceFleet` | none (anonymous) | OpenSky anonymous `/states/all`; truncated to the first 350 airborne states. OpenSky terms: research/non-commercial; anonymous quota is low [U]. Falls back to a 220-plane **simulated** fleet. | **skip — GEV covers** (OpenSky/ADS-B in GEV docs) |
| Military-flight detection | `live.js` `MILITARY_PREFIXES` (12 callsign prefixes) | — | — | **skip — quality.** A crude prefix guess. |
| **Ships** | `live.js` `/ships` (8 hand-drawn sea-lane polylines, 110 vessels) | `MARINETRAFFIC_*` declared but **unused** | **100% simulated** (`source: 'simulated-ais'`) | **skip — quality.** GEV has AIS. |
| Cyber threats / internet disruptions / GPS jamming | `client/src/data/mockGenerators.ts` (`generateCyberThreats`, `generateInternetDisruptions`, `generateGpsJamming`), driven by `hooks/useLiveData.ts` | — | **100% `Math.random`** client-side | **skip — quality.** GEV lists a GPS-jam source. |
| 19 static layers | `client/src/data/static/{securityPoints,infrastructure,crisis}.ts` + `staticLayers.ts`; index in `server/routes/layers.js` | — | Hand-authored (LLM-generated per `V2.md`) coordinates with invented severity/status; **no sources cited.** | **skip — quality.** Only consider re-sourcing chokepoints/spaceports/nuclear sites from a citable dataset. GEV already bundles TeleGeography cables. |
| Layer config (26 layers, 5 categories) | `client/src/data/layerConfig.ts` | — | — | **port logic** only if SKYNET wants WM's taxonomy/colours. |
| Layer renderer | `client/src/services/layerService.ts`. One `CustomDataSource` per layer, clustering (`pixelRange` 42, `minimumClusterSize` 4), `SampledPositionProperty` interpolation for movers. | — | — | **skip — GEV has its own renderer** (verify). The interpolation idea is reusable; see the §4 memory caveat. |
| **Location search** | `server/routes/geocode.js` (Nominatim proxy), `client/src/utils/coordinates.ts` (decimal + DMS parser), `data/searchIndex.ts` + `hooks/useSearch.ts` + `components/Search/SearchBar.tsx` (Ctrl/Cmd+K) | none (`NOMINATIM_URL` optional) | Nominatim usage policy: 1 req/s and an identifying User-Agent (both implemented; no contact email in the UA) | **port as-is:** `coordinates.ts` (56 lines, pure). **port logic:** Nominatim proxy (serialised 1.1 s queue, 10 min TTL, 300-entry cache, soft-fail). GEV mentions Nominatim, so check for overlap. |
| Feature info card + Google Maps links | `components/MapView/FeatureInfoCard.tsx`, `utils/externalMaps.ts` | — | Google Maps URL deep links only, no API | **port as-is** (`externalMaps.ts`, 31 lines) if wanted |
| **AI analyst / assistant panel** | `components/AIAssistant/{AIAssistant,ChatInput,ChatMessageItem,ContextDisplay}.tsx`, `hooks/useAssistant.ts`, `services/ollamaService.ts` | none | Local Ollama, called **from the browser** | **port logic.** Reuse the context builder, NDJSON stream parser, `<think>` stripping, `/api/tags` model picker and error UX. Replace `/api/generate` + text trailer with `/api/chat` + tools in the intel service (§3). |
| Web search | **absent (grep-confirmed)** | — | — | n/a |
| **SSE / WebSocket push** | **absent (grep-confirmed).** Client polling only:<br>news 60 s (`NEWS_REFRESH_MS`)<br>flights 15 s<br>ships 30 s<br>satellites 60 s<br>cyber 30 s<br>disruptions 60 s<br>jamming 60 s | — | — | n/a. SSE is new work. |
| **Settings UI** | **none.** Only the theme toggle (`components/UI/ThemeToggle.tsx`) and the model `<select>` in the assistant header. All other config is env vars. | — | — | n/a |
| **Theming** | `client/src/styles/theme.css` (RGB-channel CSS vars under `:root[data-theme='dark'|'light']`), `glass.css`, `tailwind.config.js` (maps every token to `rgb(var(--x) / <alpha-value>)`), `store/themeStore.ts` (localStorage key `cyberdyne.theme`) | — | Google Fonts (OFL) [U] | **port logic** (token pattern). See the theming detail below. |
| Keyboard shortcuts | `hooks/useKeyboardShortcuts.ts`: L, N, 1–9, Esc, Ctrl/Cmd+K | — | — | skip (trivial; GEV likely has its own) |
| CORS / rate limit middleware | `server/middleware/*.js` | — | — | skip. FastAPI/GEV proxy will have its own. |
| **Tests** | **none.** No `*.test.*`, `*.spec.*`, `__tests__`, vitest, jest or playwright config. No ESLint/Prettier config either, although `V2.md` required both. | — | — | n/a. 0 tests exist. |

**Theming detail:**
- Branding is "Cyberdyne Systems", with motto "Securing Tomorrow's World, Today" and a "CS" favicon.
- The palette is **cyan `#00d4ff` / purple `#7b2ffc`**, with `--c-danger` `255 0 85` and success green.
- Two themes exist: **Obsidian** (dark) and **Ivory** (light, acid-green accent).
- **There is no red / Skynet theme.**

### 2.1 Full RSS feed list [V]

- **Count:** **3**
- **Where:** `server/routes/news.js` lines 31–35 (`DEFAULT_RSS_FEEDS`).
- **Override:** the comma-separated `RSS_FEEDS` env var replaces the list. Each feed's name is derived from its hostname.
- **No per-feed category.** Categories are assigned per headline by keyword (§4).
- Each feed is sliced to 20 items. The merged list is capped at 50.

| # | Name | URL | Category |
|---|---|---|---|
| 1 | BBC World | `https://feeds.bbci.co.uk/news/world/rss.xml` | none (keyword-classified per item) |
| 2 | Al Jazeera | `https://www.aljazeera.com/xml/rss/all.xml` | none |
| 3 | CNN World | `http://rss.cnn.com/rss/edition_world.rss` | none. Plain `http`; this CNN feed host may be stale/unmaintained [U]. |

Feeds mentioned only in specs, **not in code:** Reuters (`up2.md`) and NYT World (`up2.md` env example). Google News: none.

### 2.2 Real vs. mock — what is genuinely live

| Layer / feed | Status | Notes |
|---|---|---|
| News (RSS / NewsAPI / GNews) | **Real** when the upstream answers | If every source fails and there is no last-good set, `simulatedArticles()` serves **8 fabricated headlines attributed to Reuters, AP News, The Record, Financial Times, CNN, CNBC, BBC World and Aviation Week**, all linking to `https://news.example.com/article`. The UI source label shows "simulated", but each row shows the real outlet name. |
| aviation / militaryActivity | **Real (OpenSky) or simulated** | The endpoint returns `source: 'opensky' | 'simulated'`, but `useLiveData.ts` **ignores `source`**. The layer description still says "Live commercial flight positions", and the status bar counts the simulated planes. |
| orbitalSurveillance | **Real if CelesTrak is reachable**, else effectively fake | The fallback TLEs are synthetic (§4). Positions that fail SGP4 use `parametricPosition()` (fictional orbits) but are still labelled `source: 'tle-propagation'`. "Visual" group ≠ reconnaissance satellites; unknown names default to purpose "Surveillance". |
| shipTraffic | **Always simulated** | Described as "Live AIS vessel positions". The README says "ships along real sea lanes". |
| cyberThreats / internetDisruptions / gpsJamming | **Always simulated** (`Math.random`) | Authoritative wording, e.g. "detected by probe network" and "GNSS interference measured, intensity N dB-Hz drop". Severity is randomised on every refresh. |
| 19 static layers | **Hand-authored, unsourced** | `makePoint`/`makePolygon` stamp `updatedAt = NOW_ISO` and `effectiveFrom = now`, so the info card shows "Updated just now". Weather alerts like "Typhoon warning — Luzon, Category 4 landfall expected 36h" are fabricated as current events. |
| Geocoding | **Real** (Nominatim) | — |
| Disclaimer | Only the footer text `CYBERDYNE SYSTEMS // UNCLASSIFIED · TRAINING DATA` (`components/UI/StatusBar.tsx:26`) | There are no per-layer "simulated" badges. |

### 2.3 In-memory state (stands in for a DB schema)

There is no DDL to quote. These are all module-level variables, lost on restart:

```js
// server/routes/news.js
let cache    = { articles: [], sources: [], fetchedAt: 0 };   // TTL 55 s
let lastGood = { articles: [], sources: [], fetchedAt: 0 };   // "24h emergency cache" — process memory only
// article shape: { id, title, source, publishedAt, url, category }   (no body, no summary, no coords)

// server/routes/live.js
let flightsCache = { data: null, fetchedAt: 0 };  // 14 s
let simulatedFleet = null; let shipFleet = null;   // persistent sim state
let satRecords = null;                              // TLEs fetched ONCE per process, never refreshed

// server/routes/geocode.js
const cache = new Map();  // query -> { results, at }, TTL 10 min, max 300 entries (FIFO eviction)

// server/middleware/rateLimiter.js
const hits = new Map();   // ip -> timestamps[]
```

---

## 3. Ollama integration details [V]

The code is `client/src/services/ollamaService.ts` (177 lines) and `client/src/hooks/useAssistant.ts` (137 lines). **All calls go from the browser directly to Ollama.** The Express server is not involved, so the setup relies on Ollama's default CORS allowance for localhost origins [U].

| Aspect | Implementation |
|---|---|
| Host | `VITE_OLLAMA_URL`, default `http://localhost:11434` (`utils/constants.ts`) |
| Default model | `VITE_OLLAMA_MODEL`, default **`llama3.2`** |
| Model listing | `GET /api/tags`. Returns `null` when unreachable, `[]` when running with no models. Called on mount and **each time the panel opens**. |
| Model picker | `<select>` in the assistant header (`AIAssistant.tsx`). Keeps the configured model if installed (tag-insensitive: `n === current || n.startsWith(current + ':')`), else picks the first installed model. The selection is **not persisted**. |
| Generation endpoint | **`POST /api/generate`**, not `/api/chat`. |
| Request body | `{ model, prompt, stream: true, options: { temperature } }`. Temperature comes from `VITE_OLLAMA_TEMPERATURE` (default 0.7). |
| Options **not** sent | No `num_ctx`, no `keep_alive`, no `system` field. **`OLLAMA_CONTEXT_SIZE` in `.env.example` is dead config.** |
| Streaming | `fetch` → `response.body.getReader()` → NDJSON line splitting → accumulates `json.response`. React state updates on every token. |
| Conversation memory | **None. Each send is single-turn**; earlier messages are not included in the prompt. |
| Abort / cancel | None (no `AbortController`). The UI just disables input while streaming. |
| Reasoning models | `stripThinking()` removes `<think>…</think>`, including an unterminated block mid-stream. |
| Tool calling | **None (no tool schema).** The model is told to end with a text trailer `ACTIONS: toggleLayer=<layerId>, …`. `parseActions()` regex-parses it and whitelists ids against `LAYERS`. If none are found, `inferActions()` regex-matches the **user's** message for show/display/enable verbs plus layer names. |
| Action execution | Actions render as buttons. `runAction` **always sets the layer visible (ON)**, despite the "Toggle …" label. The `MapAction` type declares `'toggleLayer' | 'zoomTo'`, but only `toggleLayer` is implemented; **`zoomTo` is a stub**. `up2.md`'s `highlight` / `showInfo` were never built. |
| Error UX | Unreachable → "Can't reach Ollama … ollama serve / ollama pull". 404 or "model not found" → "Model "x" not found. Pull it with: ollama pull x". Other status codes → status + 160 chars of body. Stream interruption → generic message. |
| Context fed to prompt | `buildContext()`: active layer names, camera lon/lat/height (km), 2D/3D mode, flight/ship/satellite counts, conflict-zone count, military count, top 5 headline titles |

**Prompt** (`ollamaService.ts` `buildPrompt`, lightly trimmed; there is no separate system prompt):

```ts
'You are the Cyberdyne Systems AI Assistant, a concise global-intelligence analyst',
'embedded in a live geospatial dashboard. Answer in 2-4 short sentences.',
'LIVE DASHBOARD CONTEXT:',
`- Active map layers: ${context.activeLayers.join(', ') || 'none'}`,
`- View: ${context.mode}, center lon/lat …, altitude … km`,
`- Tracked now: ${flights} flights, ${ships} vessels, ${satellites} satellites`,
`- Active conflict zones: ${conflictCount}; military tracks: ${militaryCount}`,
`- Recent headlines: ${headlines.slice(0, 5).join(' | ')}`,
'If the user asks to show/hide/toggle a map layer, end your reply with a line exactly like:',
'ACTIONS: toggleLayer=<layerId>, toggleLayer=<layerId>',
`Valid layerIds: ${LAYERS.map((l) => l.id).join(', ')}`,
`User question: ${message}`,
```

Greeting text and three suggestion chips are hard-coded ("Situation in the South China Sea?", "Show all GPS jamming areas", "What's active near Ukraine?").

**Port notes for the SKYNET intel agent:**
- **Prompt injection.** Untrusted RSS headlines are concatenated into the prompt, and the `ACTIONS:` trailer is parsed from model output. A crafted headline could steer actions. Impact here is low (whitelisted layer toggles only), but it matters once SKYNET has a tool-calling agent: keep untrusted text out of instruction position and validate tool arguments.
- **Re-plumb the whole call.** Use `/api/chat` with a `messages` history and a real `system` message. Add `tools` (native Ollama tool calling), explicit `num_ctx` and `keep_alive`, and an `AbortController`. Proxy through the intel service so the browser does not need Ollama CORS.

---

## 4. Quality notes — do not port these problems

### Mock data presented as real (highest priority)

1. **`client/src/data/mockGenerators.ts`.**
   - Despite the name, its exported helpers (`makePoint`, `pointCollection`, `makeLine`, `ringAround`, `makePolygon`) build **all** static layers.
   - It also generates 3 fully random "live" layers.
   - `ringAround()` produces wobbly fake polygons, used for conflict zones as well.
2. **Simulated vs. live is invisible in the UI.**
   - Flights, ships and satellites from simulated or parametric fallback show up as live.
   - The `source` field is returned but ignored (§2.2).
3. **`MOCK_HEADLINES`** (`server/routes/news.js` L141–162) attributes fabricated stories to real outlets.
4. **Embedded TLEs are synthetic** (`server/data/tles.js`).
   - 36 element lines: **34 fail the mod-10 TLE checksum**; only 2 pass (checked with a one-off `node -e` read of the file).
   - The values are round numbers (RAAN `95.0000`, `120.0000`, …) with sequential trailing digits.
   - Epochs are 2024-001, about 2.8 years stale as of 2026-10.
   - satellite.js does not validate checksums, so these load. SGP4 may also diverge, which triggers `parametricPosition()` (fiction).
5. **Static layer timestamps are always "now"**, and severities and statuses are invented. The coordinates are hand-typed and unsourced. Undersea cable paths are hand-drawn polylines (some cut across land).

### Bugs and stubs

6. **Stale-closure bug (likely; not run).**
   - In `hooks/useLiveData.ts`, `usePoll`'s effect deps are `[active, intervalMs]`, with exhaustive-deps lint disabled.
   - For flights, ships and satellites, `active = Boolean(runtime)`, so each tick keeps the **first render's** `layers` / `flightsActive`.
   - `shipTraffic` is off by default, so toggling it on later (including via the assistant) probably never renders ships, while the status bar still counts them.
7. **Unbounded sample growth.** `LayerRenderer.updateMoving` calls `SampledPositionProperty.addSample()` twice per poll per entity and never prunes old samples. Memory grows over long sessions.
8. **Satellite motion between polls is linear lat/lon extrapolation** (`predictPosition`) over 60 s, about 430 km, which is visibly wrong for orbits.
   - Speed uses a fixed `85,000 m/°` for longitude.
   - The heading `dLon` is not wrapped at the antimeridian.
   - TLEs are fetched once per process and never refreshed.
   - Only the first 60 objects of the `visual` group are used.
9. **OpenSky:** the first 350 states of the global array are used, which is not geographically representative. With the 14 s cache, anonymous quota exhaustion is likely [U], and the code then silently falls back to simulation.
10. **Categorizer is substring-based and order-dependent** (`news.js` L16–27):
    ```js
    cyber:      ['cyber','hack','ransomware','breach','malware','phishing','ddos']
    conflicts:  ['war','conflict','attack','military','strike','missile','troops','ceasefire','offensive']
    security:   ['terror','intelligence','espionage','spy','sanction','border security','homeland']
    politics:   ['election','president','parliament','minister','government','vote','senate','coalition','diplomat']
    economy:    ['market','trade','stock','financial','economic','currency','inflation','tariff','bank','gdp']
    climate:    ['storm','hurricane','typhoon','flood','drought','temperature','weather','wildfire','climate','earthquake']
    technology: ['ai ',' ai','artificial intelligence','tech','chip','software','digital','satellite','robot','startup']
    ```
    False positives include: "software" and "award" → `conflicts` (contain "war"); "said ", "Dubai " → `technology` ("ai "); "West Bank" → `economy`; "championship" → `technology` ("chip"); labour "strike" → `conflicts`.
11. **News refresh runs inside the request handler** with no in-flight dedupe. Concurrent requests after TTL expiry each fan out to every source.
12. **IDs are unstable.** NewsAPI/GNews article ids are index-based (`newsapi-${i}-…`), which skews the `newCount` "new articles" badge. Items without dates get `new Date()` and sort to the top as "just now".
13. **CORS rejection** throws an `Error`, which the central handler turns into a **500** rather than a CORS failure.
14. **`run.bat`** reports "AI assistant enabled (model: llama3.2)" based only on `where ollama`.
15. **Spec features never built:** Resium, MarineTraffic, Reuters RSS, framer-motion, breaking-news push/sound alerts, the 30 min chatbot response cache, request debounce, ESLint/Prettier.

### Secrets and error handling

16. **Hardcoded secrets: none found.**
    - Grepped source, configs and `.env.example` files for key/token/secret/password assignments and JWT/`sk-`/`AIza` patterns.
    - There are no `.env` files in `server/` or `client/`.
    - Key variables are read only from env: `NEWS_API_KEY`, `GNEWS_API_KEY`, `VITE_CESIUM_ION_TOKEN`.
17. **Error handling** is generally explicit: `allSettled`, try/catch per route, soft-fail geocode, `ErrorBoundary` in `App.tsx`. However, many client catch blocks silently swallow errors (`/* server offline */`), which hides failures.
18. **XSS:** low risk. No `innerHTML`, `dangerouslySetInnerHTML` or `rehype-raw`; `react-markdown` is used with default (escaped) rendering.

### Genuinely reusable

- `utils/coordinates.ts`, the decimal/DMS parser (pure, 56 lines)
- Nominatim proxy pattern: serialised ≥1.1 s queue, TTL cache, identifying User-Agent, soft-fail
- `Promise.allSettled` multi-source fetch + last-good cache pattern
- NDJSON stream reader, `<think>` stripping, `/api/tags` model discovery + picker, actionable Ollama error messages
- Live-context-to-prompt builder (concept)
- `sensorCones.ts`, a cosmetic Cesium primitive helper
- CSS token theming pattern (RGB channels + `[data-theme]`)
- `externalMaps.ts` (Google Maps deep links)

---

## 5. License and third-party data

- **`LICENSE`:** **MIT**, "Copyright (c) 2026 Cyberdyne Systems". Commit `58e3fa4` changed the holder to this name. "Cyberdyne Systems" is a **fictional entity**, not the author (the git remote belongs to `MuraliKannan172`). The author can relicense or re-attribute freely.
- **Branding caution [U]:** "Cyberdyne Systems" and "Skynet" come from the *Terminator* franchise, and "Cyberdyne Inc." is also a real company. This is worth noting before SKYNET is published or used commercially. It is not legal advice.
- **Bundled third-party data:**
  - No third-party datasets or files are bundled.
  - Static layers are hand-typed constants with no provenance, so there is no license obligation, but also no accuracy guarantee.
  - The embedded TLE block is synthetic (§4).
- **Runtime third-party services** (terms from general knowledge, all **[U]**):

  | Service | Terms note |
  |---|---|
  | Esri Canvas basemap tiles | Esri Terms of Use; attribution string present in `constants.ts` |
  | OpenSky | Research / non-commercial use; anonymous rate limits |
  | NewsAPI | Free tier development-only |
  | GNews | Free tier non-commercial |
  | BBC / Al Jazeera / CNN RSS | Publisher terms; headline + link display |
  | CelesTrak | Attribution; fetch-frequency etiquette |
  | Nominatim / OSM | Usage policy (implemented); ODbL attribution for results |
  | Google Maps | Deep links only, no API/key |
  | Google Fonts | Orbitron / Rajdhani / IBM Plex Mono, SIL OFL |
  | CesiumJS | Apache-2.0 |
