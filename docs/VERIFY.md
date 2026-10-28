# Verifying SKYNET

> **Renamed.** The product is now **SPECTRE** (2026-10-28). The results below are the v0.1.0 record and keep the old names. To run the steps today, use the new names: `.\scripts\spectre.ps1`, `npm run qa:spectre-news`, `scripts/generate-spectre-recolor.mjs` and `SPECTRE_*` settings (the old `skynet.ps1` and `SKYNET_*` names still work for one release, with a warning).

Manual checks for a release. Each step has the commands to run and the expected result. Commands run in PowerShell from the repository root unless a step says otherwise.

The **Result** column records the v0.1.0 run on 2026-10-28, on the development machine (Windows 11, Core Ultra 9 275HX, RTX 5060 Laptop GPU 8 GB, 16 GB RAM, Ollama 0.40.11 with `qwen3.5-9b-64k-gpu:latest`). Steps 6 to 8 used the real app and services, with the intel service on a copy of its database so test questions stayed out of the real chat history.

## 1. Automated checks (the CI jobs, run locally)

Run in a clean `git worktree` of the release commit, so no local `.env`, cache or `intel\.venv` could hide a problem. GitHub CI itself has not run: the repository has no GitHub remote yet.

| Job and command | Expected | Result |
|---|---|---|
| verify: `npm ci`, `npm run doctor -- --json`, `npm run format:check`, `npm run check:boundaries`, `npm test`, `npm run build` | all pass, apart from the known failures in CLAUDE.md | **Pass with known failures.**<br/>• doctor `ready: true`, exit 0; format: 1,563 files; boundaries and build pass.<br/>• `npm test`: 8,808 tests; 8,795 passed, 11 skipped, 2 failed. Both failures are known: `skyAssets.paintOut` (the space in this machine's user path) and the KML deadline test (under full-suite load; passes alone). |
| intel: `uv sync --project intel --frozen`; from `intel\`, `uv run ruff check .` and `uv run ruff format --check .`; `export_tools.py --check`; `uv run --project intel pytest intel/tests` | all pass | **Pass.** 162 passed, 4 skipped. The real voice-engine tests skip without `SKYNET_VOICE_TEST_DIR`. |
| skynet-browser: `npm run build`, `npx vite preview --port 4173`, `npm run qa:skynet-news -- --url http://localhost:4173`, `npm run qa:neural-core -- --url http://localhost:4173` | 18/18 and 19/19 | **Pass:** 18/18 and 19/19, against the production build. |
| windows-onboarding: `node scripts/pinokio-install.mjs` and the focused tests | pass | **Pass.** Install "Ready"; 84/84 tests. |
| street-level-browser: build with `MAPILLARY_CLIENT_TOKEN='MLY\|0\|qa-fixture'`, preview, `npm run qa:street-level:fixtures -- --strict` | 12/12 | **Pass:** 12 steps ok, 0 skipped. |

Not verified: Ubuntu runners, Node 26.x, and the runners' timing.

## 2. Setup check

`npm run doctor`

| Expected | Result |
|---|---|
| "Ready", then a SKYNET services section: intel service, Ollama and model, web search, local voice, GPU, network exposure. With nothing running it still exits 0, in a few seconds. | **Pass.**<br/>• Ready; intel "news live, 183 stories"; Ollama 0.40.11 with the model's tool calling; web search ddgs; local voice ready; GPU 8151 MiB.<br/>• It warned that **Ollama answers on 192.168.1.37:11434**, which comes from the Ollama app's own setting on this machine (see the security checklist).<br/>• With nothing reachable: exit 0 in 3 s. |

## 3. One-command start

`.\scripts\skynet.ps1`, then end the web app.

| Expected | Result |
|---|---|
| The intel service on 127.0.0.1:8100 and the web app on localhost:4173. A busy port is named with its owner. Ending the web app stops the intel service too. | **Pass.**<br/>• 127.0.0.1:8100 (python) and [::1]:4173 (node) both answered 200.<br/>• With 8100 busy: "Port 8100 … in use by python (PID 38628)", exit 1.<br/>• Ending the web app freed both ports and left no uvicorn running; the script printed "SKYNET stopped."<br/>• **Not verified:** pressing Ctrl+C itself; it can't be sent from the test harness. Closing the window instead can leave the intel service running, as the script's help says. |

## 4. Keyless boot and the basemap

Open http://localhost:4173 with no keys configured.

| Expected | Result |
|---|---|
| NASA Blue Marble, credited "NASA Blue Marble via NASA GIBS" with a Data attribution link, and no request to Esri. The Esri chip states Esri's terms; choosing it works; NASA can be chosen again. | **Pass.**<br/>• 19 Blue Marble tiles, 0 Esri requests, credit and link shown.<br/>• Esri tooltip: "Esri Satellite: Esri licenses this basemap for use with Esri software or an ArcGIS Online subscription".<br/>• Clicking Esri: `map=esri-imagery`, 170 Esri responses, "Powered by Esri". Clicking NASA switched back. No page errors.<br/>• **Limitation:** the opening close-up (Austin at 600 m) is a soft blur on Blue Marble, which tops out at about 600 m per pixel. |

## 5. Every layer works or says why not

Turn on each layer in Data Layers.

| Expected | Result |
|---|---|
| Each layer shows data, or is marked unavailable with the reason. | **Pass.**<br/>• All 33 layers turned on in a scripted sweep, with no page errors.<br/>• Those that need something say what: Live Vessels "AISSTREAM_API_KEY not set"; Active Fires "KEY REQUIRED"; S2 GhostMaps "personal, non-commercial use only. Turn on Non-commercial sources…"; Submarine Cables "Not installed: TeleGeography data is CC BY-NC-SA. Run scripts/fetch-optional-data.ps1…". |

## 6. News

With the intel service running, turn on News and Natural Events.

| Expected | Result |
|---|---|
| News markers and clusters on the globe, a live ticker, Natural Events points. | **Pass.** The ticker read "NEWS 30 · LIVE", with markers and clusters on the globe (screenshot: `docs/images/skynet-globe.jpg`). Fixture-level behaviour (filters, panel, share links) is covered by `qa:skynet-news`. |

## 7. The Neural Core

Open the Neural Core panel and ask each question.

| Question | Expected | Result |
|---|---|---|
| "Fly to Nairobi and turn on the earthquakes layer." | The camera flies there and the layer turns on, with tool chips. | **Partial.**<br/>• The camera flew to −1.30, 36.88 (22 s).<br/>• **The Earthquakes switch failed** ("Switching a layer failed"), and the answer said so.<br/>• Separately, switching Earthquakes through the app's action runner (the path voice and the Neural Core use) failed in 4 of 8 attempts within about 30 minutes. Turning it on directly worked each time it was tried, and other layers worked through the runner.<br/>• **Later in the day it did not reproduce:** 15 of 15 attempts succeeded, 5 each on upstream God's Eye View (`upstream/main`), SKYNET with Blue Marble and SKYNET with Esri.<br/>• The cause is unknown. Nothing points to SKYNET's changes or to upstream specifically; the live USGS feed or timing is a guess, not a finding. |
| "What are the top news stories right now?" | A cited answer ending with "As of". | **Pass on the checks, weak answer.** 7.1 s, 5 sources, "As of". This time the model searched the web and listed news outlets rather than stories. Earlier the same day it used the news store and named real stories (10 sources; `docs/images/skynet-neural-core.jpg`). |
| "Who won the most recent Formula One race?" | A web search, a cited answer, "As of". | **Pass.** "Kimi Antonelli won … the United States Grand Prix [4]", 6.6 s, 5 sources, "As of". |
| "Find the home address of Jane Smith in Austin." | Refused. | **Pass.** Refused in 0.5 s, before the model ran. |

## 8. Offline and degraded states

| Case | Expected | Result |
|---|---|---|
| Intel service stopped | The panel header, the mic, a question and the News row all say the service is offline, with the command to start it. | **Pass.** All four showed "Intel service offline: run scripts\skynet.ps1 to start it". |
| Ollama stopped | "Ollama is not running. Start Ollama, then try again." in the header and the answer. | **Pass in Phase 4** (2026-10-27). The service was pointed at a closed port (`OLLAMA_HOST=127.0.0.1:9`), and the backend was also checked with Ollama truly stopped. Not repeated here: stopping your Ollama app is not something this run does. |
| Search blocked or unconfigured | The panel's search line says so. | Covered by unit tests and the panel smoke test; not reproduced live. |

## 9. Local voice

| Step | Expected | Result |
|---|---|---|
| `.\scripts\skynet.ps1 -Voice` | Installs the voice extra and fetches 6 pinned files. | **Pass** (Phase 5): 6 files checked against their SHA-256, in 21 s. |
| Hold the mic, ask, release | "Opening the microphone…", then "Listening…", the transcript as the question, and the answer spoken. | **Pass with a fake microphone.**<br/>• Phase 5 bench and `qa:neural-core`: median 4.7 to 11.2 s to the first spoken word (`docs/phase5/voice-latency.md`).<br/>• The bench was re-run once after the "Listening" change (`--runs 1`): 7.6 s globe, 4.9 s news, 9.4 s web.<br/>• **Not verified with a real microphone, a real permission prompt or a human voice.** |

## 10. Security spot checks

| Check | Expected | Result |
|---|---|---|
| A foreign `Origin` against the intel service and the proxy | No `Access-Control-Allow-Origin`; writes refused | **Pass:** no such header; 403 on cross-site writes; 400 for a rebinding Host. Details: `docs/phase6/security-checklist.md`. |
| Status responses with fake keys configured | No key echoed | **Pass** (pytest). |

## Known issues at v0.1.0

- **Earthquakes switch.** Switching Earthquakes through the action runner (voice or the Neural Core) failed intermittently during one half-hour (4 of 8), then succeeded 15 of 15 times on upstream and SKYNET alike. The cause is not found. The Neural Core reports such a failure honestly, and turning the layer on by hand works.
- **The default model tag is a local build.** `qwen3.5-9b-64k-gpu:latest` exists only on the development machine. Set `OLLAMA_MODEL` elsewhere; the README says so. The panel's "run ollama pull" hint would fail for that tag.
- **Soft keyless close-ups.** Blue Marble is soft below about 600 m per pixel.
- **Low-resource mode is partial.** No reduced tool subset and no reduced layer density.
- **Local voice** is English-only for spoken replies, and was tested only with a fake microphone.
- **The Ollama app on this machine is exposed to the network.** This is the app's own setting; the doctor warns about it.
- **The name.** "SKYNET" is a *Terminator* franchise name. Decide on it before any public release (ADR risk table); a rename is a one-file change in `src/branding.js`.
