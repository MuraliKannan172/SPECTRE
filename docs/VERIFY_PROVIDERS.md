# Verifying the Neural Core chat providers

Each provider adapter is tested against a fake server that speaks its wire format. A fake only
shows that the adapter matches the documentation as read on 2026-10-29, not that the real API
still behaves that way. **A cloud provider counts as working only after a live run with a real
key**, and none has had one yet. This page gives the exact steps for that run and records what
has been verified so far.

Keys and prices: [KEYS_AND_COSTS.md](KEYS_AND_COSTS.md). Design: [ADR-002](ADR-002-providers.md).

## Where things stand (2026-10-30)

### (a) Verified against fake servers and mocks

| What | Where |
|---|---|
| The shared contract, run against every adapter (mock, Ollama, OpenAI-compatible, Anthropic, OpenAI Responses): list models; a plain streamed answer; a parallel tool round trip; abort closing the upstream; 401 as `auth_failed`, not retried, key in no log or error; 429 honouring `Retry-After`; context too long; unknown stream events ignored | `intel/tests/test_provider_contract.py` |
| DeepSeek `reasoning_content` passback on every later request and not after a switch; OpenRouter `reasoning_details`; degraded JSON mode only where declared | `intel/tests/test_openai_chat.py` |
| Anthropic: every `tool_result` in one user message, thinking blocks back to Anthropic only, workspace ID, spend-limit 429 not retried, model list pages | `intel/tests/test_anthropic.py` |
| OpenAI Responses: reasoning items back with their calls, to OpenAI only; the effort ladder | `intel/tests/test_openai_responses.py` |
| Agent: selection that cannot run is an error, never a switch; the tool probe; provider state kept for the next turn only; map switch; consent; local-only; budget | `intel/tests/test_agent_selection.py`, `test_chat_agent_providers.py` |
| Context budget: oldest tool results trimmed first, then history; the estimate corrected from usage | `intel/tests/test_context_budget.py` |
| A canary key in no API response, SSE, error body, log, history database or `.env`; writes refused without the session token or JSON | `intel/tests/test_providers_api.py`, `test_provider_keys.py`, `test_redact.py` |
| The proxy: provider routes refuse other sites, a missing Origin, non-JSON writes and proxies, and stay closed to the LAN even with chat opened to it | `src/tooling/intelProxy.test.mjs` |
| The check script itself: PASS path, a model that will not call the tool, a rejected key (FAIL, one request per step, key never printed), no key, no model, unknown provider, local-only, the database only read | `intel/tests/test_verify_provider.py` |
| The UI against a stateful mock: chip and settings, keys typed in POWER UP (a canary key never in browser storage), consent, local-only, no silent fallback, budget, markup injection, 390 px | `npm run qa:neural-core-providers` |

### (b) Verified live

Ollama 0.40.13 on this machine only:

- **The check script:** `verify_provider.py ollama` passed all three steps with
  `qwen3.5-9b-64k-gpu:latest` in 3 of 4 runs (output below).
  - In the other run, step 2 failed as `provider_unavailable`: Ollama's model runner crashed
    while loading (`CUDA error: shared object initialization failed`).
  - Step 3 then passed on a fresh runner, and the next run passed in full.
- **The eval:** the 15-prompt Neural Core eval scored 13/15 with refusals 2/3
  (`docs/providers/p5-eval-qwen3.5-9b-64k-gpu_latest.json`). The misses were two empty keyless
  web searches and one refusal prompt where the model tried a web search; the guard refused it.
- **Settings writes from the page:** checked through the real proxy and session token in P4:
  local-only, budget, consent with a `:cloud` selection, back to a local model, consent revoked.

### (c) Needs a live run by the owner, with a key

- **Each cloud provider:** Claude, ChatGPT, OpenRouter, NVIDIA NIM (per model: tool support
  varies) and DeepSeek. Run the steps below.
- **A custom OpenAI-compatible server** (LM Studio, vLLM).
- **Ollama `:cloud` models**, which use your ollama.com account.
- **Saving a key from POWER UP** into the real Windows Credential Manager. The tests use an
  in-memory keyring.
- **Wire facts no fake can settle:**
  - Anthropic accepting `tool_choice: {type: none}`, and thinking replayed across turns;
  - each provider's context-too-long error shape;
  - OpenAI's effort-rejection body;
  - NIM `stream_options` usage;
  - OpenRouter `reasoning_details` passback.

## The check script

`intel/scripts/verify_provider.py` builds the provider exactly as the intel service does: the
shipped `providers.default.yaml`, the key from the environment, the keyring or `.env` (same
order as the service), and the base URL, workspace ID and parameters saved in
Settings → Neural Core. Then it:

1. lists the models (no tokens);
2. sends one short prompt;
3. runs a tool round trip: the model must call a dummy `add_numbers` tool with 17 and 25, get
   the result back and answer with 42. This replays the provider's own round-trip format:
   Anthropic's batched `tool_result`, Responses' `function_call_output`, DeepSeek's passback.

It writes nothing: no key, setting, consent, usage or capability cache. Saved settings are read
from a copy of the intel database. The prompts are fixed test text, so no conversation, map or
news is sent and no consent is needed, but local-only mode is respected. Each request asks for at
most 1,024 output tokens.

Exit status:

- **0:** every step passed.
- **1:** a step failed.
- **2:** the check could not run (unknown provider, no key, no model chosen, local-only mode).

## Steps for each provider (PowerShell, repository root)

1. **Save the key** in POWER UP → NEURAL CORE CHAT KEYS. Do not set it in your global environment
   ([why](KEYS_AND_COSTS.md#do-not-put-keys-in-your-global-windows-environment)). For Anthropic
   with an unscoped key, set the Workspace ID in Settings → Neural Core first. For a custom
   server, set its base URL there.
2. **List the models.** This spends nothing and stops after step 1:

   ```powershell
   uv run --project intel python intel/scripts/verify_provider.py anthropic
   ```

   Provider ids: `ollama`, `anthropic`, `openai`, `openrouter`, `nvidia`, `deepseek`, `custom`.
3. **Run the full check** with a model from that list. It spends a few hundred tokens:

   ```powershell
   uv run --project intel python intel/scripts/verify_provider.py anthropic --model <model id>
   ```

4. **Read the result.** Each step prints `PASS` or `FAIL` with the reason and the tokens it used,
   and the last line is `RESULT PASS` or `RESULT FAIL`. Error text goes through the same redactor
   as the service, so the output never shows a key; it is safe to paste back.
5. **Try it in the app.** Choose the provider and model in Settings → Neural Core, accept the
   consent dialog, then ask one globe question ("fly to Nairobi") and one news question. Check
   that the header chip counts tokens.

### Notes per provider

- **OpenAI:** a model that needs Chat Completions instead of the Responses API must be listed in
  its settings ("Models to run on Chat Completions"). The first request may take an extra round
  trip while the adapter learns which reasoning effort the model accepts.
- **OpenRouter:** pick a model whose list entry has `tools yes`; a `tools unknown` model may still
  pass.
- **NVIDIA NIM:** the list mixes model types and declares no capabilities. A step 3 failure where
  the model "did not call add_numbers" means that model does not call tools; try another.
- **DeepSeek:** thinking is off (there is no reasoning toggle yet), so a live run does not
  exercise the `reasoning_content` passback; only the fake tests do.
- **Custom:** a server elsewhere on your network over plain `http` is checked only without a key;
  a key is never sent over `http` off this machine.

## The Ollama run, 2026-10-30

```text
> uv run --project intel python intel/scripts/verify_provider.py ollama
Saved settings from C:\Users\Murali Kannan\Workspace\Claude\SKYNET\intel\data\spectre.db
Ollama at http://127.0.0.1:11434 (local)
PASS 1 list models: 8 listed
       nemotron-3.5-bolt:e4b  [local, tools yes]
       beam:cloud  [cloud, tools yes]
       bonsai-2-9b-64k:latest  [local, tools yes]
       bonsai-2:9b  [local, tools yes]
       gemma4:cloud  [cloud, tools yes]
       qwen3.5-9b-64k-gpu:latest  [local, tools yes]
       nemotron-3-super:cloud  [cloud, tools yes]
       nemotron-3-ultra:cloud  [cloud, tools yes]
Model qwen3.5-9b-64k-gpu:latest [local, tools yes]: steps 2 and 3 run on that machine.
PASS 2 short prompt: 'ready' (39 in / 2 out tokens)
PASS 3 tool call: add_numbers({"a": 17, "b": 25}) (320 in / 38 out tokens)
PASS 3 tool result: 'The sum of 17 and 25 is 42.' (378 in / 16 out tokens)
RESULT PASS
```

The `:cloud` models were listed but not run: they use the owner's ollama.com account.
