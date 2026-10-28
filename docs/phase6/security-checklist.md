# Security and reliability checklist (Phase 6)

The brief's section 8, item by item, with the evidence. Checked on 2026-10-28 on the development machine (Windows 11). "Partial" means part of the item is not built, and the gap is named.

| # | Item | Status |
|---|---|---|
| 1 | Servers bound to 127.0.0.1; LAN sharing opt-in; CORS limited to the app | Done for SKYNET's servers. Ollama on this machine is exposed (see below). |
| 2 | Secrets only in `.env` or Provider Settings; none hard-coded; none sent to the browser beyond GEV's | Done |
| 3 | Inputs validated; chat and web fetch rate-limited; responses capped; errors sanitized | Done, with one note on voice errors |
| 4 | Tool calls and fetched URLs logged locally, no content; gitignored log folder | Done |
| 5 | Graceful degradation with a visible state: feed down, Ollama down, search blocked, no keys | Done (see `docs/VERIFY.md`) |
| 6 | GPU budget documented; low-resource mode | Partial |

## 1. Binding and cross-origin access

**What listens where.** Command (PowerShell, with the app, the intel service and the Ollama app running): `netstat -ano | findstr LISTEN`, filtered to the three ports.

```text
TCP    0.0.0.0:11434     LISTENING   (Ollama)
TCP    127.0.0.1:8100    LISTENING   (intel service, python)
TCP    [::]:11434        LISTENING   (Ollama)
TCP    [::1]:4173        LISTENING   (Vite dev server, node)
```

- **The intel service** binds 127.0.0.1 (`scripts\skynet.ps1` passes `--host 127.0.0.1`).
- **The dev server** binds `localhost` unless GEV's LAN sharing is turned on.
- **Ollama does not bind loopback on this machine.** No `OLLAMA_HOST` is set in the process, user or machine environment, so this comes from the Ollama app's own network setting. Ollama's API has no authentication: anyone on the network can use, pull or delete models. SKYNET cannot change another program's setting. `npm run doctor` now detects it and warns:
  `[WARN] Ollama answers on your network address 192.168.1.37:11434, not only on this computer; other machines may reach it unless a firewall blocks them`.

**CORS.** Requests carried `Origin: https://evil.example`. None of these responses carried an `Access-Control-Allow-Origin` header (count of matching header lines, via `curl -D -`):

```text
http://127.0.0.1:8100/api/intel/health        -> 0
http://localhost:4173/api/intel/news          -> 0
http://localhost:4173/api/intel/chat/status   -> 0
OPTIONS (preflight) /api/intel/chat via proxy -> 405
```

**Cross-site writes and DNS rebinding.**

```text
proxy POST /api/intel/chat with a foreign Origin       -> 403
direct POST to the intel service with any Origin        -> 403
intel service with Host: evil.example (rebinding)       -> 400
```

**LAN opt-in.** `SKYNET_CHAT_ALLOW_LAN=1` opens chat to LAN viewers; it is off by default. Since Phase 6 it never opens local voice (`/voice/*` answers 403 `voice_local_only` off this machine): a LAN page over plain http cannot use a microphone, so the flag would only have let other machines feed audio to the decoder. This is covered by `src/tooling/intelProxy.test.mjs`.

## 2. Secrets

- **Scan.** A pattern scan of all 2,395 tracked text files covered AWS, Google, OpenAI, Anthropic, GitHub, Slack and Mapillary key shapes, private-key blocks, JWTs and long literal secrets. It found 3 hits, all deliberately fake test values:
  - `intel/tests/test_chat_api.py` (`sk-test-…`);
  - `src/geminiServer.test.mjs`;
  - `src/voice/geminiSession.test.mjs`.

  gitleaks is not installed here, so this was a regex pass, not gitleaks.
- **`.env` permissions.** These are GEV's own (`server/standalone/key-setup-hardening.mjs`): `icacls` owner-only on Windows, `chmod 600` elsewhere, with its own tests. Not exercised live: this machine has no `.env`.
- **Keys never echoed.** The intel service's keys (Brave, Tavily) stay server-side. A pytest configures fake keys and checks that neither the chat nor the voice status response contains them (`test_status_never_echoes_a_configured_key`).
- **Keys in the browser.** SKYNET adds no browser-side key. The only client-side keys remain GEV's documented three (Google Maps, Cesium ion, Mapillary), which are meant to be restricted at the provider.

## 3. Input validation, rate limits, response caps, errors

- **Validation.**
  - Chat, tool results, stop and speech bodies are Pydantic models with `extra="forbid"` and length limits.
  - News query parameters are validated. Bad input gets 422 (`limit=100000`, `since=notadate`, `bbox=1,2,3`, a 600-character `q`).
  - The proxy accepts only each route's own body type and size.
- **Rate limits.**
  - Chat runs one turn at a time, at most 12 a minute (`SKYNET_CHAT_TURNS_PER_MINUTE`), with tests.
  - Web fetch is not an endpoint; the model reaches it only through a chat turn: at most 4 tool rounds, a per-turn web token budget, and per page 10 s, 1 MB and 3 redirects through the SSRF guard (53 tests).
  - Local voice runs one job at a time per engine and is loopback-only; it has no per-minute limit.
- **Caps.**

  | Item | Limit |
  |---|---|
  | Chat body | 64 KB |
  | Tool result | 32 KB |
  | Map context | 8 KB |
  | Fetched page | 1 MB, then a token budget |
  | Recording | 2 MB and 60 s |
  | Speech text | 1,000 characters |
  | News page | 200 stories |
- **Errors.**
  - Unhandled errors return FastAPI's plain "Internal Server Error".
  - Chat failures reach the browser as codes (`ollama_offline`, `busy`, …).
  - **Note:** `/voice/status` reports a failed model load as the exception's message, which can include a local path. It is loopback-only, and that detail is what the person on this machine needs to fix it.

## 4. Logs

- **Chat tool log.** `.skynet-logs/tools-YYYYMMDD.jsonl` (gitignored). Its fields, from a real 35-line log:
  `args, conversation_id, duration_ms, status, tool, ts, url`.
  - Page and search content is never logged.
  - Arguments are the model's tool arguments: a search query, a place, a layer id.
- **Intel service log.** Since Phase 6, `scripts\skynet.ps1` writes the service's log to `.skynet-logs\intel.err.log`.
- **Audio** is never stored or logged.

## 5. Graceful degradation

Each case has a visible state, verified in its phase and listed with expected results in `docs/VERIFY.md`:
- **Feed down or stale:** news freshness live, stale or offline.
- **Intel service down:** "Intel service offline: run scripts\skynet.ps1".
- **Ollama down:** the panel header and the answer say "Ollama is not running".
- **Search blocked or unconfigured:** the panel's search line.
- **No keys:** keyless boot on NASA Blue Marble.
- **Local voice not set up:** the mic is marked unavailable and says how to install it.

## 6. GPU budget and low-resource mode

- **Measured in Phase 4** (`docs/phase4/neural-core-eval.md`, RTX 5060 8 GB):

  | Model | Loaded size | On the GPU |
  |---|---|---|
  | `qwen3.5-9b-64k-gpu` | 6.68 GB | 5.39 GB (about 19% on the CPU) |
  | `bonsai-2:9b` | 3.36 GB | all of it |
- **Cesium** ran on the Intel iGPU in every measurement here (`ANGLE (Intel, Intel(R) Graphics … Direct3D11)`), so it took no RTX memory. A browser on the RTX would share its 8 GB with the model; that was not measured.
- **Local voice** runs on the CPU and uses no GPU memory.
- **Low-resource mode** (`SKYNET_LOW_RESOURCE=1`) is **partial**.
  - Built: the smaller model (`bonsai-2:9b`), an 8k context, and smaller history, web and page budgets.
  - Not built: a reduced tool subset for the model, and reduced layer density. GEV's own Density control (Display panel) is the manual knob for density.

## Beyond the checklist

These were built in earlier phases and are still in force:
- No shell, file or code tool is exposed to the model.
- Web and news text reaches the model wrapped as untrusted data.
- Questions that ask to locate or profile a person are refused before the model runs (`intel/app/chat/policy.py`).
- Recordings reach only the local service.
