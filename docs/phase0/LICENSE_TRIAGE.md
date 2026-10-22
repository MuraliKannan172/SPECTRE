# SKYNET Phase 0: License Triage

- **Upstream:** God's Eye View (GEV), MIT, © 2026 Bilawal Sidhu (`LICENSE`), main @ `7be5937f`
- **Fork goal:** SKYNET is MIT-licensed, local-first, and keyless by default. The MIT grant covers code only. The default build must not bundle non-commercial (NC) or otherwise restrictive data.
- **Prepared:** 2026-10-22. This was a read-only review. Nothing in the repo was changed except this file. No npm, node or server commands were run.

## How to read this

- **Evidence labels**
  - **[web 2026-10-22]**: I checked this against the cited URL on 2026-10-22.
  - **[repo]**: This is the repo's own claim (`DATA_SOURCES.md`, a folder README, or a code comment). I did not verify it independently.
  - **unverified**: I could not confirm the term. These rows need a human or legal check before release.
- **Decision rules.** Every row follows these rules, so OpenSky, Google News and the others are all handled the same way.
  1. **REMOVE.** Data that is bundled in the repo and is NC, personal-use-only, or carries no redistribution right.
  2. **OFF by default.** Runtime data whose terms are NC-only, personal-use-only, or need a separate written agreement. The user opts in through a toggle that shows the terms.
  3. **KEEP with an opt-in key (BYOK).** Runtime data that needs the user's own key or account. The user's own provider terms then apply. These are opt-in already, because nothing loads until a key is supplied.
  4. **KEEP + DOCUMENT.** Runtime data under an open licence that is served from a free public instance with fair-use rules (no SLA). Requirements: rate limits, an identifying User-Agent, a configurable endpoint, and visible attribution.
  5. **KEEP + ATTRIBUTE.** Bundled data under an open licence (PD, CC0, PDDL, CC BY, ODbL). The required credit must ship with the data and appear in the UI.
- **Glossary.** NC = non-commercial. PD = public domain. BYOK = bring your own key. SA = share-alike.

---

## 1. Triage table

### 1a. Bundled datasets, `src/data/local_data/` and other in-repo data

| Item | Path / provider | License / terms | Bundled / runtime | Commercial OK? | Redistribution OK? | Action | Notes |
|---|---|---|---|---|---|---|---|
| **TeleGeography Submarine Cable Map** (712 cables, 1,917 landing points) | `src/data/local_data/telegeography_submarine_cables/` (1.1 MB: `cable-geo.json`, `landing-point-geo.json`, `source.json`, `README.md`) | CC BY-NC-SA 3.0 [repo: folder README, `LICENSE:33-36`, `DATA_SOURCES.md:203,213-219`]. `source.json` itself only says to check TeleGeography terms before redistributing. | Bundled | **No** (NC) | Only under NC-SA | **REMOVE from default build**; optional user-run fetch script, off by default | See **TeleGeography dependencies** below this table. |
| **Bhote Koshi 2026 event pack** (Vantor imagery crops and GeoPera centerline) | `public/events/bhote-koshi-2026/` (`pre.webp` 1.35 MB, `post.webp` 1.0 MB, `event.json`), `src/data/bhoteKoshiFloodPath.js` (coordinates compiled into JS) | CC BY-NC 4.0 [repo: `public/events/bhote-koshi-2026/README.md`, `LICENSE:41-48`, header of `src/data/bhoteKoshiFloodPath.js`] | Bundled and compiled in | **No** (NC) | Only under NC | **REMOVE from default build** (not named in the brief, but the "no NC data bundled" rule applies) | See **Bhote Koshi dependencies** below this table. |
| Datacenters (4,351) | `src/data/local_data/datacenters/` (2.5 MB) | ODbL 1.0, OSM extract [repo README] | Bundled | Yes | Yes, under ODbL (attribution and SA on the database) | KEEP+ATTRIBUTE | The README says the extraction date and query were never recorded. Record both on the next refresh. |
| Dams (704) | `src/data/local_data/dams/` (1.4 MB) | ODbL 1.0, OSM via Open Infrastructure Map [repo README] | Bundled | Yes | Yes, under ODbL | KEEP+ATTRIBUTE | Credit "© OpenStreetMap contributors" and Open Infrastructure Map. `geojson` and `geojsonl` are duplicates, so one could be dropped. |
| Military area names (36,466) | `src/data/local_data/osm_military_names/` (3.7 MB) | ODbL 1.0, OSM via Overture release 2026-09-23.1 [repo README] | Bundled | Yes | Yes, under ODbL | KEEP+ATTRIBUTE | Credit OSM contributors and the Overture Maps Foundation. |
| Natural Earth (regions, marine, countries, states and provinces) | `src/data/local_data/natural_earth/` (6.9 MB) | Public domain. Natural Earth's terms say: "No permission is needed to use Natural Earth." [web 2026-10-22, https://www.naturalearthdata.com/about/terms-of-use/] | Bundled | Yes | Yes | KEEP+ATTRIBUTE (courtesy credit) | Pinned commit and hashes are in the README. |
| **GeoNames-derived gazetteer** (planned, for news geoparsing) | Planned under `intel/` or `src/data/local_data/` | CC BY 4.0. The GeoNames readme says the work "is licensed under a Creative Commons Attribution 4.0 License" [web 2026-10-22, https://download.geonames.org/export/dump/readme.txt]. The readme does not address commercial use directly; CC BY 4.0 permits it. | Will be bundled | Yes (CC BY 4.0) | Yes, with credit and a change notice | KEEP+ATTRIBUTE | Record the source dump (for example `cities1000.zip` or `cities15000.zip`), its download date, SHA-256 and the transform. Credit: "Contains data from GeoNames (geonames.org), CC BY 4.0, modified". This replaces any per-item Nominatim geocoding. |
| US Census counties | `src/data/local_data/us_census_counties/` (1.5 MB) | Public domain, a US Government work [repo README] | Bundled | Yes | Yes | KEEP (courtesy credit) | |
| DataSF Analysis Neighborhoods | `src/data/local_data/neighborhoods/` (224 KB) | PDDL 1.0 [repo `SOURCE.md`, which records the license evidence] | Bundled | Yes | Yes | KEEP | |
| Sky: Yale Bright Star Catalogue | `src/data/local_data/sky/bright_stars.json` | Public domain; CDS asks for acknowledgement [repo README] | Bundled | Yes | Yes | KEEP+ATTRIBUTE | Already in `DATA_CREDITS`. |
| Sky: ESO Milky Way (eso0932a) | `src/data/local_data/sky/milkyway_*.webp` (62 KB) | CC BY 4.0, "ESO/S. Brunier"; changes are stated [repo README] | Bundled | Yes | Yes, with credit and a change notice | KEEP+ATTRIBUTE | Already in `DATA_CREDITS`. |
| **CCTV ground heights** (3,445 cameras) | `src/data/local_data/cctv_ground_heights/` (2.0 MB) | No licence is stated. `scripts/precompute-cctv-heights.mjs:140,435` samples heights from a running app with `scene.sampleHeightMostDetailed` and stamps them `provider: 'google-3d-tiles'`, so the file holds stored data derived from Google Photorealistic 3D Tiles. Google's policy forbids pre-fetching, storing or caching content outside the Agreement, and forbids geodata extraction [web 2026-10-22, https://developers.google.com/maps/documentation/tile/policies]. | Bundled | No | **No** | **REMOVE** | `server/providers/cctv/groundHeights.js:17-44` treats a missing file as "no shipped heights", so placement falls back to the runtime terrain proxy. If wanted, regenerate from a permissive source such as Re:Earth/Mapterhorn or Copernicus DEM. |
| CCTV hardware specs (17 records) | `src/layers/cctv/modelSpecs.js` | CC0-1.0 [repo `DATA_SOURCES.md:211,237-246`] | Compiled in | Yes | Yes | KEEP | |
| Transit route-name tables (Hamilton, Guelph, Burlington, YRT) | `src/data/transitFeeds.js` | Each operator's open-data licence; the source GTFS is credited [repo `DATA_SOURCES.md:90-96`] | Compiled in | Yes [repo] | Yes [repo] | KEEP+ATTRIBUTE | Licence wording is prescribed per feed and already registered via `transitFeedCredit()`. |
| Tallinn CCTV catalog (255 cameras: coordinates and heading priors) | `config/cctv_sources.tallinn.json` (172 KB) | Field reads "Public City of Tallinn traffic camera frame"; no licence is cited | Bundled catalog; frames fetched at runtime | unverified | unverified | KEEP + DOCUMENT (verify) | A curated derivative. Confirm the City of Tallinn terms or rebuild the catalog at runtime. |
| Warendorf webcam entry | `config/cctv_sources.warendorf.json` | Courtesy; mount and heading derived from OSM geometry (ODbL) [repo field] | Bundled | unverified | ODbL portion OK | KEEP+ATTRIBUTE | |
| "Shinjuku" demo CCTV pack | `config/cctv_sources.shinjuku.json` | Points at Google sample promo videos (`storage.googleapis.com/gtv-videos-bucket/sample/*.mp4`, lines 10, 29, 48), labelled "Demo sample stream". No licence is given for the videos. | Bundled config; video fetched at runtime only if `CCTV_SOURCES_FILE` selects it (nothing else references it) | unverified | unverified | **REMOVE** | Presents sample videos as Tokyo cameras, which is misleading. It is not part of the default path. |
| TomTom flow tile fixture | `src/data/fixtures/tomtom-flow-austin-12-935-1686.pbf` (23 KB) | © TomTom, a proprietary point-in-time snapshot [repo `src/data/fixtures/README.md`, `DATA_SOURCES.md:181`] | Bundled (test-only) | No | **unverified, likely no** | **REMOVE**; replace with a synthetic MVT fixture | Never loaded at runtime, but it is redistributed with the source. |
| OpenFreeMap / OSM test fixtures | `src/data/fixtures/ofm-*.pbf`, `osm-alpr-*.pbf`, `traffic-road-access.json` | ODbL 1.0 [repo fixtures README] | Bundled (test-only) | Yes | Yes, under ODbL | KEEP+ATTRIBUTE (in README) | |
| ADS-B capture fixtures, FIRMS CSV sample | `src/data/fixtures/adsb-*`, `firms-*` | Self-received broadcast data; NASA PD [repo] | Bundled (test-only) | Yes [repo] | Yes [repo] | KEEP | |
| Voice WAV fixture | `scripts/fixtures/voice/full-globe-turn-on-radio.wav` (884 KB) | Embedded INFO metadata: Kokoro TTS output, Apache-2.0 [repo, read from the file header] | Bundled (QA-only) | Yes [repo] | Yes [repo] | KEEP (or drop if unused) | |
| Street-level test photo | `scripts/fixtures/street-level/street-640x320.jpg` (3.6 KB) | No provenance recorded; no EXIF | Bundled (test-only) | unverified | unverified | REPLACE with a generated image, or document its source | Looks synthetic, which is unverified. |

**TeleGeography dependencies and how the app degrades**

- **Code that depends on the dataset**
  - Loader: `src/layers/submarineCables/bundledSource.js:5-16` resolves both JSON files with `new URL(..., import.meta.url)` and `fetch()`es them.
  - Wrapper: `src/data/telegeographySubmarineCables.js`.
  - Registration: `src/data/localLayers.js:4,18` adds it to the default local layers. `src/app/sourceComposition.js:51` sets the source contract.
  - Ingest, lifecycle and rendering: `src/layers/submarineCables/*`.
  - App, UI and state: `src/app/layers/submarineCables.js`, `src/app/constructCatalog.js`, `src/ui/layerPanel.js`, `src/ui/layerNames.js`, `src/data/layerState.js`, `src/data/layerStateTokenReservations.json`, `src/sources/reference.js`, `src/overlays/worldOverlayAllocation.worker.mjs`.
  - Voice and tools: `src/tools/queries/cables.js` (the `find_submarine_cables` tool, layer id `telegeography-submarine-cables`), `src/tools/services.js`, `src/voice/layerManifest.js`, `src/voice/gevActions.js`, `server/providers/openai/instructions.js:47`.
  - Credit: `src/data/dataCredits.js:494-499`.
  - QA scripts: `scripts/qa-cables-*.mjs`, `qa-firstrun*.mjs`, `qa-l9-matrix.mjs`, `qa-infra-lod.mjs`, `check-layer-state-tokens.mjs`, `package-boundaries.json`, `format-scope.json`, and `package.json` scripts.
  - Tests: about 15 `*.test.mjs` files, including `src/data/telegeographySubmarineCables.test.mjs` (57 KB) and `src/tools/queries/cables.test.mjs`.
  - Docs: `LICENSE`, `DATA_SOURCES.md`, `docs/TOOLS.md`, and `docs/media/09-undersea-cables.gif`, which shows the data.
- **If only the data folder is deleted**
  - The runtime fetch gets an HTTP error. `src/layers/submarineCables/ingestion.js:189-198` catches it, sets `state._error` (e.g. `HTTP 404 for …`) and logs `console.warn('[Data:telegeography-submarine-cables]', …)`.
  - The layer still appears in the panel, but in an error state. The voice tool and credit stay registered, and the tests that load the JSON fail.
  - Whether `vite build` warns or fails on a missing `new URL(…, import.meta.url)` asset is **unverified**, because no build was run.
- **Recommended clean removal**
  - Unregister the layer in `localLayers.js`, `sourceComposition.js` and `constructCatalog.js`.
  - Remove or gate `find_submarine_cables`, the manifest and instruction mentions, and the credit.
  - Delete or adapt the dependent tests and QA scripts.
  - Optionally ship `scripts/fetch-optional-data.ps1`, which downloads the data into a git-ignored folder. The layer then registers only when that file exists, and stays off by default.

**Bhote Koshi dependencies**

- `src/data/bhoteKoshi{Event,FloodPath,IncidentPlaces,Locator,ShotPaths,EmbeddedMedia}.js`
- `src/scenes/packs/nepal.js`, `src/scenes/nepalEvidencePack.js`, `src/scenes/recipes.js`
- `src/tools/queries/events.js` (the `get_bhote_koshi_flood` tool), `src/app/tools.js`, `src/app/constructCatalog.js`
- `src/voice/layerManifest.js`, `src/data/layerState.js`, `src/overlays/worldOverlay.js`
- `src/data/dataCredits.js:556-573`
- `build/vite.js:25,34`: the CSP allows YouTube, Facebook and X embed SDKs for witness posts. Remove those origins together with the pack.

The pack README says deleting the folder alone is not enough.

### 1b. 3D models, `public/models/` (9 files, about 3.2 MB)

`public/models/README.md` lists every model as CC BY 4.0, which permits commercial use and redistribution with credit and a change notice. I re-checked each against the Sketchfab API at `https://api.sketchfab.com/v3/models/<uid>` [web 2026-10-22].

| File | README credit | Sketchfab API today | License (API) | Redistribution OK? | Action | Notes |
|---|---|---|---|---|---|---|
| `airplane.glb` | "boeing 747" by zairiq-123 | zairiq-123 | CC Attribution (CC BY 4.0) | Yes | KEEP+ATTRIBUTE | Matches. |
| `jet.glb` | "Private Jet" by **Nick the Name** (`sketchfab.com/Nick_The_Name`) | Uploader **BACEL_M / "bacelM"**; "Nick" appears nowhere in the record | CC BY 4.0 | Yes | KEEP+ATTRIBUTE, **fix credit** | **Attribution mismatch.** Credit the actual licensor (bacelM) or confirm the provenance. |
| `ship.glb` | "Low Poly Cargo Ship" by Javier_Fernandez | Javier_Fernandez | CC BY 4.0 | Yes | KEEP+ATTRIBUTE | Matches. |
| `bell206.glb` | "Bell 206 JetRanger" by terran4627 | **HTTP 404**: the model is no longer public, and a web search did not find it | **unverified** | unverified (a CC BY grant is irrevocable if it was given, but cannot be re-confirmed) | **REPLACE** (or KEEP with documented risk) | Removing it is safe: helicopters fall back to `airplane.glb` once the row at `src/data/aircraftClass.js:514` is dropped (`CLASS_MODEL_URL`, lines 491-500). |
| `c172.glb` | "Cessna 172" by **e737** (`sketchfab.com/e0057537`) | Uploader **nobilishornet / "Nobilis the Palaeovespa"** | CC BY 4.0 | Yes | KEEP+ATTRIBUTE, **fix credit** | **Attribution mismatch.** It could be an account rename; confirm. |
| `citation2.glb` | "1990 Cessna Citation…" by BlenderCommunityHead (`sketchfab.com/aboodgoudagad`) | Display name matches; profile is now `sketchfab.com/maximgad` | CC BY 4.0 | Yes | KEEP+ATTRIBUTE, update the link | |
| `mq9.glb` | "MQ-9" by IProZenoN | IProZenoN | CC BY 4.0 | Yes | KEEP+ATTRIBUTE | Matches. |
| `b789.glb` | "Boeing 787-9" by Nobilis 2 | nobilishornet2 / "Nobilis 2" | CC BY 4.0 | Yes | KEEP+ATTRIBUTE | Matches. |
| `atr72.glb` | "ATR 72 - 600" by **Oyan3D** (`sketchfab.com/oyan3D`) | Uploader **sofyankurniawan / "Sofyan Kurniawan"** | CC BY 4.0 | Yes | KEEP+ATTRIBUTE, **fix credit** | **Attribution mismatch.** It could be a rename; confirm. |

**Summary**
- No model is under a licence that blocks redistribution.
- `bell206.glb` cannot be re-verified, because the source page is gone.
- Three credits (`jet`, `c172`, `atr72`) do not match the current licensor names, and one profile link (`citation2`) is stale.
- CC BY credit is required. It currently lives only in `public/models/README.md`, not in the in-app credits. Add it to the attribution popover (see section 4).
- CC BY grants no trademark rights. The aircraft types and liveries may carry manufacturer or airline marks.

Sketchfab API URLs checked on 2026-10-22 (the `uid` is the hex suffix of each model URL in `public/models/README.md`):

- `airplane`: https://api.sketchfab.com/v3/models/9b16672038ba48f98e6d80a159044ed9
- `jet`: https://api.sketchfab.com/v3/models/cbdd1de6ced9461e950eafaa302cc82b
- `ship`: https://api.sketchfab.com/v3/models/4c22cbaf01c1427f8ab60b3a07b1b32c
- `bell206`: https://api.sketchfab.com/v3/models/d2f7ba1d671549d4b26aaf834139a1dd. This returned HTTP 404. A web search on 2026-10-22 for `sketchfab "Bell 206 JetRanger" terran4627` found no Sketchfab listing.
- `c172`: https://api.sketchfab.com/v3/models/64cddaee5aff470682659a8c08525046
- `citation2`: https://api.sketchfab.com/v3/models/a78839624fe64900a8352cb23462350a
- `mq9`: https://api.sketchfab.com/v3/models/fabe963feb354c5584b51f9c470c3f7e
- `b789`: https://api.sketchfab.com/v3/models/b6711e2e698e4e469675c1154a50b7a3
- `atr72`: https://api.sketchfab.com/v3/models/1e1a7186f7444d288675262fcee44744

### 1c. Runtime basemaps, terrain and 3D

| Item | Path or provider | License / terms | Runtime / bundled | Commercial OK? | Redistribution OK? | Action | Notes |
|---|---|---|---|---|---|---|---|
| **Esri World Imagery** (classic ArcGIS Online MapServer) | `src/maps/imagery.js:14-23` (`services.arcgisonline.com/.../World_Imagery/MapServer`, no token). Used as the **keyless default landing**: `src/maps/defaultSources.js:29`, with credit and OSM fallback at `:60-72`. Map tray: `src/maps/catalog.js:27-32`. Allowlist: `src/tools/globePanel.js:33-34`. | The item metadata says: "This work is licensed under the Esri Master License Agreement." The layer is not for exporting tiles for offline use [web 2026-10-22, https://www.arcgis.com/sharing/rest/content/items/10df2279f9684e4a9f6a7f08febac2a9?f=json]. Service `copyrightText` currently names Esri, **Vantor**, Earthstar Geographics and the GIS User Community [web 2026-10-22, https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer?f=json]. | Runtime | **unverified** (no Esri text found granting keyless use in third-party OSS apps) | No caching or export | **MAKE OPTIONAL**, off as the default landing (recommended); otherwise DOCUMENT and accept the risk | See **Esri findings** below this table. |
| **OSM standard raster tiles** (`tile.openstreetmap.org`) | `src/maps/imagery.js:7-12`. Used as the "OSM" stack and as the **automatic fallback** when Esri fails (`defaultSources.js:63-71`). | OSMF Tile Usage Policy: visible attribution on the map; an identifying User-Agent; honour cache headers; no bulk or prefetch; "Offline use is not permitted". Access can be blocked without notice; no SLA; apps should make the tile URL configurable [web 2026-10-22, https://operations.osmfoundation.org/policies/tiles/]. Data is ODbL. | Runtime | Data yes; the **service is best-effort**, and access can be withdrawn | No offline or prefetch | KEEP + DOCUMENT (fair-use), with a configurable URL. **Not** a good keyless default for a distributed app. | **Gap:** the `DATA_SOURCES.md` OSM row (line 27) does not name the raster tile server or its policy. The Cesium imagery provider's own User-Agent and Referer behaviour is unverified. |
| Google Photorealistic 3D Tiles (Map Tiles API) | `src/maps/google3d.js:66-74` (direct key), `:81-107` (token), `:109-130` (via ion asset 2275207). `GOOGLE_MAPS_API_KEY` is BYOK (`.env.example:27`). | Google Map Tiles API policies: Google Maps logo plus data attributions, displayed **on screen**; CesiumJS needs `showCreditsOnScreen: true`; no pre-fetching, storing or caching outside the Agreement; visualization only, with no geodata extraction or offline use [web 2026-10-22, https://developers.google.com/maps/documentation/tile/policies]. | Runtime, BYOK | Per your Google Agreement | No (no storing or caching) | KEEP (BYOK opt-in) + fix compliance | (1) No code in `src/` sets `showCreditsOnScreen`, and Cesium's default is `false` (`node_modules/@cesium/engine/Source/Scene/Cesium3DTileset.js:120,233`). **Set it to true on all three routes.** (2) `google3d.js:71` passes `onlyUsingWithGoogleGeocoder: true`. Cesium's helper warns that only the Google geocoder may be used with these tiles (`createGooglePhotorealistic3DTileset.js:75`), yet place search falls back to Photon and Nominatim (`DATA_SOURCES.md:186`). Google's policy page I fetched does not state the geocoder rule, so it is **unverified**; review it. (3) The CCTV ground heights are derived from Google tiles; see 1a. |
| Cesium ion (Google 3D via ion, Bing imagery, Cesium World Terrain) | `src/maps/imagery.js:25-66`, `src/maps/google3d.js:118`, `src/maps/terrain.js`. `CESIUM_ION_TOKEN` is BYOK (`.env.example:52-57`). | The Community plan is for "Personal and non-commercial use". A paid account is needed above $50K annual revenue or funding [web 2026-10-22, https://cesium.com/pricing/]. | Runtime, BYOK | Only on a paid plan, or under the thresholds | Per Cesium terms | KEEP (BYOK opt-in) + DOCUMENT | **Gap:** Cesium ion has no row in `DATA_SOURCES.md`. Keep the Cesium ion credit that CesiumJS adds automatically. |
| Bing Maps Aerial / Labels via ion | `src/maps/catalog.js:10-25`, `src/maps/imagery.js:37-66`. Hosts: `dev.virtualearth.net`, `ecn.t0-3.tiles.virtualearth.net`. | Search results (2025 Cesium posts, not fetched) say Microsoft deprecated Bing Maps for standard accounts on 2025-06-30. Cesium's enterprise access runs to 2028-06-30 at the latest, and Cesium expects to remove the Bing assets before that date. **Status as of 2026-10-22 is unverified.** [search: https://community.cesium.com/t/bing-maps-end-of-life-timeline-in-cesium-ion/40002] | Runtime, BYOK (ion) | Per ion and Microsoft terms | No | KEEP (BYOK) + DOCUMENT end-of-life risk | **Gap:** Bing has no row in `DATA_SOURCES.md`. Show the ion-supplied Microsoft credits (already done at `imagery.js:57-64`). |
| Re:Earth Terrain / Mapterhorn | `src/maps/terrain.js` (keyless terrain); `/api/terrain/heights` | Repo says the mesh is CC BY 4.0 [repo `DATA_SOURCES.md:98`]. Mapterhorn's own attribution page lists **per-source** licences in `attribution.json` and states no single licence [web 2026-10-22, https://mapterhorn.com/attribution/]. | Runtime | unverified (depends on the per-source licences) | Disk cache via the proxy | KEEP + DOCUMENT (verify per-source licences) | Keyless default terrain. Before release, confirm the per-source terms and that the Re:Earth endpoint allows third-party apps. |
| NASA GIBS / CMR (Recent Imagery) | `DATA_SOURCES.md:39` | US public domain [repo] | Runtime | Yes [repo] | Yes [repo] | KEEP + ATTRIBUTE | Candidate **replacement keyless default basemap** (public domain, coarser than Esri). |
| OpenFreeMap / OpenMapTiles vector tiles | `tiles.openfreemap.org` | OSM data under ODbL; OpenMapTiles credit [repo `DATA_SOURCES.md:42`] | Runtime | Yes [repo] | ODbL | KEEP + ATTRIBUTE | Inline credit at `dataCredits.js:32-35,56-84`. |

**Esri findings**

- **Where it is used.** Esri is the keyless default landing whenever no Google tileset is configured. Bhote Koshi comparison shots also use it. The separate `services*.arcgis.com` feature services (WFIGS, FL511, King County) are agency data hosted on ArcGIS Online, not Esri basemaps, so their owners' terms apply.
- **Terms.** The service is under the Esri Master License Agreement. It must not be used for offline or exported tiles.
- **Key or account.** The classic endpoint answered without a token on 2026-10-22, but I found no Esri statement that allows keyless use from non-ArcGIS open-source apps. Details, all checked 2026-10-22:
  - **Non-Esri software clause (unverified).** A 2013-era clause banning "access … through non-Esri software" turned up only in a community quote: https://community.esri.com/thread/77249.
  - **Developer docs (search snippets only).** These say current basemap services need an access token and "Powered by Esri" plus data attribution. The page https://developers.arcgis.com/documentation/mapping-apis-and-services/deployment/basemap-attribution/ rendered empty through the fetch tool, so this is unverified.
  - **Master Agreement.** https://www.esri.com/en-us/legal/terms/full-master-agreement is only an index of PDFs (the E204 Master Agreement and E300 Product-Specific Terms). Those PDFs were not read, so the clause-level terms are unverified.
- **Stale credit.** The hard-coded credit `src/maps/imagery.js:19` and `DATA_SOURCES.md:36` say "Maxar", but the live `copyrightText` now says "Vantor". Read the credit from the service at runtime instead.
- **Recommendation.** Use NASA GIBS (public domain) as the keyless default. Keep Esri as an opt-in stack with dynamic attribution. Alternatively, keep Esri as the default after a legal review.

### 1d. Runtime: flights, ships, space

| Item | Path or provider | License / terms | Runtime / bundled | Commercial OK? | Redistribution OK? | Action | Notes |
|---|---|---|---|---|---|---|---|
| **OpenSky Network** (global states, tracks) | `server/providers/aircraft/opensky.js:32,174`, `tracks.js:86`. The default auth mode is `oauth` (`.env.example:121`); anonymous mode is possible. | The API is for "research and non-commercial purposes". Commercial live data means contacting OpenSky. Citing Schäfer et al., IPSN 2014 is required. The page also says OpenSky may block AWS and other hyperscaler IPs, and it asks people not to contact OpenSky to have AI-built dashboards whitelisted (that text includes a note addressed to LLMs, recorded here as data only) [web 2026-10-22, https://openskynetwork.github.io/opensky-api/]. The terms page `opensky-network.org/about/terms-of-use` returned 403, so it was not read. | Runtime | **No** (without an agreement) | No | **MAKE OPTIONAL, off by default** (opt-in with credentials) | Keep the citation in credits when it is enabled. `DATA_SOURCES.md:119` also mentions written agreements for operational use. |
| **adsb.lol** (point snapshot `/v2/lat/{lat}/lon/{lon}/dist/{nm}`, global military `/v2/mil`, traces) | `server/providers/aircraft/opensky.js:328` (250 nm fallback), `adsb-lol.js:108`, `tracks.js:113`, `gnssIntegrity.js:75` | Both endpoints answered keyless with JSON on 2026-10-22 [web: https://api.adsb.lol/v2/mil, https://api.adsb.lol/v2/lat/51.47/lon/-0.45/dist/25]. The API README warns: "In the future, you will require an API key" (obtained by feeding). It publishes no ToS or licence; rate limits vary with load [web 2026-10-22, https://github.com/adsblol/api]. The historical dumps are "made available under the Open Database License" [web 2026-10-22, https://github.com/adsblol/globe_history_2025]. The **live** API licence is ODbL per the repo only [repo `DATA_SOURCES.md:30-31`]. | Runtime | Not prohibited by any published term (ODbL permits commercial use) | ODbL (attribution and SA on the database) | **KEEP as the default flight source** + ATTRIBUTE "adsb.lol contributors, ODbL 1.0" | **Coverage trade-off.** The point API covers only a **250 nm radius** around the view (`DATA_SOURCES.md:120`), so the default is regional, not worldwide. Military is global. Plan an optional feeder-key field and a visible "key required" state for when keys become mandatory. |
| adsbdb enrichment (type and registration; callsign route) | `/api/adsbdb` → `api.adsbdb.com`; disk cache `.gev-cache/adsbdb.json` | No service licence is published. Route data "may not be copied, published, or incorporated into other databases without the explicit permission of David J Taylor" [repo `DATA_SOURCES.md:32,156`, quoting adsbdb] | Runtime plus a local disk cache | unverified; routes are restricted | **No** (routes) | **Route lookups OFF by default**, and never persist routes to disk. Type and registration: KEEP + DOCUMENT (unverified). | The disk cache arguably "incorporates" route data into a database. |
| AISStream.io (vessels) | `AISSTREAM_API_KEY`, BYOK | Free beta with no formal ToS [repo `DATA_SOURCES.md:33`] | Runtime, BYOK | unverified | unverified | KEEP (BYOK opt-in) + DOCUMENT | |
| CelesTrak TLEs | | US-government-origin data; citation requested [repo] | Runtime | Yes [repo] | Yes [repo] | KEEP + ATTRIBUTE | |
| Launch Library 2 (The Space Devs) | | Use and share in any form; attribution encouraged; 15 anonymous calls per hour [repo `DATA_SOURCES.md:35,157`] | Runtime | Yes [repo] | Yes [repo] | KEEP + ATTRIBUTE | |
| Local receivers (RTL-SDR, LAN `aircraft.json`) | `LOCAL_RECEIVER_FEEDS` | The user's own radio reception | Local | n/a | Not redistributed | KEEP | |

### 1e. Runtime: geocoding, routing, news, weather

| Item | Path or provider | License / terms | Runtime / bundled | Commercial OK? | Redistribution OK? | Action | Notes |
|---|---|---|---|---|---|---|---|
| **Google News RSS** (primary cockpit headlines) | `server/providers/regional/news.js:64-80` is tried **first** and is hard-coded with no flag; User-Agent `GodsEyeView/0.1` (`:74`) | The Google News ToS say users "may only display the content of the Service for your own personal use". They bar commercial use, reformatting, public display and automated monitoring [web 2026-10-22, https://www.google.com/intl/en_us/terms_google_news.html, dated 2006-01-17]. | Runtime | **No** | **No** | **REMOVE as a default; MAKE OPTIONAL, off by default** (or drop) | Make GDELT plus user-configured RSS the default. |
| **GDELT DOC 2.0 API** | `server/providers/regional/news.js:84-109` (currently the fallback); `api.gdeltproject.org/api/v2/doc/doc` | GDELT allows "unlimited and unrestricted use" for academic, commercial and government purposes. Any use or redistribution **must cite the GDELT Project and link to https://www.gdeltproject.org/** [web 2026-10-22, https://www.gdeltproject.org/about.html]. Linked articles keep their publishers' copyright. | Runtime | Yes | Yes, with the citation and link | **KEEP as the default news source** + ATTRIBUTE (required citation and link) | Store only headline, URL, source and timestamp; no article text. DOC API rate limits are unverified. |
| **Nominatim** (OSMF public server) | `server/providers/regional/place.js:128` (`/api/geocode`, last-resort place search) | "absolute maximum of 1 request per second". Requires an identifying UA or Referer and caching. Bans systematic or bulk queries and client-side autocomplete. Requires visible attribution. The data is ODbL [web 2026-10-22, https://operations.osmfoundation.org/policies/nominatim/]. The policy asks that tools suggesting it link the policy, which is done here. | Runtime | Data yes; the service is fair-use only | ODbL | KEEP + DOCUMENT (interactive, user-initiated searches only) | **SKYNET news geoparsing must not call Nominatim per item.** Use the bundled GeoNames gazetteer. The current UA does not include a contact address. |
| Photon (komoot public instance) | Keyless place-search fallback | Public instance asks for fair use: "extensive usage will be throttled". No SLA or attribution terms are stated [web 2026-10-22, https://photon.komoot.io/]. The data is ODbL [repo]. | Runtime | Not addressed; unverified | ODbL data | KEEP + DOCUMENT (fair-use, configurable endpoint) | |
| Overpass | `OVERPASS_UPSTREAMS=` is empty by default (`.env.example:261`) | Operator-configured | Runtime, opt-in | Per instance | ODbL | KEEP (off by default) | Already compliant: nothing is called unless an operator configures an instance. |
| OSRM on FOSSGIS servers (`routing.openstreetmap.de`) | `/api/route` | Policy requires attribution plus a "fix the map" link, a valid UA, 1 request per second at most, and no heavy use. FOSSGIS allows commercial use only with restrictions [repo `DATA_SOURCES.md:99,182-184`, quoting the policy] | Runtime | Restricted [repo] | ODbL | KEEP + DOCUMENT (user-initiated, already rate-limited) | Make the endpoint configurable (self-hosted OSRM). |
| **Open-Meteo** (cockpit weather, weather effects) | `/api/regional-brief`, `/api/weather-effects` | The data is CC BY 4.0, but the **free API is non-commercial only**. Commercial use needs a paid plan. Free-tier limits: under 10,000 calls a day and 5,000 an hour [web 2026-10-22, https://open-meteo.com/en/terms]. `DATA_SOURCES.md:46` mentions only the data licence. | Runtime | **No** (free tier) | Data yes (CC BY) | **MAKE OPTIONAL, off by default** (same rule as OpenSky), or keep with a terms notice | The NC rule is missing from `DATA_SOURCES.md`. A replacement default (for example MET Norway) has **not** been verified. |
| NOAA GFS, ECMWF IFS, nowCOAST, NHC/CPHC | `DATA_SOURCES.md:18-22` | GFS, nowCOAST and NHC are US public domain or NWS terms. ECMWF is CC BY 4.0 plus the ECMWF ToU with a mandated credit [repo] | Runtime | Yes [repo] | Yes [repo] | KEEP + ATTRIBUTE | The ECMWF credit and disclaimer are already in `DATA_CREDITS`. |
| USGS earthquakes, NASA FIRMS (BYOK `FIRMS_MAP_KEY`), NIFC WFIGS, InciWeb, ECCC AQHI | `DATA_SOURCES.md:37-41,252-261` | US public domain or ECCC open licence (attribution) [repo] | Runtime | Yes [repo] | Yes [repo] | KEEP + ATTRIBUTE | |
| Radio Browser | `/api/radio/*` | Directory under PDDL 1.0; streams under each broadcaster's terms [repo] | Runtime | Yes [repo] | Directory yes; audio not proxied | KEEP + ATTRIBUTE | |
| TomTom Traffic (BYOK) | `/api/tomtom` | TomTom developer terms [repo] | Runtime, BYOK | Per the user's TomTom agreement | No | KEEP (BYOK) | Remove the committed fixture (1a). |
| Mapillary (BYOK), Google Street View (BYOK), KartaView, Panoramax | Street Level layer | CC BY-SA 4.0 imagery (Mapillary, KartaView); per-picture licences (Panoramax); Google ToS [repo] | Runtime | Per terms [repo] | SA on imagery | KEEP + ATTRIBUTE (provider credit on screen while active) | |

### 1f. Runtime: CCTV, transit, bikeshare

These are the long tail. All rows here are [repo] (`DATA_SOURCES.md:49-96,115-177`) unless marked. They were not independently verified in this pass.

| Group | Providers | Terms (repo) | Action |
|---|---|---|---|
| Explicitly open-licensed CCTV | Live Traffic NSW (CC BY 4.0), TfL (TfL Open Data), Ontario 511 (OGL-Ontario; BYOK dev key), Fintraffic (CC BY 4.0), DriveBC (OGL-BC), Open Calgary (OGL-Calgary), Catalonia SCT (Llicència oberta), King County (KCGIS terms), Hong Kong TD (DATA.GOV.HK), Statens vegvesen (NLOD) plus Kartverket heights (CC BY 4.0), Toronto (OGL-Toronto), Taiwan MOTC (OGDL-TW 1.0) | Attribution is required. Frames are fetched live and never stored. | KEEP + ATTRIBUTE |
| CCTV with no explicit licence ("courtesy") | City of Austin (frames from **`cctv.austinmobility.io`**; see Gaps), TxDOT, Caltrans, Tallinn, Tarktee, Warendorf, WSDOT ("low volume") | Public feeds; no licence text cited | KEEP + DOCUMENT, **licence unverified** |
| **Restrictive CCTV** | FL511 (personal use only), NYC DOT (needs a data-sharing agreement), Lithuania (photo licence unconfirmed) | Already **off by default** (`.env.example:243,249,251`) | Keep OFF by default |
| **DelDOT live video** | `video.deldot.gov` HLS, relayed through the server | "Public availability is not a blanket redistribution license; deployment beyond personal local viewing needs confirmation" [repo `DATA_SOURCES.md:160`]. Currently **on** by default. | **MAKE OPTIONAL, off by default** (same rule as FL511) |
| Transit GTFS-RT (16 feeds) | MBTA (MassDOT Developers Licence), CapMetro, Metro Transit, OVapi, Entur (NLOD), TransLink (CC BY 4.0), HSL (CC BY 4.0), TTC, MiWay, HSR, DRT, Guelph, Kingston, Barrie, YRT, Burlington | Per-feed licence and URL in `src/data/transitFeeds.js:386-721` | KEEP + ATTRIBUTE (credits are registered per feed). MBTA, CapMetro and Metro Transit licence texts are unverified. |
| Bikeshare GBFS, non-US | PBSC Brazil, Bogotá, Santiago, Spain (Bicing, BiciMAD (EMT open data), Bizi and others), nextbike AMBici (CC0), Urban Sharing and Entur Norway (NLOD), JCDecaux (Licence Ouverte) | Per feed [repo] | KEEP + ATTRIBUTE |
| **Bikeshare GBFS, US: Lyft-operated** | `gbfs.lyft.com` (Citi Bike `bkn`, Divvy `chi`, Capital Bikeshare `dca-cabi`, Bay Wheels `bay`), `gbfs.bluebikes.com`, `gbfs.biketownpdx.com` (`src/layers/bikeshare/registry.js:75-196`) | The Citi Bike Data License Agreement allows use "for any lawful purpose" in a product. It forbids redistributing the data as a standalone dataset and using Citi Bike or Lyft marks or implying affiliation, and Lyft may terminate it at any time [web 2026-10-22, https://citibikenyc.com/data-sharing-policy]. The other Lyft systems are assumed similar, which is unverified. The Citi Bike `system_information.json` has no `license_url` [web 2026-10-22, https://gbfs.lyft.com/gbfs/2.3/bkn/en/system_information.json]. | KEEP + DOCUMENT. **Correct `DATA_SOURCES.md:71`**, which says GBFS is "attribution-only". |
| Bikeshare GBFS, US: other | `gbfs.bcycle.com` (Austin, Indego, LA Metro), `reddybikeshare.socialbicycles.com`, US `*.publicbikesystem.net` (Detroit, Pittsburgh, Aspen, Kona, Austin, Honolulu, Chattanooga, Tucson, Fort Worth) | Not individually documented | KEEP + DOCUMENT, **licences unverified** |

### 1g. Fonts, UI assets, libraries

| Item | Path or provider | License / terms | Runtime / bundled | Commercial OK? | Redistribution OK? | Action | Notes |
|---|---|---|---|---|---|---|---|
| **@fontsource/jetbrains-mono** (planned) | npm | `OFL-1.1`, v5.3.0, from fontsource/font-files `fonts/google/jetbrains-mono` [web 2026-10-22, https://registry.npmjs.org/@fontsource/jetbrains-mono/latest] | Will be bundled | Yes (OFL) | Yes, with the OFL text; the font cannot be sold on its own | KEEP+ATTRIBUTE | Ship the package `LICENSE` and add it to `THIRD_PARTY_NOTICES.md`. Whether Reserved Font Names apply (relevant if the font is subset or modified) is unverified. |
| **@fontsource/rajdhani** (planned) | npm | `OFL-1.1`, v5.3.0 [web 2026-10-22, https://registry.npmjs.org/@fontsource/rajdhani/latest] | Will be bundled | Yes | Yes, with the OFL text | KEEP+ATTRIBUTE | Same notes as above. |
| Google Fonts at runtime (JetBrains Mono, **Inter**, **Material Symbols Outlined**) | `index.html:24,29`; CSP `build/vite.js:26-27`; allowlist `src/tools/globePanel.js:38-39` | OFL (Inter, JetBrains Mono) and Apache-2.0 (Material Symbols). These are commonly published terms, **not web-verified in this pass**. | Runtime from `fonts.googleapis.com` and `fonts.gstatic.com` | Yes (unverified) | Yes (unverified) | **REPLACE** with locally bundled fonts | Breaks offline and local-first use, and sends the user's IP to Google. **Gap:** not in `DATA_SOURCES.md`. Bundle Material Symbols (or swap icons) as well, not only the two planned fonts. |
| ALPR marker art | `src/layers/alpr/assets/*.png` | Contributed by @manjunath22466 (`src/layers/alpr/visuals.js:24`); contributions are MIT under `CONTRIBUTING.md:169` | Bundled | Yes | Yes | KEEP (credit in NOTICE) | |
| UI glyph SVGs | `public/pin.svg`, `location.svg`, `mic.svg`, `visual-presets.svg` | Part of the MIT repo. `location.svg` matches the Feather "map-pin" path (MIT); that match is my inference and **unverified**. | Bundled | Yes | Yes | KEEP | Not branding. Recolour for the theme. |
| npm runtime dependencies | `cesium` 1.138.0 (Apache-2.0), `hls.js` (Apache-2.0), `@meri-imperiumi/eccodes-wasm` (Apache-2.0), `@jtarrio/*` (Apache-2.0), `mapillary-js` (MIT) with its dependencies `rxjs` 7.8.2 (Apache-2.0) and `three` 0.134.0 (MIT) per `THIRD_PARTY_NOTICES.md`, `satellite.js` (MIT), `mgrs` (MIT), `egm96-universal` (MIT, with the EGM96 grid), `pbf` and `@mapbox/vector-tile` (BSD-3-Clause) | Read from `node_modules/*/package.json` [repo] | Bundled into the build | Yes | Yes, with notices | KEEP + DOCUMENT | `THIRD_PARTY_NOTICES.md` lists only 5 packages. Generate a full notices file; Apache-2.0 NOTICE files must travel with the build. |
| AI providers (BYOK): OpenAI Realtime and Responses, Gemini Live | `server/providers/openai/realtime.js:132`, `hud-summary.js:57`, `server/providers/gemini/config.js:6-8` | Each provider's API terms (BYOK) | Runtime | Per the user's agreement | n/a | KEEP (BYOK) + DOCUMENT as data processors | **Gap.** These receive map context and screenshots (`DATA_SOURCES.md:178`). Neural Core uses local Ollama by default. |

---

## 2. Upstream branding assets to exclude from SKYNET

| Asset | Path | License / reuse status | Action |
|---|---|---|---|
| GEV eye logo (SVG, with `<title>God's Eye View</title>`) | `public/logo.svg` | In the MIT repo with no carve-out, so the copyright licence permits reuse. MIT grants **no trademark rights**, and whether "God's Eye View" is a registered trademark is unverified. | Replace with the SKYNET mark |
| Favicons and PWA icons (rasterized from the logo by `scripts/generate-icons.mjs:16-36`) | `public/icons/icon-32.png`, `icon-180.png`, `icon-192.png`, `icon-512.png`, `icon-512-maskable.png` | Same as the logo | Regenerate from the SKYNET logo |
| PWA manifest name and description | `public/manifest.webmanifest` ("God's Eye View" / "God's Eye") | MIT text | Rebrand |
| Page title, Apple title, favicon links | `index.html:6,10,13,20` | MIT text | Rebrand |
| Pinokio launcher title and menu | `pinokio/pinokio.js:3-4,26` | MIT text | Rebrand or drop the Pinokio launcher |
| **README capture GIFs (17) and PNGs (2)**, about 79 MB | `docs/media/*.gif`, `docs/media/start-here/*.gif`, `docs/media/youtube-popular-videos.png`, `docs/media/open-source-survey.png` | **Not MIT.** © Bilawal Sidhu. Redistribution is permitted only *with this repository and its documentation*; "No permission is granted for standalone reuse or modification" [repo `docs/media/README.md`]. They show the GEV brand and Bilawal's likeness, Google 3D Tiles, and TeleGeography data (`09-undersea-cables.gif`). | **REMOVE** from the SKYNET tree and docs (git history may keep them; that is permitted). Never use them in SKYNET branding. |
| Halfpixel mentions | Text only: `README.md:637,660`, `CONTRIBUTING.md:161`, `scripts/qa-anime-sky.mjs:31` (a QA request-block for `halfpixel.ai` and `worldfx`) | No image file is named for or references Halfpixel, and a text search of the repo (excluding `node_modules`) finds these 4 lines only. Image *contents* (for example GIF frames) were not inspected. All of `docs/media` is marked REMOVE anyway. | Remove or rewrite the text |
| OG / Twitter card images | None. `index.html` has no `og:` or `twitter:` meta tags. | n/a | When adding SKYNET OG tags, use only SKYNET-owned art |
| README badges and "hosted version" pitch | `README.md:5,660` | Upstream marketing | Rewrite |
| Branded User-Agents and client IDs | `GodsEyeView/0.1` (`server/providers/regional/news.js:74,96`); `gods-eye-view-*` (`server/providers/aircraft/adsb-lol.js:109`, `opensky.js:332`, `cctv.js:120,381`, `cctv/media.js:471`, `cctv/sources.js:1048,1539`, `cctv/stream.js:39`, `gbfs.js:80`, `gnssIntegrity.js:81`, `places/routes.js:179`); `Gods Eye View (…)` (`cyclones.js:271`); `ET-Client-Name` (`src/data/gbfsSource.js:35`, `src/data/transitFeeds.js:502`); the `Digitraffic-User: gods-eye-view` header [repo `DATA_SOURCES.md:161`] | MIT code | Rename to `skynet/<ver> (+contact URL)`. OSMF and Nominatim require an identifying UA with contact details. |
| Internal identifiers | `package.json` name `gods-eye-view`, `window.__godsEyeView`, `gev:*` storage keys, about 79 `src`/`server` files with "God's Eye"/GEV strings | MIT code | Rebrand user-visible strings via `src/branding.js`. Internal keys can wait, but migrate stored state if they change. |
| Third-party trademark in comments | `src/styles/anime.js:4,65` ("Studio Ghibli") | Comment only | Keep it out of SKYNET UI and marketing |

---

## 3. Gaps: providers used in code but not documented in `DATA_SOURCES.md`

Each host below is fetched, or embedded, by non-test code. Hosts that appear only as credit or documentation links (for example `raw.githubusercontent.com` in Natural Earth `meta` headers, `gpsjam.org`, `www.esri.com`) are excluded.

| Host(s) | Where | What it is | Missing from `DATA_SOURCES.md` |
|---|---|---|---|
| `tile.openstreetmap.org` | `src/maps/imagery.js:9`; `src/tools/globePanel.js:35` | OSM raster basemap and automatic Esri fallback | The tile server and the OSMF Tile Usage Policy are not named. The OSM row (`:27`) lists only vector tiles, Nominatim and Overpass. |
| `api.cesium.com`, `assets.ion.cesium.com`, `ion.cesium.com` | `src/maps/imagery.js:39`, `src/maps/google3d.js:118`, `src/maps/terrain.js` | Cesium ion (Google 3D via ion, Cesium World Terrain, Bing endpoint) | No Cesium ion row. Its Community-plan NC terms appear only in `.env.example:53`. |
| `dev.virtualearth.net`, `ecn.t0-3.tiles.virtualearth.net` | `src/maps/catalog.js:10-25`, `src/maps/imagery.js:37-66`, `src/tools/globePanel.js:28-32` | Bing Aerial / Labels via ion | No Bing / Microsoft row. |
| `cctv.austinmobility.io` | `server/providers/cctv/sources.js:229-230` | Austin CCTV frame host | Only `data.austintexas.gov` is credited. |
| `tiles.dontgetflocked.com` | `src/layers/alpr/source.js:77-78` | Community-hosted hourly OSM ALPR extract | Described only as a "community-hosted hourly US/Canada extract" (`:223-235`). The host and its operator's terms are not named, and are unverified. |
| `fonts.googleapis.com`, `fonts.gstatic.com` | `index.html:24,29`, `build/vite.js:26-27` | Google Fonts (Inter, JetBrains Mono, Material Symbols) | Not documented. |
| `www.youtube.com`, `www.youtube-nocookie.com`, `i.ytimg.com`, `platform.twitter.com`, `connect.facebook.net`, `www.facebook.com`, `*.fbcdn.net` | `src/data/bhoteKoshiEmbeddedMedia.js:4-36,405`, `build/vite.js:25,34` | Third-party embed SDKs for Bhote Koshi witness posts | Not in the live-sources table (only in the event-pack README). Removed with the pack. |
| `api.openai.com`, `generativelanguage.googleapis.com` | `server/providers/openai/realtime.js:132`, `hud-summary.js:57`, `server/providers/gemini/config.js:6-8` | BYOK voice and HUD-summary AI providers | Not listed as processors, though `:178` mentions screenshots sent to the voice model. |
| `gbfs.lyft.com`, `gbfs.bluebikes.com`, `gbfs.biketownpdx.com`, `gbfs.bcycle.com`, `reddybikeshare.socialbicycles.com`, US `*.publicbikesystem.net` (detroit, pittsburgh, aspen, kona, austin, hon, chat, tucson, fortworth) | `src/layers/bikeshare/registry.js:3,75-508` | US bikeshare GBFS feeds | Covered only by the generic GBFS row (`:71`, "attribution-only"), which is wrong for Lyft feeds (see 1f). Systems are not individually credited in `dataCredits.js:347-355`. |
| `storage.googleapis.com` | `config/cctv_sources.shinjuku.json:10,29,48` | Google sample videos (demo pack) | Not documented; recommend removing (1a). |
| `s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk` | `server/providers/cctv/constants.js:140` | TfL JamCam frame bucket | Mentioned generically ("TfL's public S3 bucket", `:158`). The host is not named, which is minor. |

Also out of date in `DATA_SOURCES.md`:
- The Esri credit names "Maxar"; the live service now says "Vantor" (`:36`).
- The Open-Meteo free-API NC restriction is missing (`:46`).
- The Google 3D tiles on-screen credit requirement (`showCreditsOnScreen`) is not enforced in code.

---

## 4. Required attribution set: what must stay visible at all times

**A. On-screen credit line.** This is `#cesium-credits`, bottom-left. It stays visible in clean-view and recording modes and must never sit behind a toggle. Its contents depend on what is shown:

1. **Google Maps logo plus Google data attributions,** whenever Google Photorealistic 3D Tiles or Street View are visible. Set `showCreditsOnScreen: true` on the tilesets (Google policy). The logo must not be overlapped or obscured, including by the SKYNET wordmark.
2. **Cesium ion credit or logo** whenever ion assets are in use (CesiumJS adds this automatically).
3. **Esri,** when the Esri stack is active: "Powered by Esri" plus the service's live `copyrightText`, currently "Esri, Vantor, Earthstar Geographics, and the GIS User Community".
4. **"© OpenStreetMap contributors"** whenever OSM tiles or OSM-derived data are on screen (OSM raster, OpenFreeMap vector, datacenters, dams, military names, ALPR, routes). Add **"© OpenMapTiles / OpenFreeMap"** when vector tiles are used. OSMF requires the credit on the map itself.
5. **Bing / Microsoft credits** from the ion endpoint when a Bing stack is active.
6. **Street Level provider credit** while it is active: Mapillary (CC BY-SA 4.0), KartaView (CC BY-SA 4.0), Panoramax (licence per picture), or Google Street View.
7. A **"Data attribution"** link that opens the full list in B.

**B. "Data attribution" popover.** It must stay reachable at all times. Keep every existing `DATA_CREDITS` entry (`src/data/dataCredits.js:101-500`) for the sources SKYNET keeps, including:
- adsb.lol (ODbL)
- OpenSky with its IPSN 2014 citation, when enabled
- ECMWF with its mandated text and disclaimer
- ECCC, TfL, NSW, NLOD, OGL-x and other prescribed CCTV and transit wordings
- the NYC DOT disclaimer, when enabled
- NASA FIRMS and GIBS acknowledgements
- ESO/S. Brunier
- the Yale BSC
- Radio Browser
- the OSRM "fix the map" link
- Open-Meteo, as a linked "Weather data by Open-Meteo.com" next to the data, when enabled

Add these credits:
- **GDELT Project** with a link to https://www.gdeltproject.org/ wherever GDELT-sourced headlines appear. GDELT requires it.
- **GeoNames** for the planned gazetteer: "Contains data from GeoNames (geonames.org), CC BY 4.0". Its readme licenses the data under CC BY 4.0 [web 2026-10-22, https://download.geonames.org/export/dump/readme.txt].
- **3D models (CC BY 4.0):** title, creator, source link, licence link and "modified" for each model, using the corrected names from 1b. Today this is only in `public/models/README.md`.
- **Natural Earth** ("Made with Natural Earth", courtesy) and the **US Census Bureau** (courtesy). These are already dynamic credits.
- One credit per news source for user-configured RSS feeds (publisher name plus link).

Remove these credits together with their data:
- TeleGeography (`dataCredits.js:494-499`)
- Bhote Koshi (`:556-573`)
- Google News RSS (`:194-200`), unless the user opts in

**C. Outside the map UI.** Not shown permanently, but these must ship:
- **About / NOTICE.md:** the upstream MIT notice ("Copyright (c) 2026 Bilawal Sidhu" plus the permission notice) and SKYNET's own line.
- **`THIRD_PARTY_NOTICES.md`:** the OFL-1.1 texts for JetBrains Mono, Rajdhani and Inter (if kept), and the Apache-2.0 NOTICEs for Cesium, hls.js, eccodes-wasm and webrtlsdr.
- The **non-navigation / not-safety-critical disclaimer**, from GEV `README.md:642` and the SKYNET brief.

---

## 5. Open items for a human decision

1. **Esri as the keyless default landing.** Options: (a) replace it with NASA GIBS (public domain) and make Esri opt-in, which is recommended; or (b) keep Esri after an Esri or legal review.
2. **`bell206.glb`.** The source page is gone. Replace it, or accept the documented risk.
3. **Model credits.** Fix the `jet`, `c172` and `atr72` credits after confirming whether the uploaders were renamed.
4. **Open-Meteo.** Turn it off by default (consistent with the NC rule), or keep it on behind a visible terms notice. A replacement keyless weather source is unverified.
5. **Google 3D compliance.** Set `showCreditsOnScreen: true`, and confirm whether the Photon/Nominatim fallback may coexist with Google tiles (Cesium says Google geocoder only).
6. **Never independently verified here:** the Re:Earth/Mapterhorn per-source terms, the `tiles.dontgetflocked.com` operator terms, and the licences of the courtesy-only CCTV packs.
