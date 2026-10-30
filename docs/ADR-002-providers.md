# ADR-002: Neural Core multi-provider chat

- **Status:** Accepted 2026-10-29, with the recommended answers to §6: Q1 POWER UP rows that store
  through the intel service; Q2 no `last4`; Q3 Ollama `:cloud` models count as cloud; Q4 add the
  pinned `anthropic`, `openai` and `keyring` packages.
- **Date:** 2026-10-29
- **Scope:** the design for P0–P5 (`NEURAL_CORE_PROVIDERS_PROMPT.md` §7). P1 and P2 are built;
  where they differ from the text below, §8 says how.
- **Branch:** `feat/neural-core-providers` (from `main` @ `2141700a`).
- **Evidence:** `docs/providers/p0-ollama-probe.json` (what this machine's Ollama returns),
  `docs/providers/p0-eval-qwen3.5-9b-64k-gpu_latest.json` (the Neural Core eval baseline).

The brief asks for a provider choice per conversation: Ollama (local, any installed model) or a
developer API with the user's own key (Anthropic Claude, OpenAI ChatGPT, OpenRouter, NVIDIA NIM,
DeepSeek, plus a custom OpenAI-compatible server). Non-goals stay as the brief lists them: no
hosted key proxy, no shared keys, no fine-tuning, no change to God's Eye View's voice providers,
and **no automatic fallback from local to cloud**.

---

## 1. Context: what P0 found

### 1.1 Baseline, measured on this machine (2026-10-29)

| Check | Command (PowerShell, repo root) | Result |
|---|---|---|
| Unit tests | `npm test` | 8,827 tests: 8,814 pass, 2 fail, 11 skipped. The two failures are the known ones in CLAUDE.md: `skyAssets.paintOut` and the KML deadline flake (the full suite ran beside a docs-reading job) |
| Intel tests | `uv run --project intel pytest intel/tests` | 171 passed, 4 skipped |
| Build | `npm run build` | passes |
| Neural Core eval | `uv run --project intel python intel/scripts/neural_core_eval.py --model qwen3.5-9b-64k-gpu:latest` | **15/15** (globe 5/5, news 5/5, web 5/5), refusals **3/3**, median turn 4.4 s, warm-up prompt 3,082 tokens. Model loaded with `num_ctx` 16384, 5.6 GB of VRAM. Output kept at `docs/providers/p0-eval-…json`; the committed Phase 4 record was restored |

P1 must reproduce the eval score with the Ollama adapter, and every later phase compares against
these numbers.

### 1.2 The Neural Core today

| Part | Where | What matters for providers |
|---|---|---|
| Agent loop | `intel/app/chat/agent.py` (479 lines) | Up to `MAX_TOOL_ROUNDS = 4` tool rounds, then a final round with no tools so the model must answer. Person lookups are refused before any model runs. Ollama-specific in four places only: the request payload (`think`, `keep_alive`, `options.num_ctx`), chunk parsing (`message.content`, `message.tool_calls`), the `done` statistics (`eval_count`, `eval_duration`, `prompt_eval_count`) and `ollama_*` error codes. Models without native tools get a constrained-JSON fallback (`FALLBACK_FORMAT`) and `done.degraded = true`. A `ThinkFilter` drops `<think>` spans |
| Ollama client | `intel/app/chat/ollama.py` | `httpx` streaming of `/api/chat` NDJSON, `/api/show`, `/api/ps`, `/api/version` |
| Tools | `intel/app/chat/tools.py`, `shared/tools/neural-core.tools.json` | One schema per tool, already in the OpenAI nested shape `{type: "function", function: {name, description, parameters}}`. **Every call is validated against its JSON Schema (Draft 2020-12) before it runs**, whatever the model. Globe tools come only from the committed artifact, so a browser cannot add tools |
| Policy | `intel/app/chat/policy.py` | Refusal rule, system prompt with map context, `wrap_untrusted()` for news, web and globe results |
| HTTP API | `intel/app/api/chat.py` | `POST /api/intel/chat` streams SSE events `turn`, `token`, `tool_status`, `client_tool`, `citation`, `done`, `error`. One turn at a time, rate-limited per minute. **Stop or browser disconnect calls `aclose()` on the agent generator, which closes the upstream Ollama stream.** State-changing routes refuse any request with an `Origin` header (only the app's own proxy may call them) |
| History | `intel/app/store/chat.py`, migration `0002_chat.sql` | `messages(role user|assistant, content, citations_json, meta_json)`. Only the final user and assistant texts are stored; tool calls and results inside a turn are not, and history replays text only. `tool_log` keeps tool names, arguments, status and timing. Migrations are numbered SQL files with checksums; an applied one is never edited |
| Proxy | `server/providers/intel.js` | Route allowlist. Chat routes are loopback-only unless `SPECTRE_CHAT_ALLOW_LAN=1`; voice routes are always local-only; write routes need a same-origin request |
| Key UI | `server/standalone/key-setup.js`, `src/keySetupCore.mjs`, `src/keySetup.js` | The POWER UP / Provider Settings panel: a dev-server-only middleware that writes the repo `.env` (owner-only) and restarts the dev server. Loopback-only, Host and Origin checked, no forwarding headers. It reports presence and source only: **never a value or a suffix**. `OPENAI_API_KEY` and `GEMINI_API_KEY` are already registered there for God's Eye View's voice |
| Renderer | `src/neuralCore/view.js`, `panel.js` | Answers are built from text nodes and citation links (`answerSegments`); **no `innerHTML` anywhere in `src/neuralCore/`**. Markdown is shown as text, so model output cannot inject markup today |
| Settings | `intel/app/config.py` | `OLLAMA_HOST`, `OLLAMA_MODEL` (default `qwen3.5-9b-64k-gpu:latest`, or `bonsai-2:9b` in low-resource mode), `OLLAMA_NUM_CTX` (16384), `OLLAMA_KEEP_ALIVE`, `OLLAMA_THINK`. Per-turn budgets scale with `num_ctx` |
| Disclaimer | panel footer | "Local model; answers can be wrong…": must become provider-aware |

### 1.3 Ollama on this machine (Ollama 0.40.13, recorded 2026-10-29)

Full output: `docs/providers/p0-ollama-probe.json`.

| Model | Capabilities (`/api/show`) | Context | Notes |
|---|---|---|---|
| `qwen3.5-9b-64k-gpu:latest` | completion, vision, tools, thinking | 262,144 | 9.0B Q4_K_M; the default; eval baseline above |
| `bonsai-2:9b`, `bonsai-2-9b-64k:latest` | completion, vision, tools, thinking | 262,144 | 9.0B Q2_0 (low-resource default) |
| `nemotron-3.5-bolt:e4b` | completion, vision, **audio**, tools, thinking | 65,536 | 7.5B Q4_K_M |
| `d1-omni:600m` | **decision**, vision | 128,000 | **no `completion`**: not a chat model, hide it |
| `beam:cloud`, `gemma4:cloud`, `nemotron-3-super:cloud`, `nemotron-3-ultra:cloud` | completion, thinking, tools (gemma4 also vision) | 262,144–1,048,576 | **`remote_host: https://ollama.com`**: Ollama runs these on its servers |

What this changes against the brief:

- **Capabilities are richer than the docs show.** Values seen: `completion`, `vision`, `audio`,
  `tools`, `thinking`, `decision`. `/api/tags` now carries `capabilities` and
  `details.context_length` for every model, so one call fills the picker; `/api/show` stays the
  fallback for older Ollama versions.
- **An Ollama model is not always local.** A `:cloud` model sends the conversation to ollama.com.
  It gets the `CLOUD · Ollama` badge and the same consent rule as any cloud provider (D6), and
  local-only mode blocks it. Only `/api/tags` says so (`remote_host`); `/api/show` has no such
  field (checked live on 0.40.13 against `beam:cloud`), so a model's kind is read from its tags
  entry.
- `/api/ps` fields: `name`, `model`, `size`, `size_vram`, `context_length` (the requested
  `num_ctx`), `expires_at`, `details`, `digest`, `runner`.

### 1.4 Provider wire facts (doc pass, 2026-10-29)

From the official pages listed in §7, read on 2026-10-29. **UNVERIFIED** marks what no fetched
page stated; those points are settled by the contract fixtures and Murali's live runs.

**Anthropic** (native Messages API, `https://api.anthropic.com/v1/messages`; SDK `anthropic` 2.3.0
of 2026-10-23)
- **Auth:**
  - `Authorization: Bearer` (`x-api-key` is a "legacy fallback… still supported").
  - `anthropic-version` is required; the current one is `2026-10-21`, and `2023-06-01` is still
    listed.
  - **Version `2026-10-21` removes `temperature`, `top_p` and `top_k`**: sending any of them is a
    400.
  - `anthropic-workspace-id` is required for keys not scoped to a workspace.
- **Models:** `GET /v1/models`, paged by `after_id` / `before_id` / `limit` (1–1000), with a
  `lifecycle` filter.
  - Fields: `id`, `display_name`, `max_input_tokens`, `max_tokens`, `lifecycle` and `capabilities`
    (image/pdf input, thinking types, effort and more).
  - **No flag for client tool use.**
- **Tools:**
  - Definition: `{name, description, input_schema}`.
  - Calls come back as `stop_reason: "tool_use"` with `tool_use{id, name, input}`, where `input`
    is an object.
  - Results: a `user` message right after the assistant turn, with **every `tool_result` block
    first in its content** and all parallel results in that one message; anything else is a 400.
  - Some current models reject `tool_choice` `any` and `tool`, so only `auto` is used.
- **Streaming:**
  - Events: `message_start`, `content_block_start/delta/stop`, `message_delta`, `message_stop`,
    `ping`, `error`. New event types may be added.
  - Tool input arrives as `input_json_delta.partial_json`.
  - Usage is cumulative in `message_delta`.
- **Errors:**
  - Body: `{type: "error", error: {type, message}, request_id}`.
  - Codes: 401 `authentication_error`, 402 `billing_error`, 403 `permission_error`, 404, 413,
    429 `rate_limit_error` (`retry-after` when present), 500, 504, 529 `overloaded_error`.
  - **A spend-limit 429 has no `retry-after`** and carries
    `error.details.error_code: "enforced_spend_limit_reached"`.
  - The HTTP error for an input that is too long, and for an unknown model, are **UNVERIFIED**.
- **Thinking:**
  - **Leaving out `thinking` means adaptive thinking**, and Opus 5.5 and Fable/Mythos 5.x
    **reject `{type: "disabled"}`**.
  - With tools, every `thinking` / `redacted_thinking` block must be passed back unmodified, and
    on 5.5 models replayed blocks need append-only history.

**OpenAI** (`https://api.openai.com/v1`; SDK `openai` 3.41.0 of 2026-10-28)
- **Auth:** `Authorization: Bearer`, optional `OpenAI-Organization` / `OpenAI-Project`.
- **Responses API:**
  - Status: "recommended for all new projects"; GPT-6 Astra and GPT-6.1 Sol need it for tool
    calling.
  - Tools: flat `{type: "function", name, description, parameters, strict}`, and **leaving out
    `strict` turns strict mode on**. Strict mode needs `additionalProperties: false` and every
    property required; our schemas have optional properties.
  - Calls: `function_call{call_id, name, arguments: JSON string}`. Results: input items
    `function_call_output{call_id, output}`.
  - **Reasoning items returned with tool calls must be passed back**; with `store: false` they
    carry `encrypted_content`.
- **Responses streaming:**
  - Function calls: `response.output_item.added` (carries `call_id`), then
    `response.function_call_arguments.delta` / `.done` (keyed by **`item_id`**, not `call_id`),
    then `response.output_item.done`.
  - Text: `response.output_text.delta`.
  - Endings: `response.completed` (usage `input_tokens`, `output_tokens`, cached and reasoning
    detail), `response.failed`, `response.incomplete`, and a top-level `error` event.
- **Models:** `GET /v1/models` returns `id`, `created`, `owned_by`, `shutdown_date` only: **no
  capability, context or price data**.
- **Errors:**
  - Codes: 401, 403 (region), 429 (rate limit, **`insufficient_quota`** or spend limit), 500,
    503. Honour `Retry-After`.
  - The error body schema, `context_length_exceeded` and `model_not_found` are **UNVERIFIED**.
- **Reasoning effort:**
  - Values run from `none` to `max`, depending on the model. The default is `medium` on current
    models, and some reject `none` or `minimal`.
  - **From GPT-5.4, Chat Completions supports tool calling only with `reasoning_effort: none`.**

**OpenRouter** (OpenAI-compatible Chat Completions, `https://openrouter.ai/api/v1`)
- **Models:** `GET /api/v1/models` works without auth, paged by `offset` / `limit`.
  - Fields: `context_length`, `architecture.input_modalities`, `supported_parameters` (contains
    `tools`), `top_provider.max_completion_tokens` and `reasoning{mandatory, default_enabled}`.
  - `pricing.prompt` / `completion` are **"Price in USD per token"**, as strings.
- **Tools:** OpenAI Chat shape, `finish_reason: "tool_calls"`, results as `role: "tool"` with
  `tool_call_id`. `tools` must be sent on every request.
- **Streaming:**
  - **Usage is always in the last SSE chunk**; `stream_options.include_usage` and
    `usage.include` are deprecated no-ops. `cost` is in credits.
  - Skip `: OPENROUTER PROCESSING` comment lines.
  - After headers, an error arrives as a chunk with `error{code, message}` and
    `finish_reason: "error"`. Closing the connection cancels the request and its billing where
    the model's provider supports it.
- **Errors:**
  - Body: `{error: {code, message, metadata?}}`, with the status equal to `error.code`.
  - Codes: 400 (incl. `context_length_exceeded`), 401, **402 credits** (`limit_source`), 403
    moderation, 408, 429, 502, 503. `Retry-After` on 429/503.
- **Attribution headers (optional):** `HTTP-Referer`, `X-OpenRouter-Title` (`X-Title` accepted).
- **Reasoning:**
  - Request: `reasoning{effort | max_tokens, enabled, exclude}`.
  - Output: `message.reasoning` / `reasoning_details[]`, which must be passed back in order with
    tools.

**DeepSeek** (OpenAI-compatible, `https://api.deepseek.com`)
- **Models:** `GET /models` returns `context_window`, `max_output_tokens`, `input_modalities` and
  `effort{supported_levels, default_level}`. **No tools flag.**
  - Today: `deepseek-flash` and `deepseek-v4-pro` (1,048,576 context); legacy names still accepted.
  - Never hard-code these.
- **Tools:**
  - OpenAI Chat shape. Streamed tool deltas carry `index`, with `id` and `name` in the first
    chunk only.
  - `finish_reason` adds `insufficient_system_resource`.
  - In thinking mode, a forced `tool_choice` is a 400.
- **Thinking:**
  - **On by default (effort `high`)**; `thinking: {type: "disabled"}` turns it off.
  - **With tools, `reasoning_content` must be passed back in all later requests, including turns
    without a tool call, or the API returns 400.**
  - `temperature` and the penalties have no effect while thinking.
- **Usage:** on the last chunk.
- **Errors:**
  - Codes: 400, 401, 402 balance, 422, 429, 500, 503.
  - `Retry-After`, context-length and model-not-found errors are **UNVERIFIED**.

**NVIDIA NIM** (hosted, `https://integrate.api.nvidia.com/v1/chat/completions`)
- **Auth:** `Authorization: Bearer $NVIDIA_API_KEY` (env var confirmed). Keys "typically" start
  with `nvapi-` (one docs.nvidia.com page).
- **Models:** `GET /v1/models` answered an unauthenticated request with 84 models and
  `{id, object, created, owned_by}` only. That is observed behaviour, not documented.
- **Tool support varies per model:**
  - `llama-3.3-70b-instruct` and `kimi-k2-6` declare `tools`.
  - `deepseek-v4-pro` on NIM declares no `tools`.
- **Responses:** can be **202 "pending"** with an `NVCF-REQID` for polling.
- **Errors:**
  - Documented: 422 and 500, with a body `{type, title, status, detail, instance, requestId}`.
  - 401 and 429 are **UNVERIFIED**.

**Ollama** (native `/api/chat`)
- **Tools:** calls come back as `tool_calls[{function{name, arguments: object, index?}}]` with **no
  id**; results go back as `{role: "tool", tool_name, content}`. Whether a call arrives whole in
  one stream chunk is **UNVERIFIED**, so chunks are accumulated.
- **Errors:**
  - Body: `{error}`. Codes: 400, 404 (model missing), 429, 500, **502 (cloud model
    unreachable)**.
  - A mid-stream error is an NDJSON `{error}` object.
- **`num_ctx` default depends on VRAM** (4k below 24 GiB), so the explicit `num_ctx` we send
  matters.
- **`think`:** accepts a level string listed by `/api/show` `thinking.values`.
- **Capability values:** the docs show `completion`, `thinking`, `vision`; **this machine's
  0.40.13 also returns `tools`, `audio` and `decision`** (§1.3).

**Corrections to the brief's §1 facts:**
- The OpenAI Responses event list was right but incomplete: `response.incomplete` and a
  top-level `error`; argument events use `item_id`.
- OpenRouter usage needs no opt-in.
- DeepSeek's passback rule applies to **every** later request once tools are present.
- The `nvapi-` key prefix is "typically", not guaranteed.
- Ollama's `tools` capability is confirmed live, not by the docs.

---

## 2. Decisions

### D1. Provider layer

- **Where:** `intel/app/chat/providers/` (the real layout; the brief's `src/panels/neuralCore/`
  is `src/neuralCore/` here).
- **Interface** (`base.py`, a `Protocol`): `id`, `kind` (`local` | `remote` | `cloud`),
  `list_models()`, `test()`, `model_caps(model)`, `stream(request) -> AsyncIterator[StreamEvent]`.
  `kind` is decided per request, not per provider: Ollama is `local` on loopback, `remote` on a
  LAN host, and `cloud` for a model with a `remote_host`.
- **Adapters:**
  - `OllamaProvider`: the current `ollama.py` + agent wire code moved behind the interface,
    native `/api/chat`, `httpx` (no new dependency).
  - `OpenAICompatProvider`: Chat Completions over the `openai` SDK with `base_url`; used for
    OpenRouter, NVIDIA NIM, DeepSeek and a "Custom OpenAI-compatible" entry (LM Studio, vLLM).
    Per-provider quirks are small hooks (DeepSeek reasoning passback, OpenRouter usage and
    headers), not subclasses of subclasses.
  - `AnthropicProvider`: the native Messages API through the `anthropic` SDK.
  - `OpenAIProvider`: the Responses API through the `openai` SDK, with Chat Completions as a
    per-model fallback (D3).
- **SDKs:** the official `anthropic` and `openai` Python packages, pinned to exact versions in
  `intel/pyproject.toml` and `uv.lock` (today `anthropic==2.3.0` and `openai==3.41.0`; re-checked
  at P3). They track auth headers, version headers and the
  Responses requirements; SDK types never leave the adapter. Both accept an `httpx` client, which
  is how the contract tests inject fake servers (§3).
- **Registry:** `intel/app/chat/providers.default.yaml` declares id, label, kind, base URL, key
  env names and docs links. User overrides (base URL, Anthropic Workspace ID, parameters) live in
  the database (D4). No model IDs are hard-coded for any cloud provider.

### D2. Canonical types and `provider_state`

```text
Message   {role: system|user|assistant|tool, content, tool_calls: [ToolCall],
           tool_call_id, provider_id, model, provider_state}
ToolCall  {id, name, args: dict}
Event     text_delta{text} | thinking_delta{text} | tool_call{id, name, args}
          | usage{input, output} | done{stop_reason} | error{code, message, retryable}
```

- `tool_call` events are emitted **complete**: adapters accumulate streamed fragments (Ollama
  chunks, OpenAI `arguments` deltas, Anthropic `input_json_delta.partial_json`) and parse once.
- `args` is always a dict: an object, a JSON string or streamed partial JSON is normalised by the
  adapter; unparseable input becomes `{"_unparsed": "…"}` and fails schema validation, as today.
- **Ollama has no call ids:** the adapter makes synthetic ids and maps results back by order and
  `tool_name`.
- **`provider_state`** is opaque round-trip data the provider requires back:
  - Anthropic `thinking` / `redacted_thinking` blocks, unmodified, with their signatures.
  - OpenAI reasoning items (`encrypted_content`, since requests use `store: false`).
  - OpenRouter `reasoning_details`, in order.
  - DeepSeek `reasoning_content`.

  It is persisted per assistant message, replayed **only to the same provider**, and stripped when
  the conversation switches provider (a test covers both).

### D3. The agent loop becomes provider-agnostic

The loop, its limits and its safety rules stay where they are and keep their behaviour:
4 tool rounds then a forced answer, the person-lookup refusal before any model call, schema
validation before every tool call, `<untrusted_web_content>` wrapping, the web budget and the
SSRF guard. What moves out of `agent.py` into adapters is the wire format: payload building,
chunk parsing, tool-call extraction and statistics.

- **The forced final answer keeps its behaviour, with a mechanism per adapter.** The loop's last
  round must produce an answer, not another call. Some APIs reject tool history without tools
  (OpenRouter documents that `tools` must be sent on every request), so:
  - Ollama keeps today's request without `tools`.
  - Chat Completions and Responses providers send the same tools with `tool_choice: "none"`.
  - Anthropic does the same (`tool_choice: {type: "none"}`). **UNVERIFIED:** whether it would
    accept `tool_use` / `tool_result` history without `tools` was not confirmed; P3 settles it
    with a fixture and a live check.

  A quirk test asserts the final request of a 4-round turn per adapter.
- **Parallel tool calls:** run every call of a round, then return all results in one
  provider-correct step. For Anthropic that is one `user` message holding every `tool_result`;
  for OpenAI-style APIs one `tool` message per call id after the assistant's tool-call message.
- **Where `supports_tools` comes from:**
  - Ollama: the `tools` capability.
  - OpenRouter: `tools` in `supported_parameters`.
  - Anthropic, OpenAI, DeepSeek, NIM and custom servers publish no flag. Their models start as
    `unknown`, and a **one-time probe** runs on first selection, after consent: one tiny prompt
    with a dummy tool. The result is cached in `model_caps` per provider + model + base URL;
    "Test tool calling" re-runs it.
- **No native tools** (`no`, or `unknown` before the probe): run the existing JSON fallback where
  the provider supports a JSON response format, otherwise answer without tools. Either way the
  panel shows a degraded-mode badge (`done.degraded`, already in the contract).
- **Anthropic:**
  - `tool_choice` stays `auto`.
  - Every `tool_result` block goes first in the one `user` message after the tool calls.
  - No `temperature`, `top_p` or `top_k` (rejected from API version `2026-10-21`).
- **OpenAI:**
  - Responses API first. Tool definitions send **`strict: false`**, because leaving it out turns
    strict mode on and our schemas have optional properties.
  - Requests use `store: false`.
  - A model the Responses API rejects is remembered and retried on Chat Completions; the choice
    is cached in `model_caps`. On Chat Completions, tools are sent only with
    `reasoning_effort: none` (GPT-5.4 and later); a model that rejects `none` runs that path
    without tools, in degraded mode.
- **Reasoning, off wherever the provider allows:**
  - DeepSeek: `thinking: {type: "disabled"}`.
  - OpenRouter: no `reasoning` unless the model marks it mandatory.
  - OpenAI: the lowest effort the model accepts, learned from its 400 and cached.
  - Ollama: `OLLAMA_THINK` (default off).
- **Where reasoning stays on, its passback is implemented** (each with a quirk test that fails on
  omission):
  - Anthropic, where leaving `thinking` out means adaptive thinking and some models reject
    `disabled`: thinking blocks are passed back unmodified within the tool loop.
  - OpenAI: reasoning items.
  - OpenRouter: `reasoning_details`.
  - DeepSeek, when the user turns reasoning on: `reasoning_content` in every later request.

  Thinking text is shown only as the collapsed `thinking` event, and only when enabled.

### D4. Persistence (migration `0003_providers.sql`)

New numbered migration; `0001` and `0002` are untouched and existing conversations keep working.

- `conversations`: add `provider_id`, `model` (the conversation's current choice; null means the
  default Ollama model, so old rows behave as today).
- `messages`: add `provider_id`, `model`, `provider_state_json` (all nullable).
- New tables:
  - `provider_settings(provider_id PK, base_url, workspace_id, params_json, updated_at)`: no keys.
  - `model_caps(provider_id, base_url, model, supports_tools yes|no|unknown, caps_json, probed_at)`,
    keyed by provider + model + base URL.
  - `consents(provider_id PK, granted_at, revoked_at)`.
  - `usage(id, ts, conversation_id, provider_id, model, input_tokens, output_tokens)`.
  - `chat_settings(key PK, value_json, updated_at)`: the switches that are not per provider
    (local-only mode, map context in cloud requests). Added in P2.
- The CHECK on `messages.role` stays `user|assistant`: tool calls inside a turn are still not
  stored, so `provider_state` is the only per-turn data that survives, and only where a provider
  needs it.

### D5. Keys

- **Server side only.** Keys live in the intel service and never reach the browser, SSE, logs,
  history, error bodies or URLs.
- **Precedence (reading):**
  1. The process environment at boot (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
     `OPENROUTER_API_KEY`, `NVIDIA_API_KEY`, `DEEPSEEK_API_KEY`): read-only, shown as "configured
     externally".
  2. The OS keyring (Windows Credential Manager through the `keyring` package, a new
     dependency). **This is where SPECTRE writes.**
  3. The repo's owner-only `.env`. It is always read, but **written only when no keyring backend
     is available**.
- **`OPENAI_API_KEY` is shared** with God's Eye View's voice: a value the POWER UP panel already
  saved to `.env` is found at step 3 and used for ChatGPT, not asked for twice.
- **API** (intel service, behind new proxy routes marked local-only and write; as built in P2):
  - `GET /api/intel/providers` → per provider `{id, label, kind, docs, base_url,
    base_url_editable, workspace_id, key: {required, configured, source, env, writable},
    consent}`, plus `policy` and whether a keyring exists. No `last4` (Q2).
  - `GET …/session` → the session token; `GET …/{id}/models`.
  - Writes, each with the token: `PUT …/{id}/key` `{key}` (write-only), `DELETE …/{id}/key`,
    `PUT …/{id}/settings` `{base_url, workspace_id}`, `PUT …/{id}/consent` `{granted}`,
    `PUT …/policy` `{local_only, map_context}`, `POST …/{id}/test`.
- **Who may change keys:** the proxy runs the **same gate POWER UP uses**,
  `admitKeySetupRequest()` in `src/keySetupCore.mjs` (already unit-tested), before forwarding.
  - **Refused:** any request with forwarding headers, anything while a sharing tunnel is on, a
    socket that isn't loopback or a Host header that isn't local, and a POST without an exact
    same-origin header or without JSON.
  - **Also required:** a per-session token that the intel service issues to the loopback panel.
  - **LAN viewers** let in by `SPECTRE_CHAT_ALLOW_LAN=1` can chat, but never read key status or
    change keys, providers or base URLs.
- **Redaction:** one redactor for logs, tracebacks, error messages and request logging, matching
  `sk-…`, `sk-ant-…`, `nvapi-…`, `Bearer …` and long key-like tokens.
- **Base-URL overrides:** `https` required for cloud endpoints; `http` allowed only on loopback;
  the UI warns that the base URL receives the key.
- **The model never gets a tool** that reads or changes keys, settings or the provider.
- **Where keys are typed:** see question Q1 in §6. Recommended: new rows in the existing POWER UP
  panel (one key UI, as the brief asks) that call the intel endpoints above instead of writing
  `.env`.

### D6. Privacy and egress

- **Badge on every provider and model, as text:** `LOCAL`, `REMOTE` (Ollama on a non-loopback
  host) or `CLOUD · <provider>`, including `CLOUD · Ollama` for `:cloud` models.
- **Consent on first use of any non-local choice.** The dialog lists what is sent: conversation
  text, tool results (news snippets, fetched web text) and map context (viewport, active layers).
  Stored per provider, revocable.
- **Local-only mode** setting hard-blocks every cloud choice, including Ollama `:cloud` models.
- **No silent fallback.** A failing provider shows its error with an explicit "Retry with …"
  action.
- **Switching provider mid-conversation** says "this history will be sent to X" and needs
  confirmation when X is cloud.
- **Map context in cloud requests:** a setting, on by default and disclosed in the consent dialog.
- **No identifying extras by default:** OpenRouter's optional attribution headers (`HTTP-Referer`,
  `X-OpenRouter-Title`) are not sent.
- **Rendering stays text-only** (§1.2); a test feeds model output containing `<script>` and
  `<img onerror>` and checks it renders as text.
- **The footer disclaimer** names the provider: "Local model…" only for local models.

### D7. SSE contract (backward compatible)

Every existing event and field stays. Additions:

- `turn` gains `provider`, `model`.
- `done` gains `provider`, `usage {input, output}` and `stop_reason`. `eval_count`,
  `prompt_eval_count` and `tokens_per_s` stay, filled from provider usage where possible.
- `error` gains `retryable` and `provider`; `code` uses the taxonomy in D8. The existing
  `ollama_offline`, `ollama_model_missing` and similar codes keep their meaning.
- New `thinking` event (collapsed in the panel), sent only when the provider returns reasoning
  and reasoning is enabled.
- New `budget` event when the per-session soft budget is reached (D10).

`/api/intel/chat/status` gains the selected provider, model, `kind`, `supports_tools` and a
provider-neutral `ready` / `problem` pair. Every existing field stays.

The boot overlay's NEURAL CORE row (`classifyChatStatus` in `src/boot/probes.js`) must read the new
pair. Today it marks the row OFFLINE whenever `ollama.reachable` is false, which would be wrong when
a configured cloud provider is selected and Ollama is stopped. For Ollama, it reads the same as
today.

### D8. Errors, retries and abort

- **Taxonomy:** `auth_failed`, `rate_limited`, `quota_exceeded`, `model_not_found`,
  `context_too_long`, `unsupported_feature`, `provider_unavailable`, `network`.
- **Mapping, from the documented codes (§1.4):**
  - `auth_failed` (never retried): 401 everywhere; Anthropic 403 `permission_error`.
  - `quota_exceeded` (never retried): Anthropic 402, and Anthropic's 429 with
    `enforced_spend_limit_reached`; OpenAI 429 `insufficient_quota`; OpenRouter 402; DeepSeek 402.
  - `rate_limited` (retried): every other 429.
  - `provider_unavailable` (retried):
    - 500, 502, 503, 504 and Anthropic 529;
    - DeepSeek `insufficient_system_resource`;
    - Ollama 502 (a cloud model unreachable).
  - `context_too_long`: OpenRouter 400 `context_length_exceeded`. The other providers' codes are
    UNVERIFIED and are mapped from their error text once fixtures or live runs show it.
  - `model_not_found`: 404.
  - `unsupported_feature`:
    - OpenRouter 403 (moderation);
    - a NIM 202 "pending" reply (no polling in v1);
    - a 400 naming a parameter or tool feature.
- **Retries:** only `rate_limited`, `provider_unavailable` and network errors, with jittered
  backoff honouring `Retry-After` (the SDKs' own retries off, so one policy applies). **Never 401
  or 403.**
- **Abort:** Stop and browser disconnect already close the agent generator; each adapter closes
  its SDK stream in `finally`, and a contract test checks that the fake server sees the
  connection drop.

### D9. Context budget

- **Where the window comes from:** model metadata (Anthropic `max_input_tokens`, OpenRouter
  `context_length`, DeepSeek `context_window`, Ollama `context_length` with the requested
  `num_ctx`; 8192 when unknown).
- **Ollama:** budgets scale with `num_ctx` as today.
- **Cloud providers:** **today's budgets (the 16k-context set) are a fixed ceiling**. A model's
  window only ever lowers them; a 1M-token window does not raise them, because every token is
  billed. The user can raise the ceiling explicitly in Settings → Neural Core, next to the cost
  guards (D10).
- **When over budget:** the oldest tool results are trimmed first, then the oldest history.
- **The estimate:** 4 characters per token, corrected with the provider's reported usage.

### D10. Usage and cost

- **Tokens come from provider usage fields** (§1.4), each checked in that adapter's contract test:
  - Anthropic: cumulative in `message_delta`.
  - OpenAI: `response.completed`.
  - OpenRouter: always in the last chunk, no opt-in.
  - DeepSeek: on the last chunk.
  - NIM: `stream_options.include_usage` where the model declares it, otherwise tokens unknown.
  - Ollama: the final `done` chunk.
- **Prices:**
  - OpenRouter: from its model list. `pricing.prompt` / `completion` are documented as USD per
    token (shown ×1,000,000 as USD per 1M); its own `cost` field is in credits and is not shown.
  - Everything else: an optional price per 1M tokens that the user types.
  - No built-in price tables; with no price known, tokens only.
- **Guards:**
  - per-turn `max_output_tokens`;
  - the 4-round cap;
  - the fixed per-turn input ceiling for cloud providers (D9);
  - a per-session soft budget (suggested 100k tokens, configurable) that pauses with a "continue"
    confirmation.

### D11. UI plan

- **Chat header:** a provider + model chip with its badge, Ollama's loaded state (`/api/ps`),
  tokens per second, session tokens, and a keyboard-accessible quick-switch combobox.
- **Settings → Neural Core** (a view inside the Neural Core panel):
  - Provider list with status (Not configured / Connected / Error / Local), Test connection,
    advanced base URL, Anthropic Workspace ID.
  - Searchable model picker with capability chips (`TOOLS`, `VISION`, `REASONING`, context size,
    price or `?`), favourites, and a **Test tool calling** button for `unknown` models.
  - Parameters, shown per provider: temperature (not for Anthropic, which rejects it from API
    version `2026-10-21`; no effect on DeepSeek while thinking), max output tokens, reasoning
    on/off, Ollama `num_ctx` and `keep_alive`.
- **Ollama extras:**
  - Installed models with size, quantisation and capabilities; models without `completion`
    hidden; `:cloud` models badged `CLOUD · Ollama`.
  - A VRAM-fit hint labelled **estimate** (8 GB default, `nvidia-smi` when present, editable).
    On this machine `nvidia-smi --query-gpu=name,memory.total,memory.used --format=csv` reports
    the RTX 5060 Laptop GPU with 8,151 MiB; with the default model loaded, 6,477 MiB were in use.
  - Pull model (stretch).
- **States:** empty, loading, error, offline, rate-limited, budget-reached.
- **Built on what exists:** the existing theme tokens (`--sp-red-on-raised` for red text on
  raised surfaces), keyboard operation and `t()` strings with es/ru/zh-CN.
- **Honest model lists:** a short fallback suggestion list marked `verify` only; the user picks a
  model before first use of a cloud provider.

### D12. Model defaults

The brief says "no hard-coded default model IDs", and P1 says "no behaviour change". Decision:
**cloud providers have no default model** (the user must pick one). **Ollama keeps today's
default** (`OLLAMA_MODEL`, else `qwen3.5-9b-64k-gpu:latest`) so P1 changes nothing; once P4 adds
the picker, a default that is not installed sends the user to the picker instead of failing.

---

## 3. Test plan

- **Contract tests, one suite run against every adapter** (the conftest network guard already
  blocks non-loopback traffic):
  - **Existing pattern:** the current agent tests already fake Ollama this way (`FakeOllama` in
    `intel/tests/test_chat_agent.py`). Those 41 Neural Core tests (agent 13, API 8, policy 7, web
    guard 13) must stay green through P1.
  - **Fake servers:** `httpx.MockTransport` handlers that speak each provider's wire format,
    streaming events included, with fixtures derived from the docs (§1.4) and keys scrubbed. The
    SDK adapters get them through the `http_client` parameter.
  - **Scenarios, per provider:** list models; a plain streamed answer; a tool round trip with
    parallel calls; mid-stream abort (the fake sees the drop); 401 → `auth_failed`, not retried,
    key absent from logs; 429 with `Retry-After`; context too long; an unknown stream event
    ignored.
- **Quirk tests:**
  - DeepSeek: the tool loop with `reasoning_content` passback, failing on omission.
  - Anthropic: all `tool_result` blocks batched in one user message.
  - Ollama: synthetic call ids.
  - A provider switch strips `provider_state`.
  - A model without tools runs in degraded mode.
- **Security tests:**
  - A canary key `sk-test-CANARY…` must not appear in API responses, logs, SSE, error bodies,
    the history database or browser storage; the test greps the captured artefacts.
  - Key routes reject non-loopback, cross-origin and missing-token requests.
  - Model output cannot inject markup.
- **Browser smoke test** `scripts/qa-neural-core-providers.mjs` (mocked endpoints).
  **Deviation:** the brief says Playwright; this uses Puppeteer, like every existing QA script in
  `scripts/`. It covers: configure a provider against a fake, search and pick a model, the
  consent flow, local-only blocking cloud, no silent fallback, 390 px layout.
- **Regression:** `npm test`, intel `pytest`, `npm run build`, `qa:neural-core`,
  `qa:spectre-boot` and the 15-prompt eval after each phase, against §1.1.
- **Live checks:**
  - `intel/scripts/verify_provider.py <id>` (the repo keeps scripts in `intel/scripts/`, not
    `intel.tools`) lists models, sends one short prompt and one tool call, and prints PASS/FAIL.
    It spends a few tokens.
  - `docs/VERIFY_PROVIDERS.md` gives the exact steps.
  - I can run the Ollama live check myself; every cloud provider needs a live run by Murali with
    a key.
- **The final report separates** what was verified against fake servers, what was verified live
  (Ollama only, unless keys are supplied) and what still needs Murali's live run. No cloud
  provider will be called working from mock tests alone.

## 4. Risks

| Risk | Mitigation |
|---|---|
| SDK or API drift (headers, event names, the Responses requirement) | Pinned SDK versions, adapter-local types, contract fixtures dated from the docs, `verify_provider.py` for live runs |
| A cloud key leaks into logs, history or the browser | Single redactor, keys only in the intel service, canary tests over every artefact |
| Silent egress: a user picks a cloud or `:cloud` model without realising | Text badges, per-provider consent, local-only mode, confirmation on switch, no fallback |
| Tool-calling differences break the globe tools on some models | Schema validation stays before execution; `supports_tools` with a probe; degraded mode instead of failure |
| Refactoring the loop changes Ollama behaviour | P1 is a no-behaviour-change refactor gated on the 15/15 eval and the existing tests |
| Dependency weight (`anthropic`, `openai`, `keyring`) | Pinned; no new browser dependencies; the intel service already ships `httpx` and `pydantic` |
| Costs run away | Per-turn output cap, 4-round cap, session soft budget with a confirmation |
| Reasoning passback across turns (Anthropic thinking blocks with append-only history on 5.5 models, OpenAI reasoning items, DeepSeek `reasoning_content` with reasoning on): our history replays earlier turns as final text only and drops their tool-call messages | Passback is complete within a turn's tool loop. Whether earlier turns may be replayed as text is UNVERIFIED per provider and settled by fixtures and Murali's live runs. If a provider needs each turn's full transcript, that is a **new migration** (`0004`, since `0003` lands in P2), not an edit |
| Error shapes some providers do not document (input too long, unknown model, NIM 401/429) | The mapping falls back on HTTP status; fixtures and live runs fill in the rest |
| NIM models that answer asynchronously (202) | Shown as `unsupported_feature` in v1, not polled |

## 5. Phase plan with acceptance

| Phase | Delivers | Accepted when |
|---|---|---|
| P1 Provider core | Interface, canonical types, registry and YAML, error taxonomy, retry and abort, mock provider, shared contract suite; Ollama moved into an adapter | All existing tests pass; the eval is 15/15 with refusals 3/3; the contract suite passes for the mock and Ollama |
| P2 Secrets and settings API | Key store with precedence, endpoints, redaction, loopback and token rules, consent store, local-only mode, test connection, migration `0003` | Canary and route-rejection tests pass; old conversations load |
| P3 Cloud adapters | OpenAI-compatible (OpenRouter, NIM, DeepSeek, custom), Anthropic native, OpenAI Responses with the Chat Completions fallback, live model listing, capability normalisation | Contract and quirk suites pass for every adapter against its fake server |
| P4 UI | Header switcher, Settings → Neural Core, picker, badges, consent, usage, states, accessibility, Ollama extras | The new QA script passes in full; `qa:neural-core` and `qa:spectre-boot` still pass |
| P5 Verify and docs | `verify_provider.py`, `docs/VERIFY_PROVIDERS.md`, `docs/KEYS_AND_COSTS.md` (including the "don't put `ANTHROPIC_API_KEY` in your global environment, Claude Code would bill it" warning), README section, `.env.example` placeholders, this ADR updated | The Ollama live round trip passes; the report separates fake, live and owner-to-run |

Each phase: run the tests, commit, give a 5-line status, and stop on any red test.

## 6. Decisions needed from Murali

1. **Q1 Where keys are typed.**
   - **Recommended:** new rows in the existing POWER UP / Provider Settings panel that store
     through the intel service (keyring), as the brief asks for one key UI.
   - **Tradeoffs:**
     - POWER UP exists only on the dev server, which is how `spectre.ps1` and `run.bat` run the
       app; `vite preview` and builds have no key UI at all.
     - POWER UP's own save restarts the dev server; the new intel-backed rows must not.
   - **Alternative:** key fields inside Settings → Neural Core (available in every mode), with
     POWER UP only linking there.
2. **Q2 `last4`.** The brief's `GET` returns the last four characters; POWER UP's existing rule is
   "never a value or suffix". Recommended: follow POWER UP and show none, for one consistent
   rule. Alternative: show `…abcd` for keys stored by SPECTRE (never for env-var keys).
3. **Q3 Ollama `:cloud` models** are treated as cloud (badge, consent, blocked by local-only),
   as D6 says. Confirm, or say if you want them shown as Ollama-local.
4. **Q4 Dependencies.** Add the pinned `anthropic`, `openai` and `keyring` packages to the intel
   service (D1, D5). Confirm.

## 7. Doc pages consulted

All read on **2026-10-29**. Paths are relative to the site named on each line; pages marked
`[curl]` were downloaded whole because the reader truncated them.

- **Anthropic** (`platform.claude.com/docs/en`):
  - `/api/overview`, `/api/models/list`, `/api/versioning`, `/api/errors`, `/api/rate-limits`
  - `/agents-and-tools/tool-use/overview`, `/agents-and-tools/tool-use/handle-tool-calls`,
    `/agents-and-tools/tool-use/parallel-tool-use.md` [curl]
  - `/build-with-claude/streaming`, `/build-with-claude/handling-stop-reasons.md` [curl]
  - `pypi.org/project/anthropic/`
- **OpenAI** (`developers.openai.com/api`):
  - `/docs/guides/function-calling`, `/docs/guides/migrate-to-responses`,
    `/docs/guides/reasoning`, `/docs/guides/error-codes`
  - `/reference/overview`, `/reference/resources/models/methods/list`,
    `/reference/resources/responses/streaming-events` [curl]
  - `pypi.org/project/openai/`
  - Failed: `/reference/responses-streaming` (404; the events page above replaces it).
- **OpenRouter** (`openrouter.ai/docs`):
  - `/guides/features/tool-calling`, `/api/api-reference/models/get-models`
  - `/cookbook/administration/usage-accounting`
  - `/api_reference/streaming`, `/api_reference/overview`,
    `/api_reference/errors-and-debugging`, `/api_reference/limits`
  - `/guides/best-practices/reasoning-tokens`
  - Failed: `/features/tool-calling` (404; it moved to the guides path above).
- **DeepSeek** (`api-docs.deepseek.com`):
  - `/`, `/guides/thinking_mode`, `/guides/tool_calls`
  - `/api/list-models`, `/api/create-chat-completion`, `/quick_start/error_codes`
- **NVIDIA** (`docs.api.nvidia.com/nim`):
  - `/reference/llm-apis`, `/reference/deepseek-ai-deepseek-v4-pro-infer`,
    `/reference/meta-llama-3_3-70b-instruct-infer`, `/reference/moonshotai-kimi-k2-6-infer`,
    `/docs/api-quickstart`
  - `docs.nvidia.com/nemo/retriever/26.5.0/extraction/api-keys/`
  - A live unauthenticated `GET https://integrate.api.nvidia.com/v1/models` (observed
    behaviour, not documentation).
- **Ollama:**
  - `docs.ollama.com/capabilities/tool-calling`, `/api/errors`, `/api/ps`, `/openapi.yaml` [curl],
    `/llms-full.txt` [curl]
  - `github.com/ollama/ollama/blob/main/docs/api.md` (it notes the docs are moving to
    `docs.ollama.com/api`)
  - Failed: `docs.ollama.com/api/show` (404) and `/api-reference/show-model-details` (connection
    reset); the `/api/show` facts come from `openapi.yaml` and this machine (§1.3).
- **Ollama on this machine:** `ollama list`, `/api/version`, `/api/tags`, `/api/show` per model and
  `/api/ps`, recorded in `docs/providers/p0-ollama-probe.json`.

## 8. As built: where P1 and P2 differ from the text above

- **`:cloud` detection (P1 fix).** `model_caps` read only `/api/show`, which has no `remote_host`,
  so `:cloud` models came back `local`. It now merges `remote_host` from the model's `/api/tags`
  entry (§1.3).
- **`chat_settings` table** in `0003` for local-only mode and map context (D4).
- **Factories take a key getter**, not a key: a key saved later is used on the next request, and
  no adapter holds a key it could print.
- **Local-only mode** blocks a cloud model at turn start, and also a cloud provider's connection
  test and model list: no request reaches a cloud API while it is on. A cloud provider is refused
  on its own kind before any call (a capability lookup would carry the key), and the status route
  skips its lookup; Ollama `:cloud` models are refused on the model's kind.
- **Provider reads through the proxy** also refuse a `Sec-Fetch-Site` other than `same-origin`
  or `none`: an `<img>` on another page (even another localhost port) sends no Origin, and a
  model list makes the service call out with the stored key.
- **Consent** is enforced at turn start for every cloud provider except Ollama's `:cloud` models,
  which wait for the P4 consent dialog; enforcing it now would lock out a `:cloud` user with no
  way to consent. Until P4 they are blocked only by local-only mode.
- **Ollama's address** stays `OLLAMA_HOST`; the settings route refuses a base URL for Ollama.
- **Base URLs** must be `https`, or `http` on this machine, for every provider. A keyless
  OpenAI-compatible server elsewhere on the LAN over `http` is revisited with the custom entry in
  P3.
- **Validation errors** (422) no longer echo the rejected input, which on `PUT …/key` would be the
  key.
- **The proxy gate** treats every provider write as a POST, so each needs an exact local Origin.
  `DELETE …/key` has no body, so only its JSON check is skipped; that check exists to force a CORS
  preflight, which a DELETE always triggers.
- **Tests** run against an in-memory keyring with the provider key variables removed from the
  environment (`intel/tests/conftest.py`).
