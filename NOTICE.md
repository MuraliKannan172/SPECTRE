# NOTICE

SPECTRE is a modified version of **God's Eye View** by Bilawal Sidhu,
https://github.com/bilawalsidhu/gods-eye-view, forked from `main` at commit
`7be5937f` (version 0.2.1) on 2026-10-22.

God's Eye View is licensed under the MIT License, Copyright (c) 2026 Bilawal
Sidhu. That copyright and permission notice are kept in [LICENSE](LICENSE) and
apply to the upstream code SPECTRE contains. SPECTRE's own changes are also
offered under the MIT License. SPECTRE is not affiliated with or endorsed by
God's Eye View or its authors.

## Third-party data and assets (not MIT)

The MIT License in [LICENSE](LICENSE) covers the source code only.

The datasets bundled under `src/data/local_data/`, and all data fetched from
third-party providers at runtime, are owned by their respective sources and
are NOT licensed under MIT. They are included/visualized for convenience and
remain subject to their own licenses and terms. Notably:

- Datacenters and Dams (OpenStreetMap / Open Infrastructure Map extracts):
  Open Database License (ODbL) 1.0 — attribution + share-alike on the data.
- TeleGeography Submarine Cable Map: CC BY-NC-SA 3.0 — NonCommercial +
  ShareAlike. SPECTRE does NOT ship it; `scripts/fetch-optional-data.ps1` lets
  you download it for personal, non-commercial use into a gitignored folder.

SPECTRE removed upstream's Bhote Koshi event imagery and derived river
centerline (CC BY-NC 4.0); see [What SPECTRE changed](#what-spectre-changed).

Live sources (Google Maps, OpenSky, adsb.lol, AISStream, CelesTrak, USGS,
OSM Overpass, City of Austin, GBFS) are fetched at runtime under each
provider's terms; some (e.g. Google Maps, OpenSky) restrict commercial use
and require you to supply your own credentials. SPECTRE keeps the
personal-use-only ones (OpenSky, Open-Meteo's free API, Google News RSS,
adsbdb routes) off until you turn on Non-commercial sources.

The fonts SPECTRE bundles are under the SIL Open Font License 1.1 (JetBrains
Mono, Inter, Rajdhani) and the Apache License 2.0 (Material Symbols); see
[Third-party components added by SPECTRE](#third-party-components-added-by-spectre).

In short: the MIT grant does not extend to any third-party data. See
[DATA_SOURCES.md](DATA_SOURCES.md) for the full per-source license +
attribution summary, and remove any dataset whose terms don't fit your use.

The 3D models under `public/models/` are also third-party works and are NOT
licensed under MIT. They remain under their individual licenses. See
[public/models/README.md](public/models/README.md) for the author, source,
license, modification notice, and attribution covering each model file.

## What SPECTRE changed

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
- All product naming lives in `src/branding.js`; a new logo and icons; SPECTRE
  User-Agents toward upstream services.
- A Vanta-black and Ferrari-red theme (`src/theme/`), with fonts bundled instead
  of loaded from Google Fonts.

## Third-party components added by SPECTRE

| Component | Licence |
| --- | --- |
| @fontsource/jetbrains-mono, @fontsource/inter, @fontsource/rajdhani (JetBrains Mono, Inter, Rajdhani fonts) | SIL Open Font License 1.1 |
| material-symbols (Material Symbols Outlined font) | Apache License 2.0 |
| Intel service Python packages (installed by uv from `intel/uv.lock`, not committed): FastAPI, Starlette, Pydantic, Uvicorn, HTTPX, feedparser, RapidFuzz, PyYAML, spaCy and its `en_core_web_sm` model | See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) |
| GeoNames `cities15000` and `countryInfo`, in `intel/app/geo/data/gazetteer.json.gz` | CC BY 4.0, "GeoNames, https://www.geonames.org/" |
| Local voice, opt-in only (`scripts\spectre.ps1 -Voice`; not installed or bundled by default): faster-whisper, CTranslate2, ONNX Runtime, kokoro-onnx, PyAV | MIT (faster-whisper, CTranslate2, ONNX Runtime, kokoro-onnx); BSD-3-Clause (PyAV, whose wheels bundle FFmpeg libraries under FFmpeg's own licence) |
| Local voice, opt-in only: phonemizer and espeak-ng (through espeakng-loader, MIT), pulled in by kokoro-onnx | **GPL-3.0** (phonemizer GPL-3.0-or-later). SPECTRE's code stays MIT and never ships these; the person who opts in installs them on their own machine. Piper, the brief's other text-to-speech option, is GPL-3.0 itself. |
| Voice models fetched by `intel/scripts/fetch_voice_models.py`: faster-whisper `base`, Kokoro-82M and its voices | MIT (Whisper base); Apache-2.0 (Kokoro-82M) |

Data sources, their terms and required attribution are listed in
[DATA_SOURCES.md](DATA_SOURCES.md).
