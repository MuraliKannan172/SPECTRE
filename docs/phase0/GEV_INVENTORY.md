# GEV Inventory (Phase 0 recon)

Upstream: `bilawalsidhu/gods-eye-view` main @ `7be5937f` (package.json `version: 0.2.1`, `name: gods-eye-view`).
Stack: Vite 6.4.3 (installed) + vanilla ES modules + CesiumJS ^1.124, Node `>=24.14 <25 || >=26 <27`.
~2181 tracked files (src 1734, scripts 163, server 106). Read-only audit; nothing executed except read-only git/grep.
"unverified" = not confirmed by reading code.

---

## 1. Feature inventory

### 1a. Data layers (catalog = `src/app/constructCatalog.js`; Data Layers grouping = `PANEL_GROUPS` in `src/ui/layerPanel.js:40`)

The catalog constructs 32 layers. 31 are in the share-link registry `LAYER_STATE_REGISTRY` (`src/data/layerState.js:587`) + 1 local-only (`local-adsb`, `LOCAL_ONLY_LAYER_METADATA`). Display names: `src/ui/layerNames.js`. Sources wired in `src/standalone/layerSources.js` + `src/sources/reference.js`; source contracts in `src/app/sourceComposition.js`.

| Feature (layer id) | Data Layers group | Share token | File(s) | Keys needed | Data source / license concern |
|---|---|---|---|---|---|
| Satellites (`satellites`) | Movement | `s` (+options) | `src/layers/satellites/*`, `src/app/layers/satellites.js` | none | CelesTrak TLE via `/api/celestrak/<group>` (groups: stations, visual, gps-ops, glo-ops, galileo, geo, starlink); US-gov origin, citation requested |
| Live Flights (`flights`) | Movement | `f` (+options) | `src/layers/flights/*`, `server/providers/aircraft/opensky.js` | optional `OPENSKY_CLIENT_ID`/`OPENSKY_CLIENT_SECRET`, `OPENSKY_AUTH_MODE` | OpenSky (non-commercial licence) + adsb.lol fallback (ODbL); adsbdb enrichment (route data "may not be copied" without permission) |
| Military Flights (`military`) | Movement | `m` (mirrored options) | `src/layers/military/*`, `server/providers/aircraft/adsb-lol.js` | none | adsb.lol (ODbL) |
| Local ADS-B (`local-adsb`) | Movement | none (local-only, never in links) | `src/layers/localAdsb/*`, `src/sdr/*`, `server/providers/local-receivers.js` | optional `LOCAL_RECEIVER_FEEDS`; WebUSB RTL-SDR | your own receiver; `@jtarrio/webrtlsdr` Apache-2.0 |
| Live Vessels (`ais-live-vessels`) | Movement | `a` | `src/layers/vessels/*`, `server/providers/vessels/*` | `AISSTREAM_API_KEY` (+`AISSTREAM_*` tuning, `VITE_AIS_LIVE_*`) | AISStream.io (beta, no formal ToS) |
| Street Traffic (`traffic`) | Movement | `t` (+options) | `src/layers/traffic/*`, `server/providers/traffic.js`, `overpass.js` | optional `TOMTOM_API_KEY`, `TOMTOM_DAILY_TILE_BUDGET`, `OVERPASS_UPSTREAMS` | Simulated vehicles on OSM roads (ODbL); TomTom flow proprietary (dynamic credit) |
| Transit (`transit`) | Movement | `j` | `src/layers/transit/*`, `src/data/transitFeeds.js`, `server/providers/transit.js` | none | Registered operator GTFS-RT feeds, per-operator terms (`transitFeedCredit`) |
| Bike Share (`bikeshare`) | Movement | `b` | `src/layers/bikeshare/*`, `server/providers/gbfs.js` | none | GBFS per-feed terms |
| Cameras / CCTV (`cctv`) | Cameras | `c` (+options) | `src/layers/cctv/*`, `src/ui/cctv*.js`, `server/providers/cctv*`, `config/cctv_sources.*.json` | none by default; `ONTARIO_511_API_KEY`; ~60 `CCTV_*` toggles; Google key for Street View fallback | ~25 city/DOT feeds, many "attribution REQUIRED"; FL511 & NYC DOT **off by default** (personal-use / data-sharing agreement) |
| Recent Imagery (`recent-imagery`) | Cameras | `1` (+options) | `src/layers/recentImagery/*`, `src/ui/recentImagery.js` | none | NASA GIBS + CMR, browser-direct, public domain (bounded use) |
| Street Level (`street-level`) | Cameras | `0` (+options) | `src/layers/streetLevel/*` (providers mapillary/google/kartaview/panoramax), `server/providers/mapillary*` | `MAPILLARY_CLIENT_TOKEN` (client-exposed by design), `GOOGLE_MAPS_API_KEY` for Street View | Mapillary/KartaView/Panoramax CC BY-SA 4.0; Google ToS (billed) |
| Mapped ALPR Cameras (`alpr-cameras`) | Infrastructure | `p` | `src/layers/alpr/*` | none | OSM (incl. DeFlock mapping), ODbL; politically sensitive content |
| Mapped Installations (`military-installations`) | Infrastructure | `i` | `src/layers/installations/*`, `server/providers/military-installations*` | none | Overpass/OSM (ODbL) + bundled Overture names (ODbL) |
| Data Centers (`local-datacenters`) | Infrastructure | `d` | `src/data/infrastructure.js`, `src/data/local_data/datacenters/` | none | Bundled OSM extract, ODbL |
| Submarine Cables (`telegeography-submarine-cables`) | Infrastructure | `u` | `src/layers/submarineCables/*` | none | **Bundled TeleGeography, CC BY-NC-SA 3.0 — NonCommercial** |
| Dams (`local-dams`) | Infrastructure | `q` | `src/data/infrastructure.js` | none | Bundled OpenInfraMap/OSM, ODbL (layer `source` string says "USACE" — inconsistent) |
| Space Missions (`rocket-launches`) | Events | `x` | `src/layers/launches/*`, `server/providers/space/launch-library.js` | optional `LL2_API_TOKEN` | Launch Library 2 (The Space Devs terms) |
| Earthquakes 24h (`earthquakes`) | Events | `e` | `src/layers/earthquakes/*` | none | USGS `all_day.geojson`, **browser-direct** (no proxy), public domain |
| Active Fires (`local-firms`) | Events | `w` | `src/layers/firms/*`, `server/providers/firms.js` | `FIRMS_MAP_KEY` | NASA FIRMS (acknowledgement) |
| Fire Perimeters (`fire-perimeters`) | Events | `2` | `src/layers/perimeters/*`, `server/providers/firePerimeters.js` | none | NIFC WFIGS + InciWeb links, public domain |
| GNSS Integrity (`gnss-integrity`) | Events | `3` | `src/layers/gnss/*`, `server/providers/gnssIntegrity.js` | none | adsb.lol (ODbL), GPSJAM-style aggregation |
| Air quality (`air-quality`) | Weather | `4` | `src/layers/airQuality/*` | none | ECCC MSC GeoMet (Canada only), ECCC end-use licence; transport (direct vs proxy) unverified |
| Wind (`wind`) | Weather | `k` (+options) | `src/layers/wind/*`, `server/providers/wind*` | none | NOAA GFS (PD) / ECMWF IFS (CC BY 4.0 + ECMWF terms) |
| Rain radar (`weather-radar`) | Weather | `v` (+options) | `src/layers/weather/*`, `server/providers/weather.js` | none | NOAA nowCOAST |
| Satellite clouds (`weather-satellite`) | Weather | `o` (+options) | same | none | NOAA nowCOAST (GOES) |
| Lightning density (`weather-lightning`) | Weather | `l` (+options) | same | none | NOAA nowCOAST (Vaisala-derived) |
| Cyclone advisories (`weather-cyclones`) | Weather | `y` | `src/layers/cyclones/*`, `server/providers/cyclones.js` | none | NOAA NHC/CPHC |
| Directions (`directions`) | Utilities | `n` | `src/layers/directions/*`, `server/providers/places/routes.js` (`/api/route`) | none | OSRM on FOSSGIS servers (usage policy: attribution + UA) |
| Radio (`radio`) | Utilities | `r` (+options) | `src/layers/radio/*`, `src/ui/radio*.js`, `server/providers/radio*` | none | Radio Browser (PDDL); broadcaster stream terms |
| Global Context (`military-awareness`) | not in Data Layers (own right-rail panel) | `g` | `src/layers/awareness/*`, `src/data/militaryAwareness*.js` | none | derived from flights/military/vessels/installations |
| Bhote Koshi 2026 event (`bhote-koshi-2026`) | hidden (`showInTogglePanel:false`, Scenes only) | `h` | `src/data/bhoteKoshi*.js`, `public/events/bhote-koshi-2026/` | none | Vantor/GeoPera **CC BY-NC 4.0** |
| Bhote Koshi locator (`bhote-koshi-locator`) | hidden | `z` | `src/data/bhoteKoshiLocator.js` | none | GeoPera CC BY-NC 4.0 |

Any layer not listed in `PANEL_GROUPS` but with `showInTogglePanel !== false` renders under a fallback heading "Other layers" (`layerPanel.js:297`).

### 1b. Non-layer features (panels, HUD, modes, tools)

| Feature | Kind | File(s) | Keys needed | Data source / license concern |
|---|---|---|---|---|
| Map Stack (photoreal / esri-imagery / bing-aerial / bing-labels / osm) | panel + share `map` | `src/maps/*`, `src/ui/mapSource*.js`, `src/mapStackChips.js`, `src/mapStartup.js` | `GOOGLE_MAPS_API_KEY` (direct 3D) or `CESIUM_ION_TOKEN` (ion 3D/Bing); keyless Esri | Google Maps Platform ToS; Esri Master Agreement; ion terms (personal non-commercial) |
| Terrain heights | server route | `server/providers/terrain.js`, `src/services/terrainHeights.js` | none | Re:Earth/Mapterhorn CC BY 4.0, EGM2008 PD; Kartverket for Norway CCTV |
| Sensor styles: normal, CRT(`retro`), NVG(`surveillance`), FLIR(`thermal`), anime, noir, snow | mode + share `style`,`sp` | `src/styles/{retro,surveillance,thermal,anime,noir,snow}.js`, `src/ui/visualEffects.js`, `src/ui/styleParameters.js`, `src/view/index.js` (`STYLE_URL_NAMES`) | none | GLSL in-repo |
| Bloom / sharpen | display toggles | `src/bloom.js`, `src/ui/visualSettings.js` | none | - |
| HUD layouts tactical/operator/minimal/cyber | HUD widget | `src/hud.js`, `src/hudLayouts.js`, `src/hudLayoutPolicy.js`, `src/hudLocality*.js` | caption via `/api/openai/hud-summary` needs `OPENAI_API_KEY` (`OPENAI_HUD_SUMMARY_MODEL`, default gpt-5-nano) | OpenAI |
| Cyber theme (`<html data-ui-theme="cyber">`) + Cyber sonar | theme/mode | `src/ui/styles/cyber.css` (2862 lines), `src/cyberSonar*.js`, `src/ui/cyberSonarControls.js` | none | - |
| Detection overlay (bounding boxes) | overlay | `src/data/detection*.js` | none | - |
| Celestial ring / keyhole, scope mask, 3D models toggle, draw tool, geo-file import | Display panel controls | `src/celestialRing.js`, `src/scopeMask.js`, `src/annotations/draw*.js`, `src/ui/geoFileImport.js` (formats unverified) | none | 3D aircraft models CC BY 4.0 (`public/models/README.md`) |
| Clean view (`V` key / `clean-view-toggle`) | mode | `src/ui/displayControls.js`, `src/ui/applicationShortcuts.js` | none | - |
| Recording mode (hide panels, minimal HUD, 16:9 / 9:16 safe frame) | mode | `src/ui/recordingControls.js`; entered by Director (`src/scenes/director.js:1822`) | none | - |
| "light-clean" mode | - | **not found** (no `light-clean`/`lightClean` symbol) — unverified/absent | - | - |
| Cockpit mode (ride a tracked aircraft; instruments, briefing strip with regional headlines, WX volumetric clouds, Contacts) | mode | `src/ui/cockpit*.js`, `src/ui/templates/cockpit.html`, `src/cockpit*.js` | none | Briefing uses `/api/regional-brief` (Nominatim place, Open-Meteo CC BY 4.0, Google News RSS **personal/non-commercial** → GDELT fallback) |
| Global Context (Contacts, Space Missions) | right-rail panel / context mode | `src/ui/context*.js`, `src/layers/launches/panel.js` | none | - |
| Director scenes (capture/playback, data packs, `.gevbundle.json` import/export) | panel + mode | `src/director/*`, `src/scenes/*`, `src/ui/scene*.js`, docs `docs/DIRECTOR*.md` | none | Bundled pack: Bhote Koshi (CC BY-NC 4.0) |
| Voice whiteboard annotations | tool + share `an` | `src/annotations/*` | via voice | - |
| Imagery split / box tool | tool | `src/ui/imagerySplit.js`, `src/ui/imageryBoxTool.js` | none | - |
| Share links | `share-btn` | `src/sharelink.js`, `src/data/layerState.js`, `src/ui/shareRestoration.js` | none | - |
| Location search / geocode / keyless search | dock | `src/search/*`, `src/ui/location*.js` | optional Google keys | Photon (fair use), Nominatim, Google |
| Weather panel | right-rail panel | `src/ui/weatherPanel.js` | none | - |
| Radio panel + local RTL-SDR card | right-rail panel | `src/ui/radio*.js`, `src/ui/localSdr*.js`, `src/sdr/*` | none | Apache-2.0 deps |
| CCTV / Street Level / Recent Imagery panels | left/right rail | `src/ui/templates/layer-panels.html`, `context.html` | per layer | per layer |
| Provider Settings ("POWER UP") | dialog | `src/keySetup.js`, `src/keySetupCore.mjs`, `src/ui/templates/provider-settings.html`, `server/standalone/key-setup.js` | writes the keys above | - |
| First-run launcher / welcome | dialog | `src/firstRunExperience.js`, `src/ui/templates/welcome.html` | none | - |
| Locale picker | corner | `src/ui/localePicker.js` | none | - |
| Voice (GEV MIC): OpenAI Realtime, Gemini Live | dock + voice card | `src/voice/*`, `server/providers/openai*`, `server/providers/gemini*` | `OPENAI_API_KEY` (or Codex ChatGPT OAuth, `GEV_PREFER_CODEX_OAUTH`), `GEMINI_API_KEY`, `OPENAI_REALTIME_*`, `GEMINI_LIVE_MODEL` | paid APIs |
| MCP server (stdio + `/mcp`) + MCP Apps panel | server | `server/mcp/*`, `src/tools/*`, `scripts/build-panel.mjs` | none | - |
| Embed mode `?embed=1` | mode | `src/app/embed.js`, `build/embed-framing.js` | `GEV_EMBED_FRAME_ANCESTORS` | - |
| Keyboard shortcuts h/o/v/f/d/c | input | `src/ui/applicationShortcuts.js` | - | - |
| Starfield sky | render | `src/sky/*` | none | Yale BSC (PD), ESO Milky Way CC BY 4.0 |
| Pinokio launcher | script | `pinokio/*`, `scripts/pinokio-*.mjs` | - | - |
| Docker | script | `Dockerfile`, `compose.yaml` (publishes `127.0.0.1:4173`), `scripts/docker-start.mjs` | - | - |

---

## 2. Voice tools

### 2a. App actions (29) — schemas in `src/voice/actionSchemas.js` (`GEV_ACTION_SCHEMAS`); model-facing descriptions in `server/providers/openai/toolDescriptions.js` (`ACTION_DESCRIPTIONS`); browser execution in `src/voice/gevActions.js` (`createGevActionRunner`, 4885 lines)

| Tool | Purpose | Parameters |
|---|---|---|
| `fly_to_location` | Fly camera to preset city / geocoded place / lat-lon | locationId, query, latitude, longitude, viewMode, rangeM, waitForArrival, referent |
| `select_nearest_aircraft` | Fly, enable Flights/Military, select nearest airborne | layerId*, locationId, locationQuery, latitude, longitude |
| `adjust_camera_zoom` | Relative zoom | direction*, amount* |
| `zoom_to_globe` | Full-Earth view | - |
| `set_layer_visibility` | Enable/disable one layer | layerId*, enabled* |
| `show_data_layers_menu` | Open Data Layers, scroll to row | layerId |
| `set_panel_open` | Open/close a UI panel | panelId*, open* |
| `set_context_mode` | Enter/exit Global Context (Contacts / Space Missions) | mode* |
| `control_cockpit` | Enter/exit/navigate Cockpit | action*, targetLayer, aircraftClass |
| `set_visual_style` | Set sensor style | style* |
| `get_entity_context` | Scene context, selected + visible entities | scope, referent, layerId, limit |
| `get_current_view_state` | Read camera/style/HUD/layers state | - |
| `set_hud` | HUD visibility/layout | visible, layout |
| `set_cyber_sonar` | Cyber-only sonar settings | enabled, rings, rangePct, intensityPct, opacityPct, sectorDeg |
| `set_detection` | Detection overlay | enabled, mode, densityPct, allocationStrategy |
| `set_map_stack` | Switch basemap stack | stack* |
| `set_post_processing` | Bloom/sharpen | bloom{}, sharpen{} |
| `control_scene` | Director playback list/play/stop/next/status | action*, sceneId |
| `control_cctv` | CCTV select/next/nearest/coverage/etc. | action*, cameraQuery, enabled |
| `control_radio` | Radio playback/selection | action*, volumePct, category, locationId, locationQuery, latitude, longitude, country, stationQuery |
| `track_entity` | Follow aircraft/ship/satellite | query, layerId, referent |
| `stop_tracking` | Stop following | - |
| `frame_overhead` | Frame nearby entities | target*, radiusKm |
| `annotate_map` | Voice whiteboard marks | annotations*, flyTo, persist |
| `clear_annotations` | Erase annotations | - |
| `move_camera` | Drone-style orbit/pan/tilt | motion*, direction, speed, mode |
| `fly_route` | Dolly along a drawn route | label, speed |
| `analyst_query` | Count/filter/rank loaded records | layers, scope, filters, sortBy, sortDir, limit, followUp |
| `next_iss_pass` | Next ISS pass | latitude, longitude, minElevationDeg |
| `next_satellite_pass` | Next pass of a named/NORAD satellite | target*, latitude, longitude, minElevationDeg, visibleOnly |

(* = required.) Layer enums come from `src/voice/layerManifest.js` (`VOICE_TOGGLE_LAYER_IDS`, `VOICE_QUERY_LAYER_IDS`, `VOICE_CONTEXT_LAYER_IDS`); `layerManifest.test.mjs` fails if a catalog layer is neither listed nor in `VOICE_OFF_LAYERS`.

### 2b. Catalog query tools (`src/tools/queries/*.js`, defined with `defineTool`) also offered on voice
Voice surface (`src/tools/surfaces.js` `TOOL_SURFACES`) adds: `get_recent_launches`, `get_aircraft_track`, `get_aircraft_info`, `get_vessel_track`, `find_cctv_cameras`, `find_alpr_cameras`, `find_radio_stations`, `search_places`, `places_nearby`, `plan_route`, `get_bike_share`, `get_transit_vehicles`, `get_traffic_flow`, `get_weather`, `get_wind`, `find_submarine_cables`, `get_bhote_koshi_flood`, `get_regional_brief`, `get_cyclones`, `get_fire_perimeters`, `get_terrain_height`, `find_military_installations`, `get_map_features`, `situation_brief`, `military_awareness`. Voice-off: `show_in_gods_eye_view`, `panel_request`, `next_satellite_pass` (action wins), `get_weather_map`, `get_recent_imagery`, `get_cctv_snapshot`, `get_hud_caption`, `aircraft_in_area`, `vessels_in_area`, `find_aircraft`, `find_vessel`, `get_earthquakes`, `get_active_fires`, `find_infrastructure`, `satellites_overhead`. Full table: `docs/TOOLS.md`. `coreTools` (`src/tools/index.js:86`) has 40 tools; 15 are voice-off, so the voice session = 29 actions + 25 queries = 54 tools (counted from source, not by running code).

### 2c. Schema format
- App actions: plain JSON Schema `parameters` objects; `createActionTools(descriptions)` merges descriptions and emits **OpenAI Realtime/Responses-style flat function tools** `{ type: 'function', name, description, parameters }` (top-level `anyOf/oneOf/allOf` stripped). Exported as `GEV_REALTIME_TOOLS` in `server/providers/openai/tools.js`.
- Catalog tools: `defineTool({ name, kind: 'query'|'action', title, description, inputSchema, requires, run })` validated by `src/tools/schema.js` (JSON-Schema subset); `toFunctionTools()` (`src/tools/functions.js`) converts to the same flat shape; results via `toFunctionOutput()` → `{ ok, tool, summary, data, images_omitted? }`.
- **Not** Chat Completions/Ollama shape (`{type:'function', function:{...}}`). A converter already exists in `scripts/voice-bench/toolFormats.mjs` (`toChatTools`, `normalizeSchemaForChat` — adds a permissive scalar `type` to untyped props such as `analyst_query.filters[].value`, which crashed Gemma chat templates; also `toGeminiSchema`).

Shape quote (verbatim, `src/voice/actionSchemas.js:133-147`):
```js
    name: 'set_layer_visibility',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        layerId: {
          type: 'string',
          enum: toggleLayerIds(),
        },
        enabled: {
          type: 'boolean',
        },
      },
      required: ['layerId', 'enabled'],
    },
```
Descriptions are injected separately from `server/providers/openai/toolDescriptions.js` (with `$position` ordering).

### 2d. Providers and how they consume tools
- Server composes the list once: `server/standalone/voiceTools.js` → `realtimeSessionTools(toFunctionTools(toolsForSurface(coreTools,'voice')))` (actions first; catalog tools whose names an action uses are skipped). Passed to `localProviderPlugins({ realtime: { tools }, gemini: { tools } })`.
- **OpenAI Realtime** (WebRTC): `server/providers/openai/realtime.js` mints an ephemeral client secret at `/api/realtime/token` with `session.tools = tools` and `instructions = realtimeInstructions()` (`server/providers/openai/instructions.js`, "You are GEV Voice Control..."). Auth = `OPENAI_API_KEY` or Codex ChatGPT OAuth (`server/providers/openai/codex-auth.js`, experimental). Tiers standard/mini (`src/voice/voiceCost.js` `VOICE_MODELS`).
- **Gemini Live** (WebSocket): `server/providers/gemini/config.js` maps the same list to `functionDeclarations` with `parametersJsonSchema` and `behavior:'BLOCKING'`; token at `/api/gemini/token`; client `src/voice/geminiSession.js`.
- **No on-device/local provider in the shipped app.** `VOICE_PROVIDERS = { openai, gemini }` (`src/voice/providerCapabilities.js`); standalone enables `['openai','gemini']` (`src/standalone/tools.js`).
- Execution is **in the browser**: `withToolCatalog()` in `src/voice/gevRealtime.js` routes names in `GEV_ACTION_SCHEMAS` to the action runner (`gevActions.js`), other names to the lazily loaded catalog (`src/standalone/toolCatalog.js` → `catalog.call(name,args,{signal})` over page `fetch` to `/api/*`). This dispatcher is the natural seam for a unified registry.
- Dev-only local LLM path exists: `scripts/qa-voice-bench.mjs` + `scripts/voice-bench/adapters/localChat.mjs` (`createOllamaAdapter`: native `/api/chat`, `num_ctx` default 32768, `think:false`; also OpenAI-compatible `:11434/v1` / LM Studio `:1234/v1`). Its header notes the production prompt+tools ≈ 15k tokens and that the OpenAI-compatible `/v1` shim **cannot set `num_ctx`, so the prompt is silently truncated** at Ollama's small default context — use native `/api/chat`.
- **Registry constraint for a browser-side unified tool registry:** the model-facing wording lives under `server/` — `ACTION_DESCRIPTIONS` (`server/providers/openai/toolDescriptions.js`), `realtimeInstructions()` (`server/providers/openai/instructions.js`), and the composed list (`server/standalone/voiceTools.js`). `check:boundaries` forbids `src/ → server/` imports, so browser code cannot import them. Precedent for the fix: `src/voice/layerManifest.js` and `src/voice/actionSchemas.js` are pure-data `src/` modules that the server imports. Options: (a) move descriptions + instructions into a pure `src/voice/` module; (b) expose the composed tools + instructions from a server endpoint; (c) run the LLM loop server-side and send tool calls to the browser runner (`withToolCatalog` dispatcher).

---

## 3. Share-link schema

- Owner: `src/sharelink.js` (`ShareLinkManager`), state lives in the **URL hash** (`#lat=..&lon=..`), written with `history.replaceState`, debounced 500 ms. `?lang=` (query, `src/i18n/locale.js`) and `?embed=1` are query params, not hash; `lang` is stripped from copied links.
- Hash params: `lat lon alt heading pitch roll` (camera), `style` (`normal|crt|nvg|flir|anime|noir|snow`), `sp` (per-style params, `SHARE_STYLE_PARAM_REGISTRY`), `bloom bi bv sharpen si`, `hud hv`, `dm dd da kf ko` (detection), `cr` (celestial ring), `sc scf sce` (scope), `map`, `ui` (panel open/pin state, `SHARE_PANEL_STATE_REGISTRY` tokens c,l,d,v,i,t,r,s,g,p,m), `at` (created-at seconds), `v=2` (schema version), `l` (enabled layers), `lo` (layer options), `an` (annotations, `src/view/index.js` `ANNOTATION_PARAM`). Parsing bounded: `l` ≤ 4096 chars, `lo` ≤ 512; any unknown/duplicate token rejects the whole layer payload.
- Layer tokens: `l` = dot-joined tokens in **registry order**; `lo` = `_`-joined `<layerToken>.<optionToken>.<value>`. Defaults omitted (against `absentValue`).
- Token rules (`src/data/layerState.js`, `CONTRIBUTING.md` "Share-link layer tokens"): tokens are permanent; ledger `src/data/layerStateTokenReservations.json` (31 rows). New layers consume free digits `0-9` first, then `00..zz`. Owned digits: 0,1,2,3,4 → **next free token = `5`** (CONTRIBUTING's "next 4" text is stale). `npm run layer-token:next -- <id>` prints it; `npm run layer-token:check -- --base-ref origin/main` (CI on PRs) verifies published tokens are unchanged and new ones allocated in order (`validateLayerStateAllocations`).
- **What a new shareable layer must register to round-trip:**
  1. Row `["<id>", "<token>"]` in `src/data/layerStateTokenReservations.json`.
  2. Entry `{ id, token, disposition }` in `LAYER_STATE_REGISTRY` (`enabled-only` | `enabled+options` | `enabled+mirrored-options`; option-bearing entries also need `optionOwner` and an `OPTION_GROUPS[...]` spec list).
  3. Update pinned counts in `src/data/layerState.test.mjs` (`REGISTERED_LAYER_IDS.length === 31`). The registry must stay **alphabetical by id** (`layerState.test.mjs:208` asserts `REGISTERED_LAYER_IDS` equals its sorted copy); since registry order is URL order, insert e.g. `news` between `military-installations` and `radio`.
  4. Layer constructed in `createApplicationCatalog` with matching `id` (`createLayerCatalog` throws on unmatched/missing metadata).
  - A layer that must never enter links goes in `LOCAL_ONLY_LAYER_METADATA` instead (`disposition:'local-only'`).
  - Local storage mirror: key `gev:layer-state:v2`.
- Director scenes are shared as files/bundles (`.gevbundle.json`), not URLs (`docs/DIRECTOR-SHARING.md`).

---

## 4. MCP server (`server/mcp/`)

- Transports: **stdio** (`server/mcp/stdio.js`, `npm run mcp -- [--api-base http://localhost:4173]`, newline-delimited JSON-RPC) and **stateless Streamable HTTP** at `/mcp` on the dev/preview servers (`server/mcp/plugin.js` `localMcpPlugin`, one JSON-RPC message per POST, 1 MiB body cap). Protocol core: `src/tools/mcp/{protocol,http,index}.js` (revisions 2025-11-25, 2025-06-18, 2025-03-26; `initialize`, `ping`, `tools/list`, `tools/call`, `resources/list|read`).
- `/mcp` gate (`isLocalMcpRequest`): loopback socket + loopback Host on the arrival port + same-host Origin + no proxy headers + Pinokio sharing off.
- Tools: `catalogForSurface(composeCatalog({tools: coreTools, services: createLocalToolServices({apiBase})}),'mcp')` — the same `src/tools` catalog voice uses; services fetch the running app's `/api/*` (`server/mcp/services.js` `createApiFetch`). Server name `gods-eye-view`, `INSTRUCTIONS` string in `server/mcp/server.js`.
- MCP-only tools: `show_in_gods_eye_view`, `panel_request` (app-visibility, keyed by `server/mcp/panelKey.js`; refuses `/api/setup`, `/api/realtime`, `/api/openai`, `/mcp`). MCP-off: places, routing, weather, wind, regional brief, radio, bike share, transit, HUD caption.
- Mapping to voice: **MCP does not expose the 29 app actions** (they need the live browser globe); voice gets actions + catalog queries; MCP gets catalog queries + share/panel tools. One resource: `ui://gods-eye-view/globe` (`src/tools/globePanel.js`).

---

## 5. Server

### 5a. Structure and mounting
- No standalone HTTP server: everything is **Vite middleware** (dev + `vite preview`). `vite.config.js` → re-exports `server/standalone/vite.config.js`, which loads `.env` (`loadEnv`, without overriding real env), builds `standaloneVoiceTools()`, and calls `createBrowserViteConfig` (`build/vite.js`) with plugins in this order:
  `apiResponseHeadersPlugin` (pre; CSP `default-src 'none'; sandbox` + nosniff on every `/api`) → `hostCheckPlugin` (pre; Host allowlist) → `vite-plugin-cesium` → `applicationHtmlPlugin` (expands `<!-- gev:template X -->` from `src/ui/templates/`) → `...localProviderPlugins()` (`server/providers/local.js`, 30 plugins) → `localMcpPlugin()` → `apiNotFoundPlugin()` (catch-all `/api` → 404 JSON) → `unwatchedRuntimeDirsPlugin()` → `embedFramingPlugin()` → `panelBuildPlugin()`.
- Each provider is a Vite plugin `{ name, configureServer(server){ server.middlewares.use('/api/x', handler) }, configurePreviewServer: same }` (examples: `server/providers/transit.js`, `server/providers/space/celestrak.js`).
- Document headers: `BROWSER_CSP` (`connect-src 'self' blob: data: https: wss: ws:`), `X-Frame-Options: DENY`. `server.fs.deny` covers `.env*`, certs, `.git`.

### 5b. `/api/*` routes (by area)
- Aviation: `/api/flights`, `/api/flights/track`, `/api/military`, `/api/military/track`, `/api/adsbdb`, `/api/local-receivers/aircraft`, `/api/gnss-integrity`
- Maritime: `/api/vessels`
- Space: `/api/celestrak/<group>`, `/api/launches`
- Hazards/weather: `/api/firms`, `/api/fire-perimeters`, `/api/cyclones`, `/api/wind` (+`/api/wind/grid/...`), `/api/weather` (+`/tile`, `/image`), `/api/weather-effects`
- Mobility: `/api/tomtom` (+`/flow/...`), `/api/transit`, `/api/gbfs`, `/api/route`
- Places/geo: `/api/geocode` (Nominatim), `/api/regional-brief`, `/api/google/{nearby-places,text-search,geocode,reverse-geocode}`, `/api/overpass`, `/api/military-installations`, `/api/terrain/heights`
- Media: `/api/cctv` (+`/frame/`, `/media/`), `/api/radio`, `/api/mapillary/{status,tiles}`
- AI/voice: `/api/realtime/{token,debug-log,oauth-status,oauth-login}`, `/api/openai/hud-summary`, `/api/gemini/token`
- Settings: `/api/setup/status`, `/api/setup/keys` (dev only)
- Non-`/api`: `/mcp`, `/panel/`, `/scene-assets/`

### 5c. Proxy / cache / rate-limit patterns
- Upstream fetch: global `fetch` + `AbortSignal.timeout`, capped body reads (`server/providers/common/http.js` `readResponseTextCapped`, `coalesceProxyRequest` for in-flight de-dup), fixed upstream hosts only (no client URLs; SSRF rules in SECURITY.md).
- Cache: per-plugin in-memory `Map` + optional disk cache under `.gev-cache/` (e.g. `celestrak-<group>.json`, TTL 6 h, serve-stale on error; `x-*-cache` headers).
- Rate limiting: `makeRateLimiter({windowMs,max,globalMax})` (`src/sources/rateLimit.js`), per socket IP via `clientKey(req)` (ignores X-Forwarded-For); cost endpoints use `makeCostRateLimiter(env, default)` (`GEV_RATELIMIT_OPENAI_PER_MIN` default 30, `GEV_RATELIMIT_GOOGLE_PER_MIN` 120, `GEV_RATELIMIT_GEMINI_PER_MIN`); `0` disables, typos fall back to default.
- Cross-site gate: `sameSiteGated(handler)` / `admitSameSite` (`server/providers/common/same-site.js`) for cost/log routes; `admitSameSiteKeyless` for keyless routes.

### 5d. Bind address and LAN opt-in
- Default host `localhost` (`createBrowserViteConfig` `host = 'localhost'`, port `4173`); `HOST`/`PORT` env override. `DEFAULT_ALLOWED_HOSTS = ['localhost','127.0.0.1']` + `GEV_ALLOWED_HOSTS` (no wildcards); IPs always accepted.
- LAN opt-in = `HOST=0.0.0.0` (or `npm run dev -- --host 0.0.0.0`). Warning text locations: `scripts/dev-fresh.sh:294-303` (prints "!! This dev server brokers your configured API keys..." + LAN URL), `.env.example:135-147`, `README.md:614-616` ("Sharing an instance"), `SECURITY.md:85-112`. Docker sets `HOST=0.0.0.0` in-container but `compose.yaml` publishes `127.0.0.1:4173:4173`.
- Provider Settings refuses LAN peers, tunnels and Pinokio sharing (`admitKeySetupRequest`, `isSharingEnabled` in `src/keySetupCore.mjs`).

### 5e. Provider Settings secret storage
- `server/standalone/key-setup.js`: `GET /api/setup/status` (presence only), `POST /api/setup/keys` upserts the **repo-root `.env`** (or `pinokio/ENVIRONMENT` when launched by Pinokio), sets `process.env` live, restarts Vite. Key registry: `src/keySetupCore.mjs` (google-maps, google-maps-server, openai, gemini, aisstream, firms, tomtom, cesium-ion, opensky, mapillary, launch-library).
- Write path: refuses symlinks, temp file opened `wx` mode `0o600`, `hardenCredentialFile()` **before** writing the secret (`server/standalone/key-setup-hardening.mjs`: POSIX `chmod 600` (+`/bin/chmod -N` on macOS); Windows `whoami.exe /user` + `icacls.exe` to restrict to the user SID), fsync, atomic rename. Loopback-only; dev server only (`apply: 'serve'`).

### 5f. `.gev-logs` convention
- Gitignored runtime dirs `.gev-cache/` and `.gev-logs/` (also in `.dockerignore`, `.prettierignore`; unwatched by Vite via `server/standalone/unwatched-cache.js`).
- Voice log: `server/providers/openai/debug-log.js` → `.gev-logs/realtime-conversations.jsonl`, JSONL append, 120 req/min, 8 MiB per request, rotates at 32 MiB to `.jsonl.1` (one generation), secrets/image redaction, content omitted unless `GEV_VOICE_LOG_CONTENT=1`. QA harnesses write under `.gev-logs/<harness>/`.

### 5g. Cleanest place for `/api/intel/*` → `http://127.0.0.1:8100`
- **Do not use Vite `server.proxy`/`preview.proxy`**: verified in installed Vite 6.4.3 (`node_modules/vite/dist/node/chunks/dep-Dm0c1Wj2.js:38814-38833`, preview `:48433-48446`) that `configureServer`/`configurePreviewServer` middlewares run **before** Vite's `proxyMiddleware`, so `apiNotFoundPlugin`'s `/api` catch-all would 404 `/api/intel` first.
- Recommended: new provider plugin `server/providers/intel.js` exporting `intelProxy({ upstream = 'http://127.0.0.1:8100' })` following `transitProxy` shape (`configureServer` + `configurePreviewServer`, `server.middlewares.use('/api/intel', ...)`), registered in `localProviderPlugins()` in `server/providers/local.js` (any position before `keySetupEndpoint()`; all of these precede `apiNotFoundPlugin`). Fixed upstream from env (e.g. `SKYNET_INTEL_URL`, loopback only), method allowlist, capped bodies via `common/http.js`, `makeRateLimiter` + `clientKey`, and `sameSiteGated` if the service is costly. The API CSP/nosniff headers are applied automatically. Add the path to `panel_request`'s refusal list if MCP panels must not reach it (`src/tools/queries/panelRequest.js`).
- **CSP forces same-origin proxying:** `BROWSER_CSP` `connect-src 'self' blob: data: https: wss: ws:` has **no `http:`**, so page `fetch` to `http://127.0.0.1:8100` (FastAPI) or `http://127.0.0.1:11434` (Ollama) is blocked. Both must go through Vite middleware routes (e.g. `/api/intel/*`, `/api/ollama/*` or via FastAPI). Widening `connect-src` is possible: `src/tooling/viteBuild.test.mjs:36` only asserts equality with the `BROWSER_CSP` constant and pins other directives (script/frame), no connect-src assertion found; it would still weaken the security posture.
- Bookkeeping: new Node module under `server/providers/` is subject to `check:boundaries` (no imports from `server/standalone/` or renderers); if exported via `package.json`, add a group in `scripts/package-boundaries.json`.

---

## 6. Extension points

### 6a. Adding a layer (minimal pattern = Earthquakes)
- Layer object (`src/layers/earthquakes/index.js`): factory `createEarthquakesLayer({ source, overlayHost })` returns `{ id, name, icon, source, updateInterval, init(viewer), enable(viewer), disable(viewer), update(viewer,{signal}), destroy(viewer), getStats() → {count,lastUpdate,error}, getAnalystRecords?(max) }`. Optional fields used by lifecycle (`src/data/lifecycle.js`): `showInTogglePanel` (default true), `requiresKeyId` (key-guidance tooltip), `getDetectableObjects`.
- Source (`src/layers/earthquakes/source.js`): `createUsgsEarthquakeSource({ fetchImpl })` → `{ getSnapshot({signal}) }`; must stay portable (no Cesium/DOM/server imports; enforced).
- App wrapper (`src/app/layers/earthquakes.js`, 6 lines): injects the shared `overlayHost`.
- Wire-up checklist for a new layer `news`:
  1. `src/layers/news/{index,source,records}.js` (+ tests beside them).
  2. `src/app/layers/news.js` wrapper; add to the array in `src/app/constructCatalog.js`.
  3. Source contract in `CATALOG_SOURCE_CONTRACTS` (`src/app/sourceComposition.js`) and default instance in `src/standalone/layerSources.js` (or `src/sources/reference.js`).
  4. Share token: ledger + `LAYER_STATE_REGISTRY` + test count (Section 3), or `LOCAL_ONLY_LAYER_METADATA`.
  5. Data Layers group: add the id to `PANEL_GROUPS` in `src/ui/layerPanel.js` (e.g. Events or a new group with `msg('News')`); name in `LAYER_NAME_KEYS` / `PANEL_LABEL_KEYS` (`src/ui/layerNames.js`).
  6. Voice: entry in `src/voice/layerManifest.js` (aliases/toggle/query) or `VOICE_OFF_LAYERS`, else `layerManifest.test.mjs` fails.
  7. Credits: `DATA_CREDITS` (`src/data/dataCredits.js`) + `DATA_SOURCES.md`.
  8. i18n strings in `src/i18n/locales/{es,ru}.json`.
  9. `scripts/package-boundaries.json`: add every new module reachable from an exported group (the catalog is reachable from `./application/layers` and others — lines ~1711, ~2553 of that file), else "imports an unowned module".
- World labels must go through the world-overlay host (`overlayHost.setEntries`); Cesium text labels are forbidden (`src/noCesiumLabels.test.mjs`, `docs/CODE-BOUNDARIES.md`).

### 6b. Credits / "Data attribution" popover
- `src/data/dataCredits.js`: `DATA_CREDITS` array of `{ key, html }` registered once by `registerDataCredits(viewer)` as `new Cesium.Credit(html, false)` (showOnScreen=false → Cesium's credit lightbox, styled in `src/ui/styles/foundation.css` `.cesium-credit-lightbox*`). Conditional credits: `registerDynamicCredit(viewer, credit)` (idempotent per key; e.g. `TOMTOM_CREDIT`). Short on-globe OSM credit: `showOsmCredit/hideOsmCredit`. Existing keys include `google-news-rss` and `gdelt` (cockpit headlines). Comment requires mirroring `DATA_SOURCES.md`.

### 6c. Panels and docking
- Static panels are HTML templates in `src/ui/templates/*.html` expanded at build/serve time by `build/application-html.js` from `<!-- gev:template name -->` markers in `index.html` (allowlisted names: scene-chrome, cockpit, display-controls, command-dock, layer-panels, context, welcome, provider-settings, hud-loading).
- Rails: left `#left-panel-stack` (data-panel, cctv-panel, street-level-panel, scene-panel), right `#right-context-rail` (weather-panel, recent-imagery-panel, global-context-panel, radio-panel, pp-toggles). Contract in `docs/panel-surfaces.md`: outer `.panel-collapsible[data-panel-id]`, first child `[data-panel-surface]`, `[data-panel-header]`, `[data-panel-body][data-rail-scroller]`; dock surfaces inside `#command-dock`; or `dialog[data-panel-surface]`.
- Startup panels: `PanelChrome` (`src/ui/panelChrome.js`) binds `.panel-collapse-btn[data-collapse-target]`. Dynamic panels: `bindPanelDisclosure` / `collapsePanelOnEscape` (`src/ui/panelDisclosure.js`); layout via `layoutLeftPanelRail` / `layoutRightPanelRail` (`src/ui/leftPanelRail.js`, `rightPanelRail.js`). Share `ui=` panel tokens are a closed registry in `src/sharelink.js` (`SHARE_PANEL_STATE_REGISTRY`) — a new panel is not persisted unless added there. Voice `set_panel_open` enum also enumerates panels.
- Shell ownership: `src/ui/applicationShell.js` (1755 lines) + `shellFacade.js`; see `docs/UI-OWNERSHIP.md`.

### 6d. i18n (`scripts/i18n.mjs`, `docs/I18N.md`)
- English text is the key; `t()`, `tn()`, `msg()` from `src/i18n/index.js` (portable code uses `src/i18n/marker.js`); markup `data-i18n`, `data-i18n-title|aria-label|placeholder`, `data-i18n-runtime`, `translate="no"`.
- Catalogs: `src/i18n/locales/es.json`, `ru.json`; `src/i18n/same-as-english.json`. **`npm test` fails** (`src/i18n/catalog.test.mjs`) on any missing translation or unmarked UI literal (sinks listed in `JS_SINKS`). `src/tools/` is exempt. Every new UI string needs es + ru entries. `?lang=ru` to preview.

### 6e. CSS loading and tokens
- `index.html` links `/style.css` (root) which `@import`s 33 files from `src/ui/styles/` in fixed order: foundation, action-button, form-field, status-badge, slider, controls, location, status, cockpit, overlays, layers, radio, cctv, street-level, scenes, bhote-koshi, recent-imagery, recording, embed, responsive, command-dock (+compact, trays, sliding), voice-cost, voice-card, first-run, provider-settings, locale-picker, weather, panel-surfaces, segmented-control, **cyber (last)**. Fonts: Google Fonts JetBrains Mono + Inter + Material Symbols subset (icon names must be listed in the `index.html` URL; `src/materialSymbolsSubset.test.mjs`). Some modules inject inline CSS (e.g. `src/annotations/screenAnnotationRenderer.js`).
- Cesium widget CSS: injected by `vite-plugin-cesium` (`Widgets/widgets.css` link); order relative to `/style.css` unverified. `foundation.css` hides `.cesium-viewer-{toolbar,animation,timeline,bottom,fullscreen,vr,geocoder,selection,info}` and restyles `.cesium-credit-*` / lightbox.
- Tokens: `:root` in `src/ui/styles/foundation.css:6-32`: `--bg-dark #0a0a0f`, `--glass-bg`, `--glass-border(-hover)`, `--accent #00d4ff`, `--accent-dim`, `--accent-glow`, `--text-primary|secondary|dim`, `--menu-bg`, `--font-mono`, `--font-sans`, `--panel-radius`, `--btn-radius`, `--transition-fast|smooth`, layout vars (`--left-stack-*`, `--right-rail-x`, `--left-collapsed-width`, `--display-panel-expanded-width`, `--cockpit-radio-*`). Other families: `--panel-surface-*`, `--gev-field-*`, `--status-badge-*`, `--dock-*`, `--sl-*`, `--hud-*`, `--radio-broadcast-*`, `--weather-card-*`.
- **An existing theme switch exists**: `<html data-ui-theme="cyber">`, set by `applyHudUiTheme()` in `src/hudLayouts.js` when HUD layout = `cyber`; `cyber.css` scopes ~303 rules under `:root[data-ui-theme='cyber']` with tokens `--cyber-red #c45454`, `--cyber-red-bright #e16666`, `--cyber-slate*`, `--cyber-panel-*`, `--cyber-action-*`, `--cyber-voice-*`. Theme is coupled to HUD layout, not a standalone setting. Many literal colors remain outside tokens (unverified count). `cyberTheme.test.mjs` (857 lines) asserts CSS text; `index.html` `theme-color` and manifest colors are `#0a0a0f`.

### 6f. Boundary rules (`npm run check:boundaries`)
1. `scripts/check-import-directions.mjs`: parses all runtime JS in `src/` and `server/`. Errors: browser (`src/`) importing `server/` or Node builtins; `server/providers/*` importing `server/standalone/*` or renderer modules (`src/{ui,app,standalone,overlays}/`, `src/layers/*/{index,rendering,controls,...}.js`); reusable `src/` modules importing `src/main.js`/`src/standalone/*`; portable sources (`src/sources/*`, `src/layers/*/source.js`, portable exports incl. `./tools`, `./director`, `./voice/action-schemas`, `src/data/feedState.js`) reaching renderers, `server/`, Node builtins, `cesium`/`vite`, or browser globals; voice controls reaching a protocol implementation; computed imports/`require`. Allowed exceptions: `server/providers/local.js → server/standalone/key-setup.js`, `src/ui.js → src/standalone/catalog.js`.
2. `scripts/check-package-boundaries.mjs`: every `package.json` export must belong to exactly one group in `scripts/package-boundaries.json` (4000 lines); each group's build may import only its listed modules + externals.
- Also: `npm run format:check` auto-adopts every runtime JS file under `src/` and `server/` (`scripts/format-runtime.json`), Prettier 3.9.6, single quotes, 2 spaces, LF.

---

## 7. Overlap check

| Capability | What exists | Where |
|---|---|---|
| Satellites | Yes. CelesTrak TLE proxy (6 h disk cache, stale-on-error) for 7 groups; satellite.js SGP4 propagation; pass prediction (`next_satellite_pass`, `next_iss_pass`, MCP `satellites_overhead`) | `server/providers/space/celestrak.js`, `src/sources/tle.js`, `src/layers/satellites/*`, `src/data/satellitePass.js`, `src/data/issPass.js`, `src/tools/queries/space.js` |
| Launches | Launch Library 2, 30-day window, ascent replay | `src/layers/launches/*`, `/api/launches` |
| EONET / natural disasters | **No EONET.** Hazards covered separately: USGS quakes, FIRMS fires, WFIGS perimeters, NHC cyclones, nowCOAST radar/lightning | see Section 1a |
| Earthquakes | Yes, USGS M2.5+ 24 h, browser-direct | `src/layers/earthquakes/*`, tool `get_earthquakes` |
| Wildfires | Yes, NASA FIRMS (key) + WFIGS perimeters (keyless) | `src/layers/firms/*`, `src/layers/perimeters/*` |
| GDELT | **Partial**: DOC 2.0 ArtList (`timespan=48h`, 5 records) as fallback for regional headlines only | `server/providers/regional/news.js`, normalizer `src/data/regionalModel.js` (`normalizeRegionalArticles`) |
| News / RSS | **Partial**: Google News RSS search by locality (5 items, regex RSS parser) → GDELT fallback; surfaced only in `/api/regional-brief` (5 min cache, 30/min/IP), cockpit briefing strip (`#cockpit-news-status`, `src/ui/cockpitBriefing.js`), tool `get_regional_brief`. Credits `google-news-rss`, `gdelt` already registered. **No news layer on the globe.** Google News terms: personal non-commercial | `server/providers/regional/*`, `src/data/regionalBrief.js` |
| AI chat / LLM | Voice only: OpenAI Realtime (+Codex OAuth), Gemini Live; HUD caption via OpenAI `gpt-5-nano` (`/api/openai/hud-summary`). No text chat panel (voice card has typed send: `src/voice/realtimeTurns.js`, changelog `1220-openai-typed-send`) | `src/voice/*`, `server/providers/openai*`, `server/providers/gemini*` |
| Ollama | **Dev benchmark only** (not shipped): Ollama native `/api/chat` and OpenAI-compatible adapters replaying production prompt + tools (`toChatTools`) | `scripts/voice-bench/adapters/localChat.mjs`, `scripts/voice-bench/toolFormats.mjs`, `scripts/qa-voice-bench.mjs` |
| MCP | Yes (Section 4) | `server/mcp/*` |

---

## 8. Scripts and tests

- `package.json` scripts: `doctor`, `format`, `format:check`, `i18n`, `layer-token:next`, `layer-token:check`, `changelog`, `changelog:check`, `dev` (vite), `dev:secure` (`scripts/dev-secure.sh`), `opensky:import`, `build`, `build:panel`, `preview`, `test`, `test:track` (`scripts/track-regression.mjs`), `qa:map-source-tray`, `qa:street-level`, `qa:street-level:fixtures`, `check:boundaries`, `qa:transit`, `mcp`.
- `scripts/` (163 files): gates `check-import-directions.mjs`, `check-package-boundaries.mjs` (+`package-boundaries.json`, `module-analysis.mjs`), `check-layer-state-tokens.mjs`, `next-layer-state-token.mjs`, `i18n.mjs`, `format.mjs` (+`format-scope.json`, `format-runtime.json`), `assemble-changelog.mjs`, `run-unit-tests.mjs`, `setup-doctor.mjs`; launchers `dev-fresh.sh`, `dev-secure.sh`, `dev-cctv.sh`, `docker-start.mjs`, `pinokio-*.mjs`; builders `build-panel.mjs`, `generate-icons.mjs` (rasters from `public/logo.svg` via sharp), `build-admin-packs.mjs`, `build-bright-stars.mjs`, `build-milky-way.mjs`, `build-sf-neighborhoods.mjs`, `build-military-names.py`, `precompute-cctv-heights.mjs`; ~90 Puppeteer browser gates `qa-*.mjs` (feature acceptance, need a running server; `qa-l9-matrix.mjs` aggregates); `voice-bench/*` + `qa-voice-bench.mjs`, `qa-voice-wav.mjs`, `qa-voice-auth.mjs`; fixtures under `scripts/fixtures/`.
- `npm test` = `node scripts/run-unit-tests.mjs`: discovers every `*.test.mjs` under `src/` and `server/` (**720 files**; ~189 in `src/data`, ~166 in `src/layers`), runs `node --test <all>` in one process, then two GC allocation probes (`--expose-gc`) only on Node 24 (`GEV_REQUIRE_ALLOCATION_GATE=1` makes other runtimes fail). Tests use `node:test` + `assert`; many are source-text assertions on HTML/CSS/markup. Puppeteer is a devDependency used by `scripts/qa-*.mjs`, not by `npm test`.
- `npm run doctor` (`scripts/setup-doctor.mjs`, `--json` in CI): Node version class (24.14+ ok, 26 ok, 25 warn), npm present, required deps installed, credential presence for Google Maps / Google server / Cesium ion / OpenAI / AISStream / FIRMS / TomTom / OpenSky id+secret / LL2 / Mapillary (env, `.env`, macOS Keychain), OpenSky auth mode, and a capability summary (map route, flights, voice, vessels, fires, traffic, missions). Does not know Gemini.
- CI `.github/workflows/ci.yml`: job `verify` (Node 24.14.0 + 26.x): `npm ci`, `doctor --json`, `format:check`, `check:boundaries`, `layer-token:check --base-ref origin/main` (PRs only), `npm test`, `npm run build`. Job `street-level-browser`: build + `vite preview` + `qa:street-level:fixtures --strict`. Job `windows-onboarding`: `scripts/pinokio-install.mjs`, format, boundaries, focused node tests, build. Also `.github/CODEOWNERS`, issue templates.

---

## 9. Branding surface

Counts (tracked files, case-insensitive `git grep`): "god's eye" 119 lines/53 files; "gods-eye" 199/71; "godsEyeView" 1581/117 (mostly `window.__godsEyeView` debug handle and `godsEyeView.*` storage keys in tests); "halfpixel" 4/3; "bilawal" 53/24; word "GEV" 1812/343; `gev-`/`gev_`/`gev:`/`gev.` 1917/368 (CSS classes, storage keys, template markers); `GEV_` env/constants 337/93. 29 test files reference branding strings.

User-visible / shipped (rebrand targets for `src/branding.js`):
- `index.html`: `<title>God's Eye View</title>`, `apple-mobile-web-app-title "God's Eye"`, `theme-color #0a0a0f`, favicons `/icons/icon-32.png`, `/logo.svg`, `/icons/icon-180.png`, manifest link.
- `public/manifest.webmanifest`: name "God's Eye View", short_name "God's Eye", description, colors, icons `icons/icon-{192,512,512-maskable}.png`.
- `public/logo.svg` (`<title>God's Eye View</title>`, eye wordmark), `public/mic.svg`, `public/icons/*` (generated by `scripts/generate-icons.mjs`).
- `src/ui/templates/scene-chrome.html:13-14`: title bar logo + `GOD'S EYE <span class="title-accent">VIEW</span>` + subtitle "NO PLACE LEFT BEHIND" (i18n key). `src/ui/templates/hud-loading.html:7-8`: loader logo + wordmark. Logo animation `src/logoGaze.js` (`data-logo-gaze`).
- `src/ui/templates/welcome.html:51`: "Tip: the GEV MIC button..." (+ es/ru translations). Voice card assistant label `ASSISTANT_NAME = 'GEV'` (`src/voice/control.js:4`); dock label `t('MIC')` (`src/voice/realtimeInput.js:368`); errors "GEV command failed", "GEV voice is not connected".
- Model-facing prompts: `server/providers/openai/instructions.js:8` ("You are GEV Voice Control ... app called God's Eye View"), `toolDescriptions.js` (fly_to_location, set_layer_visibility, set_visual_style), `src/hudSummaryResponse.js:51`.
- MCP: server name `gods-eye-view`, `INSTRUCTIONS` (`server/mcp/server.js`), tool `show_in_gods_eye_view`, resource `ui://gods-eye-view/globe`, panel page title/button "Open in God's Eye View" (`src/tools/globePanel.js`, `src/app/globePanelRuntime.js`, `src/tools/queries/share.js`, `panelRequest.js`).
- Console/error text: `src/main.js:12`, `src/data/bundledJson.js:34`, `src/app/embed.js:89`.
- Upstream User-Agents: `gods-eye-view-celestrak-proxy/1.0 (+github.com/bilawalsidhu/gods-eye-view)` (`server/providers/space/celestrak.js`), `GodsEyeView/0.1` (`server/providers/regional/news.js`) and likely others (unverified full list).
- `package.json`: name, description, author, homepage/repo/bugs URLs; self-imports `gods-eye-view/...` appear in docs and in 9 test files (Node self-reference by package name; `check-import-directions.mjs` resolves `pkg.name/...` via `exports`). Runtime `src/`/`server/` code does not self-import. Renaming `name` requires updating those tests in lockstep.
- Pinokio: `pinokio/pinokio.js` title "God's Eye View", "Open God's Eye View"; `pinokio/_ENVIRONMENT` header.
- Docs/media: README (title, CI + trending badges pointing at bilawalsidhu repo, YouTube, Halfpixel), CONTRIBUTING (maintainers, Halfpixel), SECURITY, TESTING, `docs/*`, `docs/media/*.gif|png` (upstream demo media), `public/models/README.md`.
- File format / storage identifiers (keep for compatibility unless deliberately migrated): `.gevbundle.json`, `gev:layer-state:v2`, `godsEyeView.voice.cloudAuth`, `gev-realtime-errors`, `GEV_*` env vars, `.gev-cache/`, `.gev-logs/`, CSS `.gev-*` classes, `window.__godsEyeView`.
- No dedicated About dialog found; attribution lives in the Cesium credit lightbox. LICENSE: "MIT ... Copyright (c) 2026 Bilawal Sidhu" — must be retained in the fork.

---

## 10. Working constraints (`.agents/`, CONTRIBUTING, TESTING, SECURITY, changelog.d)

- `.agents/skills/community-pr/SKILL.md`: maintainer PR review workflow tied to upstream (`docs/MAINTAINER_WORKFLOW.md`, `docs/PR_REVIEW_SANDBOX.md`); not applicable to fork development except as review checklist.
- CONTRIBUTING: vanilla JS (no framework); secrets stay server-side under `server/providers/`; ES modules, 2-space, single quotes, semicolons, JSDoc on exports; all UI text i18n'd; `npm run format`, `format:check`, `check:boundaries` before PR; keep `build`, `test`, `test:track` green and run the feature's `qa-*.mjs` gate; update `docs/CURRENT-STATE.md` (authoritative runtime reference, 6057 lines) for behavior changes; new data source → `DATA_SOURCES.md` + credit; "Don't add data you don't have the right to redistribute — fetch at runtime"; public-data-only ground rules; layer-token procedure (Section 3).
- `changelog.d/`: one fragment per PR, `changelog.d/<pr-number>-<slug>.md`, a single `-` bullet written as it should appear; `npm run changelog[:check]` assembles; don't edit `CHANGELOG.md` directly. Doc claims needing tests should assert against `docs/CURRENT-STATE.md` or `README.md`.
- TESTING.md: manual field-test script; automated surface = `npm test`, `npm run test:track`, `scripts/qa-*.mjs`; harnesses use Metal (macOS) / SwiftShader elsewhere.
- SECURITY.md: key-broker threat model (localhost default, LAN opt-in, throttles, provider budgets); no arbitrary-URL fetching from clients (fixed upstreams / registered URLs only); capped/validated responses; sanitized errors; `/api` CSP sandbox; cross-site gate on cost/log endpoints; Provider Settings loopback-only; MCP `/mcp` local-only; embed not framable by default. A `/api/intel/*` proxy must follow the same rules (fixed loopback upstream, no client-supplied URLs, size caps, timeouts, sanitized errors).
- Node 24.14+ required (allocation gates calibrated on Node 24). Windows CI exists (format/boundaries/build), so Windows-specific paths are supported.
