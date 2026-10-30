"""Live check of one Neural Core chat provider (ADR-002 §3; steps in docs/VERIFY_PROVIDERS.md).

The provider is built exactly as the intel service builds it: the shipped
provider file, the key from the environment, the OS keyring or .env, and the
base URL, workspace ID and parameters saved in Settings → Neural Core. Then:

1. list the models (no tokens spent);
2. one short prompt, streamed;
3. a tool round trip: the model must call a dummy tool, get its result back
   and answer with it.

Each step prints PASS or FAIL. Steps 2 and 3 spend a few tokens on a paid
API. Nothing is written: no key, setting, consent, usage or capability cache
(the saved settings are read from a copy of the intel database). The prompts
are fixed test text; no conversation, map or news is sent. Local-only mode,
when on, is respected.

Run from the repository root:

    uv run --project intel python intel/scripts/verify_provider.py ollama
    uv run --project intel python intel/scripts/verify_provider.py anthropic
    uv run --project intel python intel/scripts/verify_provider.py anthropic --model <id from step 1>

Without --model, an API provider stops after step 1 (there is no default
model, ADR-002 D12). Exit status: 0 every step passed, 1 a step failed,
2 the check could not run (unknown provider, no key, no model, local-only).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sqlite3
import sys
import tempfile
from collections.abc import Callable, Mapping
from contextlib import aclosing, closing
from pathlib import Path
from typing import Any

import httpx
import httpx2
import keyring
from keyring.backend import KeyringBackend

INTEL_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(INTEL_DIR))

from app.chat.agent import REASONING_MAX_OUTPUT  # noqa: E402
from app.chat.providers.base import (  # noqa: E402
    ChatProvider,
    ChatRequest,
    Done,
    Message,
    TextDelta,
    ToolCall,
    ToolCallEvent,
    Usage,
)
from app.chat.providers.errors import ProviderError  # noqa: E402
from app.chat.providers.keys import KeyStore  # noqa: E402
from app.chat.providers.registry import DEFAULT_PATH as PROVIDERS_FILE  # noqa: E402
from app.chat.providers.sdk import TIMEOUT as SDK_TIMEOUT  # noqa: E402
from app.config import Settings, load_settings  # noqa: E402
from app.main import load_providers  # noqa: E402
from app.redact import install_log_redaction, redact  # noqa: E402
from app.store.providers import ProviderStore  # noqa: E402

OK, FAILED, CANNOT_RUN = 0, 1, 2
MAX_OUTPUT = 1024
SHOWN_MODELS = 25
TOOL_NAME = "add_numbers"
TOOL = {
    "type": "function",
    "function": {
        "name": TOOL_NAME,
        "description": "Adds two whole numbers and returns the sum.",
        "parameters": {
            "type": "object",
            "properties": {"a": {"type": "integer"}, "b": {"type": "integer"}},
            "required": ["a", "b"],
        },
    },
}
SYSTEM = "You are a test harness. Follow the instruction exactly and keep replies short."
SHORT_PROMPT = "Reply with the single word: ready"
TOOL_PROMPT = f"Use the {TOOL_NAME} tool to add 17 and 25, then tell me the sum."
SUM = 42
LOCAL_ONLY = "Local-only mode is on, so {} is not checked. Turn it off in Settings → Neural Core."

Out = Callable[[str], None]


def copy_database(db_path: Path, scratch: Path) -> Path:
    """A consistent copy of the intel database (read-only on the original),
    or an empty one when the service has not run yet."""
    target = scratch / "intel.db"
    if db_path.exists():
        source = sqlite3.connect(f"{db_path.resolve().as_uri()}?mode=ro", uri=True)
        with closing(source), closing(sqlite3.connect(target)) as copy:
            source.backup(copy)
    return target


def _number(value: Any) -> int | None:
    try:
        return int(str(value).strip())
    except ValueError:
        return None


async def _stream(provider: ChatProvider, request: ChatRequest) -> dict[str, Any]:
    reply: dict[str, Any] = {"text": "", "calls": [], "usage": None, "done": None}
    async with aclosing(provider.stream(request)) as events:
        async for event in events:
            if isinstance(event, TextDelta):
                reply["text"] += event.text
            elif isinstance(event, ToolCallEvent):
                reply["calls"].append(event.call)
            elif isinstance(event, Usage):
                reply["usage"] = event
            elif isinstance(event, Done):
                reply["done"] = event
    return reply


def _spent(reply: dict[str, Any]) -> str:
    usage = reply["usage"]
    return f"{usage.input} in / {usage.output} out tokens" if usage else "no usage reported"


async def list_step(provider: ChatProvider, model: str | None, out: Out) -> bool:
    try:
        models = await provider.list_models()
    except ProviderError as error:
        out(f"FAIL 1 list models: {error.code}: {error}")
        return False
    if not models:
        out("FAIL 1 list models: the provider listed none")
        return False
    out(f"PASS 1 list models: {len(models)} listed")
    for info in models[:SHOWN_MODELS]:
        out(f"       {info.id}  [{info.kind}, tools {info.supports_tools}]")
    if len(models) > SHOWN_MODELS:
        out(f"       … and {len(models) - SHOWN_MODELS} more")
    if model and model not in {info.id for info in models}:
        out(f"       note: {model} is not in the list; the next steps try it anyway")
    return True


async def prompt_step(provider: ChatProvider, model: str, params: dict[str, Any], out: Out) -> bool:
    request = ChatRequest(model, (Message("system", SYSTEM), Message("user", SHORT_PROMPT)), params=params)
    try:
        reply = await _stream(provider, request)
    except ProviderError as error:
        out(f"FAIL 2 short prompt: {error.code}: {error}")
        return False
    text = " ".join(reply["text"].split())
    if not text:
        out(f"FAIL 2 short prompt: no text came back ({_spent(reply)})")
        return False
    out(f"PASS 2 short prompt: {text[:80]!r} ({_spent(reply)})")
    return True


async def tool_step(provider: ChatProvider, model: str, params: dict[str, Any], out: Out) -> bool:
    messages = (Message("system", SYSTEM), Message("user", TOOL_PROMPT))
    try:
        first = await _stream(provider, ChatRequest(model, messages, tools=(TOOL,), params=params))
    except ProviderError as error:
        out(f"FAIL 3 tool call: {error.code}: {error}")
        return False
    calls: list[ToolCall] = [call for call in first["calls"] if call.name == TOOL_NAME]
    if not calls:
        said = " ".join(first["text"].split())[:80]
        out(f"FAIL 3 tool call: the model did not call {TOOL_NAME} (it said {said!r})")
        return False
    call = calls[0]
    args = call.args if isinstance(call.args, dict) else {}
    if sorted(_number(args.get(name)) for name in ("a", "b")) != [17, 25]:
        out(f"FAIL 3 tool call: {TOOL_NAME} came with {json.dumps(call.args)[:80]}")
        return False
    out(f"PASS 3 tool call: {TOOL_NAME}({json.dumps(args)}) ({_spent(first)})")
    done: Done | None = first["done"]
    replay = (
        *messages,
        Message(
            "assistant",
            first["text"],
            tool_calls=tuple(first["calls"]),
            provider_id=provider.id,
            model=model,
            provider_state=done.provider_state if done else None,
        ),
        *(Message("tool", json.dumps({"sum": SUM}), tool_call_id=c.id, name=c.name) for c in first["calls"]),
    )
    try:
        second = await _stream(provider, ChatRequest(model, replay, tools=(TOOL,), params=params))
    except ProviderError as error:
        out(f"FAIL 3 tool result: {error.code}: {error}")
        return False
    text = " ".join(second["text"].split())
    if str(SUM) not in text:
        detail = "it called a tool again" if second["calls"] else f"it said {text[:80]!r}"
        out(f"FAIL 3 tool result: the answer does not use the result ({detail})")
        return False
    out(f"PASS 3 tool result: {text[:80]!r} ({_spent(second)})")
    return True


def request_params(settings: Settings, saved: Mapping[str, Any]) -> dict[str, Any]:
    """The agent's defaults and the saved per-provider parameters, with a
    small output cap (larger with reasoning on: thinking shares it)."""
    params: dict[str, Any] = {
        "think": settings.ollama_think,
        "keep_alive": settings.ollama_keep_alive,
        "num_ctx": settings.num_ctx,
        "temperature": 0.2,
        **saved,
    }
    cap = MAX_OUTPUT
    if "reasoning" in saved:  # as the agent maps it (Ollama calls it think)
        params["think"] = bool(saved["reasoning"])
        cap = REASONING_MAX_OUTPUT if saved["reasoning"] else MAX_OUTPUT
    params["max_output_tokens"] = min(int(params.get("max_output_tokens") or cap), cap)
    return params


async def verify(
    provider_id: str,
    model: str | None,
    *,
    settings: Settings,
    environ: Mapping[str, str],
    backend: KeyringBackend | None,
    out: Out = print,
    ollama_http: httpx.AsyncClient | None = None,
    sdk_http: httpx2.AsyncClient | None = None,
) -> int:
    """Runs the check; the clients are the service's own unless a test passes fakes."""
    keys = KeyStore(boot_env=environ, env_file=settings.env_file, backend=backend)
    ollama_http = ollama_http or httpx.AsyncClient(trust_env=False)
    sdk_http = sdk_http or httpx2.AsyncClient(timeout=SDK_TIMEOUT, follow_redirects=False)
    with tempfile.TemporaryDirectory(prefix="spectre-verify-") as scratch:
        if settings.db_path.exists():
            out(f"Saved settings from {settings.db_path}")
        else:
            out(f"No saved settings at {settings.db_path}; defaults used")
        store = ProviderStore(str(copy_database(settings.db_path, Path(scratch))))
        try:
            return await _verify(provider_id, model, settings, keys, store, ollama_http, sdk_http, out)
        finally:
            await ollama_http.aclose()
            await sdk_http.aclose()
            store.close()


async def _verify(
    provider_id: str,
    model: str | None,
    settings: Settings,
    keys: KeyStore,
    store: ProviderStore,
    ollama_http: httpx.AsyncClient,
    sdk_http: httpx2.AsyncClient,
    out: Out,
) -> int:
    providers, problem = load_providers(
        path=PROVIDERS_FILE,
        ollama_http=ollama_http,
        ollama_host=settings.ollama_host,
        keys=keys,
        store=store,
        sdk_http=sdk_http,
    )
    spec = providers.specs.get(provider_id) if providers else None
    provider = providers.get(provider_id) if providers else None
    if spec is None or provider is None:
        known = ", ".join(providers.specs) if providers else problem
        out(f"Unknown provider {provider_id!r}. Known: {known}")
        return CANNOT_RUN
    status = keys.status(spec)
    if status.required and not status.configured:
        names = " or ".join(spec.key_env) or "a key"
        out(f"No key for {spec.label}: save it in POWER UP (NEURAL CORE CHAT KEYS) or set {names}.")
        return CANNOT_RUN
    if provider.kind == "cloud" and store.policy().local_only:
        out(LOCAL_ONLY.format(spec.label))
        return CANNOT_RUN
    if spec.id == "ollama":
        model = model or settings.ollama_model
    base_url = getattr(provider, "base_url", None) or settings.ollama_host
    where = f"{spec.label} at {base_url} ({spec.kind}"
    out(f"{where}; key from {status.source})" if status.required else f"{where})")
    if not await list_step(provider, model, out):
        return FAILED
    if not model:
        out("Pick a model from the list and run again with --model <id>.")
        return CANNOT_RUN
    try:
        info = await provider.model_caps(model)
    except ProviderError as error:
        out(f"FAIL model {model}: {error.code}: {error}")
        return FAILED
    if info.kind == "cloud" and store.policy().local_only:
        out(LOCAL_ONLY.format(f"{model} (cloud)"))
        return CANNOT_RUN
    spend = "spend a few tokens" if info.kind == "cloud" else "run on that machine"
    out(f"Model {model} [{info.kind}, tools {info.supports_tools}]: steps 2 and 3 {spend}.")
    params = request_params(settings, store.settings(spec.id).params)
    passed = await prompt_step(provider, model, params, out)
    passed = await tool_step(provider, model, params, out) and passed
    out("RESULT PASS" if passed else "RESULT FAIL")
    return OK if passed else FAILED


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Live check of one Neural Core chat provider.")
    parser.add_argument("provider", help="a provider id from providers.default.yaml, e.g. ollama, anthropic")
    parser.add_argument("--model", help="the model id to check (required for API providers)")
    args = parser.parse_args(argv)
    # Redirected output on Windows is cp1252; a model name or reply must not crash the check.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")
    install_log_redaction()

    def out(line: str) -> None:
        # Model ids and replies come from the provider: no escape codes reach the terminal.
        printable = "".join(ch if ch.isprintable() else "?" for ch in line)
        print(redact(printable), flush=True)

    environ = dict(os.environ)
    return asyncio.run(
        verify(
            args.provider,
            args.model,
            settings=load_settings(environ),
            environ=environ,
            backend=keyring.get_keyring(),
            out=out,
        )
    )


if __name__ == "__main__":
    raise SystemExit(main())
