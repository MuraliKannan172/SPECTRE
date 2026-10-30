# Neural Core chat: keys and costs

The Neural Core runs on Ollama on your own machine by default, and that costs nothing.
Settings → Neural Core can switch a conversation to a developer API instead: Claude (Anthropic),
ChatGPT (OpenAI), OpenRouter, NVIDIA NIM, DeepSeek or an OpenAI-compatible server you run.

When you do, every turn sends that company the conversation, the tool results (news snippets and
text from web pages) and, if the map switch is on, the map context (view and active layers).
They bill your key per token. The design is in [ADR-002](ADR-002-providers.md); how to check a
provider is in [VERIFY_PROVIDERS.md](VERIFY_PROVIDERS.md).

## An API key is not a chat subscription

"Claude" and "ChatGPT" here mean the **developer APIs**. A claude.ai or ChatGPT subscription does
not include an API key, and API use is billed separately, per token, from a prepaid or invoiced
API account.

## Getting a key

| Provider | Environment variable | Where the key comes from | Prices |
|---|---|---|---|
| Claude (Anthropic API) | `ANTHROPIC_API_KEY` | the Claude Console, under API keys | [claude.com/pricing](https://claude.com/pricing), API section |
| ChatGPT (OpenAI API) | `OPENAI_API_KEY` | the OpenAI Platform, under API keys | [openai.com/api/pricing](https://openai.com/api/pricing/) |
| OpenRouter | `OPENROUTER_API_KEY` | openrouter.ai, under Keys | per model on [openrouter.ai/models](https://openrouter.ai/models); the picker shows them |
| NVIDIA NIM | `NVIDIA_API_KEY` (keys start `nvapi-`) | [build.nvidia.com](https://build.nvidia.com/) | the catalog offers free inference for trying models; its terms are on that site |
| DeepSeek | `DEEPSEEK_API_KEY` | the DeepSeek Platform, under API keys | [api-docs.deepseek.com/quick_start/pricing](https://api-docs.deepseek.com/quick_start/pricing) |
| Custom (OpenAI-compatible) | `SPECTRE_CUSTOM_API_KEY`, optional | your own server (LM Studio, vLLM, llama.cpp) | yours |
| Ollama | none | — | free on your machine; see `:cloud` models below |

Anthropic keys that are not scoped to a workspace also need the **Workspace ID** field in
Settings → Neural Core.

## Where to put it

Use **POWER UP → NEURAL CORE CHAT KEYS** (the POWER UP chip, bottom right, on the dev server that
`run.bat` and `spectre.ps1` start). It hands the key to the intel service, which stores it in the
**OS keyring** (Windows Credential Manager, service "SPECTRE Neural Core", one entry per
provider). Nothing restarts and the key is used on the next turn.

The intel service looks for a key in this order:

1. **The environment** the service started with. Shown as "set in the environment" and read-only:
   POWER UP cannot replace or remove it.
2. **The OS keyring**, where POWER UP saves.
3. **The repository's `.env`**, read on every lookup.

`OPENAI_API_KEY` in `.env` is also God's Eye View's voice key. A key saved in POWER UP's Neural
Core section is used for chat only, so chat and voice can use different keys. Without an OS
keyring, POWER UP refuses to change that shared line for chat; change it in `.env` itself.

**A key goes only where it belongs.** A stored key is sent to its provider's own address, or to
the address it was saved for in POWER UP. If you change a provider's base URL in Settings →
Neural Core, save the key again for the new address; until then it is not sent there, and the
settings view says so. A key from the environment or `.env` goes only to the provider's own
address. Changing the address also asks for consent again.

Keys stay in the intel service. They are never sent to the browser or written to the chat
history, the logs, error messages or URLs; the API reports only whether a key is set and where it
came from. Keys can be changed only from this machine, with the page's session token, never by a
LAN viewer. A LAN viewer (with `SPECTRE_CHAT_ALLOW_LAN=1`) can chat with local models only: a
cloud model, or a server on another machine, never runs for them, so nobody else spends your
key.

## Do not put keys in your global Windows environment

Keep these keys in POWER UP (keyring) or `.env`, not in your Windows user or system environment
variables, and do not `$env:ANTHROPIC_API_KEY = ...` in a shell you keep using:

- **Claude Code.** If `ANTHROPIC_API_KEY` is set in the shell where you run Claude Code, Claude
  Code itself can use it and bill API usage to that key instead of your Claude subscription.
- **Every other program** started from that environment can read the keys too.
- **SPECTRE itself.** An environment key outranks the keyring and is read-only in the panel, so it
  silently wins over the key you save in POWER UP.

`run.bat` and `scripts/spectre.ps1` do not copy `.env` into the environment; the intel service
reads `.env` itself. To check for and remove a user-level variable (PowerShell, then open a new
terminal):

```powershell
[Environment]::GetEnvironmentVariable('ANTHROPIC_API_KEY', 'User')
[Environment]::SetEnvironmentVariable('ANTHROPIC_API_KEY', $null, 'User')
```

## What a turn costs

SPECTRE ships no price tables, because they go stale. Check the provider's page before you use a
key. A turn costs roughly:

> (input tokens × input price + output tokens × output price) / 1,000,000, for prices per 1M
> tokens.

What drives the token count:

- **Every round is billed.** A turn that uses tools sends the whole prompt again each round: up to
  4 tool rounds and the answer, so up to 5 requests.
- **The fixed part.** The system prompt and the tool definitions are about 11,300 characters. On
  Ollama that was 3,099 prompt tokens on 2026-10-30; other tokenizers differ.
- **The variable part.** History, news results and web pages add to that, within the budgets
  below.

The guards:

- **Output per request:** 4,096 tokens by default (Max output tokens in Settings → Neural Core),
  8,192 with Reasoning on. Thinking is billed as output, so a reasoning turn costs more.
- **Rounds:** at most 4 tool rounds per turn.
- **Input per request:** at most 12,288 tokens (a 16k context ceiling less the output guard),
  lower for models with a smaller window. Over it, the oldest tool results are trimmed first,
  then the oldest history. The estimate starts at 4 characters per token and tightens to what
  the provider reports. **Context ceiling for API models** in Settings → Neural Core changes
  the 16,384: raising it sends more history and web text per turn (budgets and limit scale
  with it, up to the model's own window), and every one of those tokens is billed.
- **Per conversation:** a soft budget of 100,000 cloud tokens (Settings → Neural Core; 0 turns it
  off). When it is reached, the chat pauses until you press Continue, which allows one more
  budget's worth.

The header chip shows the session's tokens, and the cost when a price is known:

- **OpenRouter:** from its model list (USD per token, shown per 1M).
- **Every other provider:** the price per 1M input and output tokens you type in that provider's
  parameters. Without one, tokens only.

## Ollama's `:cloud` models

Models such as `gemma4:cloud` run on ollama.com under your Ollama account, not on your GPU, with
that account's limits and plan. SPECTRE badges them `CLOUD · Ollama`, asks for consent before the
first one and blocks them in local-only mode, like any cloud provider.

## Keeping it local

- **Local-only mode** (Settings → Neural Core) blocks every cloud model, Ollama's `:cloud` ones
  included, before any request leaves the machine.
- **Consent.** Each non-local provider asks first and lists what it will receive; consent can be
  revoked in Settings.
- **No silent fallback.** A failed turn is never retried on another provider by itself.
