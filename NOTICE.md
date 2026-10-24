# NOTICE

SKYNET is a modified version of **God's Eye View** by Bilawal Sidhu,
https://github.com/bilawalsidhu/gods-eye-view, forked from `main` at commit
`7be5937f` (version 0.2.1) on 2026-10-22.

God's Eye View is licensed under the MIT License, Copyright (c) 2026 Bilawal
Sidhu. That copyright and permission notice are kept in [LICENSE](LICENSE) and
apply to the upstream code SKYNET contains. SKYNET's own changes are also
offered under the MIT License. SKYNET is not affiliated with or endorsed by
God's Eye View or its authors.

## What SKYNET changed

Every change below is in the git history; the design is in
[docs/ADR-001.md](docs/ADR-001.md).

**Data and licence hygiene**
- Removed the TeleGeography submarine-cable data (CC BY-NC-SA). The layer stays
  and says "Not installed"; `scripts/fetch-optional-data.ps1` downloads the data
  for personal use into a gitignored folder.
- Removed the Bhote Koshi / Nepal flood event (CC BY-NC 4.0 imagery and
  coordinates), with its scene, layers, tool and embed origins.
- Removed CCTV ground heights sampled from Google 3D Tiles, the recorded TomTom
  traffic tile (replaced by a generated synthetic tile), the Shinjuku demo
  camera pack, the `bell206.glb` model (licence no longer verifiable) and the
  upstream demo GIFs and images in `docs/media` (no reuse grant).
- Put OpenSky, Open-Meteo's free API, Google News RSS and adsbdb route data
  behind an off-by-default **Non-commercial sources** switch in Provider
  Settings. Flights default to adsb.lol; headlines to GDELT.
- Google 3D Tiles show their attributions on screen; the Esri credit uses the
  service's live copyright line; every 3D model is credited in the app.

**News intelligence (`intel/`, new)**
- A local Python service (FastAPI, 127.0.0.1 only) that polls news feeds and
  GDELT, clusters reports of one event, places them with a gazetteer built from
  GeoNames (CC BY 4.0) and Natural Earth, and serves them over REST and SSE.
  It keeps headline, short summary, source, link and time only. Feeds whose
  terms are personal-use or unchecked are polled only while Non-commercial
  sources is on.

**Branding and theme**
- All product naming lives in `src/branding.js`; a new logo and icons; SKYNET
  User-Agents toward upstream services.
- A Vanta-black and Ferrari-red theme (`src/theme/`), with fonts bundled instead
  of loaded from Google Fonts.

## Third-party components added by SKYNET

| Component | Licence |
| --- | --- |
| @fontsource/jetbrains-mono, @fontsource/inter, @fontsource/rajdhani (JetBrains Mono, Inter, Rajdhani fonts) | SIL Open Font License 1.1 |
| material-symbols (Material Symbols Outlined font) | Apache License 2.0 |
| Intel service Python packages (installed by uv from `intel/uv.lock`, not committed): FastAPI, Starlette, Pydantic, Uvicorn, HTTPX, feedparser, RapidFuzz, PyYAML, spaCy and its `en_core_web_sm` model | See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) |
| GeoNames `cities15000` and `countryInfo`, in `intel/app/geo/data/gazetteer.json.gz` | CC BY 4.0, "GeoNames, https://www.geonames.org/" |

Data sources, their terms and required attribution are listed in
[DATA_SOURCES.md](DATA_SOURCES.md).
