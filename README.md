# SKYNET

**A local-first global intelligence globe.** Live flights, satellites, weather, cameras and public data on a photorealistic 3D Earth, running on your own machine with no required paid keys.

SKYNET is a fork of [God's Eye View](https://github.com/bilawalsidhu/gods-eye-view) (MIT, © Bilawal Sidhu), rebranded in a Vanta-black and Ferrari-red theme, and is adding real-time news intelligence and a local Ollama analyst. It keeps God's Eye View's layers and tools except where their data could not be redistributed: the Bhote Koshi flood event and its tool are gone, submarine cables are an opt-in download, and helicopters use the generic aircraft model. See [NOTICE.md](NOTICE.md) for every change from upstream.

> **Status: Phase 1 of 6** ([docs/ADR-001.md](docs/ADR-001.md)). Done: the fork, licence hygiene, rebrand and theme. Not built yet: the news intelligence service, the news layer and the Neural Core chat panel (Phases 2 to 4). This README is interim; Phase 6 replaces it.

## Quick start (Windows 11, PowerShell)

Needs Node 24.14+ (or 26.x). From the repository root:

```powershell
npm ci
npm run doctor
npm run dev
```

Then open http://localhost:4173. It works without any API key: Esri imagery with keyless terrain, flights from adsb.lol within 250 nm of the view, satellites, earthquakes and more. Keys you add in **Provider Settings** (the POWER UP chip, bottom right) unlock Google 3D tiles, voice, ships, fires and live traffic.

## Data you have to opt in to

Some free sources allow only personal, non-commercial use, so SKYNET leaves them off:

- **Non-commercial sources switch** (Provider Settings): turns on worldwide OpenSky flights, Open-Meteo cockpit weather, Google News headlines and adsbdb flight routes. It writes `SKYNET_NONCOMMERCIAL_SOURCES=1` to your local `.env`.
- **Submarine cables** (TeleGeography, CC BY-NC-SA): not shipped. For personal use, run `.\scripts\fetch-optional-data.ps1 -AcceptNonCommercialLicense`.

[DATA_SOURCES.md](DATA_SOURCES.md) lists every source, its terms and its attribution.

## Responsible use

SKYNET models **events, assets, infrastructure and systems**: aircraft, vessels, satellites, fires, cameras, cities. It does not search for, recognise or track individual people, and contributions that cross that line will not be merged.

It is not for navigation, emergency response or any other safety-critical use. Data comes from public feeds that can be late, incomplete or wrong.

## Licence

The code is MIT ([LICENSE](LICENSE)), which covers code only. Bundled data, 3D models and fonts keep their own licences; see [DATA_SOURCES.md](DATA_SOURCES.md), [public/models/README.md](public/models/README.md) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Upstream's full README, with its feature walkthrough and key setup, is archived at [docs/upstream/GODS-EYE-VIEW-README.md](docs/upstream/GODS-EYE-VIEW-README.md).
