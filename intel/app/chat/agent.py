"""Neural Core agent loop (ADR-001 D5).

One turn: refuse person lookups outright; otherwise stream the model's
answer, run at most MAX_TOOL_ROUNDS rounds of tool calls, and finish with a
final answer (the last request offers no tools, so the model must answer).

Server tools (news, web, map context) run here. Globe tools run in the
browser: the turn emits `client_tool`, the panel runs the call and POSTs the
result to /api/intel/chat/tool-result, and the turn waits up to
CLIENT_TOOL_TIMEOUT seconds before telling the model the call timed out.

Events are (name, data) pairs, sent to the panel as SSE: turn, token,
tool_status, client_tool, citation, done, error.

The loop is provider-agnostic (ADR-002 D3): it speaks the canonical types in
providers/base.py, and an adapter (Ollama by default) owns the wire format.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import functools
import json
import math
import time
import uuid
from collections.abc import AsyncIterator, Callable
from contextlib import aclosing
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

from ..config import FULL_BUDGETS, Settings, budgets_for
from ..schema import iso
from ..store.chat import ChatStore
from ..store.news import NewsQuery, NewsStore
from ..web.fetch import FetchError, PageFetcher
from ..web.guard import BlockedURL
from ..web.search import SearchError, SearchService
from .context import (
    CHARS_PER_TOKEN,
    OLLAMA_OUTPUT_RESERVE,
    chars_per_token,
    fit,
    message_chars,
    tools_chars,
)
from .ollama import OllamaClient
from .policy import MAP_WITHHELD, REFUSAL, person_lookup, system_prompt, wrap_untrusted
from .probe import probe_tools
from .providers.base import (
    DEFAULT_MAX_OUTPUT,
    ChatProvider,
    ChatRequest,
    Done,
    Message,
    TextDelta,
    ThinkingDelta,
    ToolCall,
    ToolCallEvent,
    Usage,
    normalize_args,
)
from .providers.errors import ProviderError
from .providers.ollama import OllamaProvider
from .providers.retry import stream_with_retries
from .tools import ToolRegistry

MAX_TOOL_ROUNDS = 4
BASE_WINDOW = 16384
CLIENT_TOOL_TIMEOUT = 15.0
MAX_CLIENT_RESULT_CHARS = 4000
MAX_ROUND_CHARS = 60_000  # one round's reply; far above any real answer
# Thinking shares the output budget, so a reasoning turn gets more room.
REASONING_MAX_OUTPUT = 8192
OLLAMA_THINKING_RESERVE = 4096
INFO_TOOLS = frozenset({"news_search", "news_near", "web_search", "fetch_page"})
# Said after the untrusted block, so it reads as ours, not the source's.
CITE_HINT = "\nCite each fact you use from these sources with its number, like [1]."

Event = tuple[str, dict[str, Any]]


@dataclass
class Turn:
    conversation_id: int
    message: str
    viewport: dict[str, Any] | None = None
    layer_state: dict[str, Any] | None = None
    history: list[dict[str, Any]] = field(default_factory=list)
    turn_id: str = field(default_factory=lambda: uuid.uuid4().hex)
    provider_id: str | None = None  # the stored selection; None is the default Ollama model
    model: str | None = None
    # A viewer on another machine (SPECTRE_CHAT_ALLOW_LAN), as the proxy marks it:
    # it may chat with local models but never spend the owner's cloud key.
    lan: bool = False


@dataclass(frozen=True)
class Plan:
    """What a turn runs on, settled before the first round."""

    provider: ChatProvider
    model: str
    native: bool
    budgets: dict[str, int]
    kind: str = "local"  # the model's: decides consent, the map switch and the budget
    params: dict[str, Any] = field(default_factory=dict)
    input_limit: int = BASE_WINDOW - DEFAULT_MAX_OUTPUT  # tokens one round may send (D9)
    chars_per_token: float = CHARS_PER_TOKEN


def api_budgets(window: int | None, ceiling: int = BASE_WINDOW) -> dict[str, int]:
    """FULL_BUDGETS scaled to the context ceiling (16k unless the user changed
    it); a smaller context window lowers them (D9)."""
    scale = min(window or BASE_WINDOW, ceiling) / BASE_WINDOW  # unknown window: 16k
    return {name: int(tokens * scale) for name, tokens in FULL_BUDGETS.items()}


def api_input_limit(window: int | None, max_output: int, ceiling: int = BASE_WINDOW) -> int:
    """Input tokens per round for an API model: the ceiling less the default
    output guard, lowered by the model's own window less its output."""
    return max(1024, min(ceiling - DEFAULT_MAX_OUTPUT, (window or BASE_WINDOW) - max_output))


class Sources:
    """The turn's numbered sources: [1], [2], ... in the order first seen."""

    def __init__(self) -> None:
        self.items: list[dict[str, Any]] = []
        self._by_url: dict[str, int] = {}

    def add(self, url: str, title: str | None, source: str | None) -> tuple[int, bool]:
        if url in self._by_url:
            return self._by_url[url], False
        number = len(self.items) + 1
        self._by_url[url] = number
        self.items.append({"n": number, "url": url, "title": (title or url)[:200], "source": source})
        return number, True


class ThinkFilter:
    """Drops <think>...</think> spans some models emit even with think off."""

    def __init__(self) -> None:
        self._inside = False
        self._pending = ""

    def feed(self, text: str) -> str:
        data, out = self._pending + text, []
        self._pending = ""
        while data:
            tag = "</think>" if self._inside else "<think>"
            at = data.find(tag)
            if at < 0:
                # keep a possible partial tag for the next chunk
                keep = next((n for n in range(len(tag) - 1, 0, -1) if data.endswith(tag[:n])), 0)
                if not self._inside:
                    out.append(data[: len(data) - keep])
                self._pending = data[len(data) - keep :] if keep else ""
                break
            if not self._inside:
                out.append(data[:at])
            data = data[at + len(tag) :]
            self._inside = not self._inside
        return "".join(out)


def _host(url: str) -> str:
    return (urlsplit(url).hostname or "").removeprefix("www.")


class Agent:
    def __init__(
        self,
        *,
        settings: Settings,
        ollama: OllamaClient,
        news: NewsStore,
        chats: ChatStore,
        search: SearchService,
        fetcher: PageFetcher,
        registry: ToolRegistry,
        open_only: Callable[[], bool] = lambda: True,
        clock: Callable[[], float] = time.time,
        provider: ChatProvider | None = None,
        local_only: Callable[[], bool] = lambda: False,
        consented: Callable[[str], bool] = lambda provider_id: False,
        providers: Callable[[str], ChatProvider | None] = lambda provider_id: None,
        known_tools: Callable[[str, str, str], str | None] = lambda provider_id, base_url, model: None,
        remember_tools: Callable[[str, str, str, str], None] = lambda provider_id, base_url, model, s: None,
        map_context: Callable[[], bool] = lambda: True,
        session_budget: Callable[[], int] = lambda: 0,
        params_for: Callable[[str], dict[str, Any]] = lambda provider_id: {},
        context_ceiling: Callable[[], int] = lambda: BASE_WINDOW,
    ) -> None:
        self.settings = settings
        self.map_context = map_context
        self.session_budget = session_budget
        self.params_for = params_for
        self.context_ceiling = context_ceiling
        # The status route and the eval still read Ollama directly.
        self.ollama = ollama
        self.provider = provider or OllamaProvider(ollama)
        self.news = news
        self.chats = chats
        self.search = search
        self.fetcher = fetcher
        self.registry = registry
        self.open_only = open_only
        self.local_only = local_only
        self.consented = consented
        self.providers = providers
        self.known_tools = known_tools
        self.remember_tools = remember_tools
        self._unproven: set[tuple[str, str, str]] = set()
        # Characters per token seen in reported usage, per provider and model (D9).
        self._density: dict[tuple[str, str], float] = {}
        self.clock = clock
        self._pending: dict[tuple[str, str], asyncio.Future[dict[str, Any]]] = {}

    # -- client tools ------------------------------------------------------------

    def resolve_client_tool(self, turn_id: str, call_id: str, payload: dict[str, Any]) -> bool:
        future = self._pending.get((turn_id, call_id))
        if future is None or future.done():
            return False
        future.set_result(payload)
        return True

    async def capabilities(self) -> frozenset[str]:
        """The selected model's capabilities (the provider caches them)."""
        return (await self.provider.model_caps(self.settings.ollama_model)).capabilities

    def local_only_blocks(self) -> bool:
        """Local-only mode is on and the provider itself is a cloud API, so no
        call may reach it, not even a capability lookup carrying the key."""
        return self.provider.kind == "cloud" and self.local_only()

    def forget_unproven(self, provider_id: str, base_url: str, model: str) -> None:
        """After "Test tool calling", the cached answer decides, not this run's memory."""
        self._unproven.discard((provider_id, base_url, model))

    def _egress_refusal(self, provider: ChatProvider, kind: str, lan: bool = False) -> dict[str, Any] | None:
        """ADR-002 D6: local-only mode blocks every cloud model, Ollama's
        :cloud ones included, and every non-local model needs consent first,
        a server on your network and Ollama's :cloud models too (the panel
        asks for it, P4). Checked on the provider's kind before any call, then
        on the model's (an Ollama provider is local, its :cloud models are not)."""
        if kind == "local":
            return None
        if lan:
            return _refusal(
                "lan_viewer",
                "Cloud and network models answer only on the computer running SPECTRE.",
                provider,
            )
        if kind == "cloud" and self.local_only():
            return _refusal("local_only", "Local-only mode is on, so cloud models are blocked.", provider)
        if not self.consented(provider.id):
            message = f"{provider.id} has not been allowed to receive this conversation yet."
            return _refusal("consent_required", message, provider)
        return None

    async def _plan(self, turn: Turn) -> Plan | dict[str, Any]:
        """The turn's provider, model, tool mode and budgets, or the error that
        stops it. A stored selection that cannot run is an error, never a
        quiet switch to another provider (D6)."""
        provider = self.providers(turn.provider_id) if turn.provider_id else self.provider
        if provider is None:
            return {
                "code": "unknown_provider",
                "message": "The selected provider is not available.",
                "provider": turn.provider_id,
                "retryable": False,
            }
        model = turn.model or self.settings.ollama_model
        refusal = self._egress_refusal(provider, provider.kind, turn.lan)
        if refusal:
            return refusal
        try:
            info = await provider.model_caps(model)
        except ProviderError as error:
            return _error_event(error)
        refusal = self._egress_refusal(provider, info.kind, turn.lan)
        if refusal:
            return refusal
        params = self.params_for(provider.id)
        density = self._density.get((provider.id, model), CHARS_PER_TOKEN)
        if provider.id == "ollama":
            num_ctx = int(params.get("num_ctx") or self.settings.num_ctx)
            # Only the switch moves the reserve: without it, nothing changes.
            reserve = OLLAMA_THINKING_RESERVE if params.get("reasoning") else OLLAMA_OUTPUT_RESERVE
            return Plan(
                provider,
                model,
                "tools" in info.capabilities,
                budgets_for(num_ctx),
                info.kind,
                params,
                input_limit=max(num_ctx // 2, num_ctx - reserve),
                chars_per_token=density,
            )
        support = info.supports_tools
        if support == "unknown":
            base_url = str(getattr(provider, "base_url", ""))
            key = (provider.id, base_url, model)
            support = self.known_tools(*key) or ("yes" if key in self._unproven else "unknown")
            if support == "unknown":
                try:
                    probed = await probe_tools(provider, model)
                except ProviderError as error:
                    return _error_event(error)
                if probed:
                    self.remember_tools(*key, probed)
                else:
                    # The API took the tools but proved nothing: native tools, no
                    # cache row, and no second probe while the service runs (D10).
                    self._unproven.add(key)
                support = probed or "yes"
        default_output = REASONING_MAX_OUTPUT if params.get("reasoning") else DEFAULT_MAX_OUTPUT
        max_output = int(params.get("max_output_tokens") or default_output)
        ceiling = self.context_ceiling()
        return Plan(
            provider,
            model,
            support == "yes",
            api_budgets(info.context_window, ceiling),
            info.kind,
            params,
            input_limit=api_input_limit(info.context_window, max_output, ceiling),
            chars_per_token=density,
        )

    # -- the turn --------------------------------------------------------------

    def _now_local(self) -> str:
        return dt.datetime.fromtimestamp(self.clock()).astimezone().strftime("%Y-%m-%d %H:%M %Z")

    def _history(
        self, history: list[dict[str, Any]], tokens: int, density: float, model: str
    ) -> list[Message]:
        budget = int(tokens * density)
        kept: list[Message] = []
        for message in reversed(history):
            content = str(message.get("content") or "")
            if message.get("role") not in ("user", "assistant") or not content:
                continue
            if len(content) > budget:
                break
            budget -= len(content)
            kept.append(
                Message(
                    message["role"],
                    content,
                    provider_id=message.get("provider_id"),
                    model=message.get("model"),
                    # Reasoning state is tied to the model that wrote it (signatures,
                    # encrypted items): another model of the same provider gets none.
                    provider_state=message.get("provider_state") if message.get("model") == model else None,
                )
            )
        while kept and kept[-1].role != "user":  # an answer whose question did not fit
            kept.pop()
        return list(reversed(kept))

    def _request(
        self, messages: list[Message], plan: Plan, *, native: bool, allow_tools: bool
    ) -> ChatRequest:
        """One round's request. A native model always gets the tool list; the
        last round asks for an answer with tool_choice "none" (the adapter
        decides how its API takes that). A model without native tools gets
        the JSON fallback format instead, except in the last round."""
        params = {
            "think": self.settings.ollama_think,
            "keep_alive": self.settings.ollama_keep_alive,
            "num_ctx": self.settings.num_ctx,
            "temperature": 0.2,
            **plan.params,  # the user's per-provider settings (P4), validated by the API
        }
        if "reasoning" in plan.params:  # absent: every request as before
            params["think"] = bool(plan.params["reasoning"])  # Ollama's name for it
            if plan.params["reasoning"] and "max_output_tokens" not in plan.params:
                params["max_output_tokens"] = REASONING_MAX_OUTPUT
        return ChatRequest(
            model=plan.model,
            messages=tuple(messages),
            tools=tuple(self.registry.all_tools) if native else (),
            tool_choice="auto" if allow_tools else "none",
            json_schema=FALLBACK_FORMAT if allow_tools and not native else None,
            params=params,
        )

    async def run(self, turn: Turn) -> AsyncIterator[Event]:
        started = self.clock()
        chosen = {
            "provider": turn.provider_id or self.provider.id,
            "model": turn.model or self.settings.ollama_model,
        }
        yield "turn", {"turn_id": turn.turn_id, "conversation_id": turn.conversation_id, **chosen}
        if person_lookup(turn.message):
            yield "token", {"text": REFUSAL}
            self.chats.add_message(turn.conversation_id, "assistant", REFUSAL, meta={"refused": True})
            yield "done", {**chosen, "refused": True, "as_of": None, "citations": []}
            return
        plan = await self._plan(turn)
        if not isinstance(plan, Plan):
            yield "error", plan
            return
        over = self._over_budget(turn, plan)
        if over:
            yield "budget", over
            return
        native = plan.native
        # The map switch (D6): a non-local model gets the viewport and layers only when allowed.
        map_shared = plan.kind == "local" or self.map_context()
        system = system_prompt(
            now_local=self._now_local(),
            viewport=turn.viewport,
            layer_state=turn.layer_state,
            map_shared=map_shared,
        )
        if not native:
            system += _fallback_instructions(self.registry)
        messages: list[Message] = [
            Message("system", system),
            *self._history(turn.history, plan.budgets["history"], plan.chars_per_token, plan.model),
            Message("user", turn.message),
        ]
        limit = int(plan.input_limit * plan.chars_per_token)
        fixed = tools_chars(self.registry.all_tools) if native else 0
        sources = Sources()
        state: dict[str, Any] = {
            "web_chars": 0,
            "info": False,
            "budgets": plan.budgets,
            "density": plan.chars_per_token,
            "map_shared": map_shared,
        }
        answer: list[str] = []
        usage = Usage(0, 0)
        spent = [0, 0]  # every round is billed, not just the last
        stop = "stop"
        rounds = 0
        provider = plan.provider
        failure: ProviderError | None = None
        try:
            for rounds in range(1, MAX_TOOL_ROUNDS + 2):
                allow_tools = rounds <= MAX_TOOL_ROUNDS
                think = ThinkFilter()
                content, calls = "", []
                thought = 0
                billed = False
                provider_state: dict[str, Any] | None = None
                messages = fit(messages, limit, fixed)
                request = self._request(messages, plan, native=native, allow_tools=allow_tools)
                sent = sum(map(message_chars, request.messages)) + tools_chars(request.tools)
                events = stream_with_retries(
                    functools.partial(provider.stream, request), attempts=provider.max_attempts
                )
                async with aclosing(events):
                    async for event in events:
                        if isinstance(event, TextDelta):
                            piece = think.feed(event.text)
                            if piece:
                                content += piece
                                if native:
                                    yield "token", {"text": piece}
                            if len(content) > MAX_ROUND_CHARS:  # a runaway reply: stop paying for it
                                stop = "length"
                                break
                        elif isinstance(event, ThinkingDelta):
                            # Shown collapsed, never stored or replayed as text (D7).
                            thought += len(event.text)
                            if event.text:
                                yield "thinking", {"text": event.text}
                            if thought > MAX_ROUND_CHARS:
                                stop = "length"
                                break
                        elif isinstance(event, ToolCallEvent):
                            calls.append(event.call)
                        elif isinstance(event, Usage):
                            billed = True
                            usage = event
                            spent[0] += event.input
                            spent[1] += event.output
                            density = chars_per_token(sent, event.input)
                            if density:
                                self._density[(provider.id, plan.model)] = density
                        elif isinstance(event, Done):
                            provider_state = event.provider_state
                            stop = event.stop_reason
                if stop == "length" and not billed:
                    # Cut before its usage arrived: count an estimate, never nothing.
                    spent[0] += int(sent / plan.chars_per_token)
                    spent[1] += int((len(content) + thought) / plan.chars_per_token)
                if not native:
                    content, calls = _parse_fallback(content, rounds)
                    if content:
                        yield "token", {"text": content}
                answer.append(content)
                if not calls or not allow_tools:
                    break
                messages.append(
                    Message(
                        "assistant",
                        content,
                        tool_calls=tuple(calls),
                        provider_id=provider.id,
                        model=request.model,
                        provider_state=provider_state,
                    )
                )
                for call in calls:
                    result = ""
                    async for kind, data in self._run_tool(call.name, call.args, turn, sources, state):
                        if kind == "result":
                            result = data["text"]
                        else:
                            yield kind, data
                    messages.append(Message("tool", result, tool_call_id=call.id, name=call.name))
        except ProviderError as error:
            failure = error
        finally:
            # Every billed round counts, also when the turn failed, was stopped or
            # the browser went away (the generator is closed at a yield).
            self._record_usage(turn, plan, spent)
        if failure is not None:
            yield "error", _error_event(failure)
            return
        text = "".join(answer).strip()
        eval_count = usage.output
        eval_seconds = usage.output_seconds or 0
        as_of = self._now_local() if state["info"] else None
        done = {
            "model": plan.model,
            "provider": provider.id,
            "usage": {"input": spent[0], "output": spent[1]},
            "stop_reason": stop,
            "eval_count": eval_count,
            "prompt_eval_count": usage.input,
            "tokens_per_s": round(eval_count / eval_seconds, 1) if eval_seconds else None,
            "as_of": as_of,
            "citations": sources.items,
            "degraded": not native,
            "rounds": rounds,
            "seconds": round(self.clock() - started, 2),
        }
        self.chats.add_message(
            turn.conversation_id,
            "assistant",
            text,
            citations=sources.items,
            meta={k: done[k] for k in ("model", "as_of", "degraded", "tokens_per_s")},
            provider_id=provider.id,
            model=plan.model,
            provider_state=provider_state,  # e.g. DeepSeek reasoning, needed on later turns (D2)
        )
        yield "done", done

    def _over_budget(self, turn: Turn, plan: Plan) -> dict[str, int] | None:
        """The `budget` event when this conversation's cloud tokens reached the
        soft budget plus what Continue allowed (D10); None to go on."""
        budget = self.session_budget()
        if plan.kind != "cloud" or budget <= 0:
            return None
        spent = self.chats.usage_totals(turn.conversation_id)["cloud"]
        allowance = budget + self.chats.budget_extra(turn.conversation_id)
        return {"spent": spent, "allowance": allowance, "budget": budget} if spent >= allowance else None

    def _record_usage(self, turn: Turn, plan: Plan, spent: list[int]) -> None:
        if spent[0] or spent[1]:
            self.chats.record_usage(
                turn.conversation_id,
                provider_id=plan.provider.id,
                model=plan.model,
                kind=plan.kind,
                tokens_in=spent[0],
                tokens_out=spent[1],
            )

    # -- tools -----------------------------------------------------------------

    async def _run_tool(
        self, name: str, args: Any, turn: Turn, sources: Sources, state: dict[str, Any]
    ) -> AsyncIterator[Event]:
        started = time.monotonic()
        check = self.registry.check(name, args)
        url = args.get("url") if isinstance(args, dict) and name == "fetch_page" else None
        status = "ok"
        if not check.ok:
            status, text = "invalid", "error: " + "; ".join(check.errors)
            yield "tool_status", {"tool": name, "state": "error", "code": "invalid_arguments"}
        elif check.kind == "client":
            text, status = "", "ok"
            async for event in self._client_tool(name, args, turn, state.get("map_shared", True)):
                if event[0] == "result":
                    text, status = event[1]["text"], event[1]["status"]
                else:
                    yield event
        else:
            if name in INFO_TOOLS:
                state["info"] = True
            yield "tool_status", {"tool": name, "state": "start", "host": _host(url) if url else None}
            try:
                text, new_sources = await self._server_tool(name, args, turn, sources, state)
                for item in new_sources:
                    yield "citation", item
                yield "tool_status", {"tool": name, "state": "done"}
            except (SearchError, FetchError, BlockedURL) as error:
                status = getattr(error, "code", "error")
                text = f"error: {status}. Say that this source could not be used; do not guess."
                yield "tool_status", {"tool": name, "state": "error", "code": status}
        self.chats.log_tool(
            conversation_id=turn.conversation_id,
            tool=name,
            args=args if isinstance(args, dict) else {"raw": str(args)[:500]},
            status=status,
            duration_ms=int((time.monotonic() - started) * 1000),
            url=url,
        )
        yield "result", {"text": text}

    async def _client_tool(
        self, name: str, args: dict[str, Any], turn: Turn, map_shared: bool = True
    ) -> AsyncIterator[Event]:
        call_id = uuid.uuid4().hex[:12]
        future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self._pending[(turn.turn_id, call_id)] = future
        yield "tool_status", {"tool": name, "state": "start"}
        yield "client_tool", {"turn_id": turn.turn_id, "call_id": call_id, "name": name, "args": args}
        try:
            payload = await asyncio.wait_for(future, CLIENT_TOOL_TIMEOUT)
        except TimeoutError:
            yield "tool_status", {"tool": name, "state": "error", "code": "timeout"}
            yield "result", {"text": "error: the map did not answer in time", "status": "timeout"}
            return
        finally:
            self._pending.pop((turn.turn_id, call_id), None)
        ok = bool(payload.get("ok"))
        result = payload.get("result") if ok else {"error": payload.get("error")}
        if not map_shared:  # the map switch covers the camera a globe tool reports
            result = _without_view(result)
        body = json.dumps(result, ensure_ascii=False)
        yield "tool_status", {"tool": name, "state": "done" if ok else "error"}
        text = wrap_untrusted(f"globe:{name}", body[:MAX_CLIENT_RESULT_CHARS])
        yield "result", {"text": text if ok else f"error: {body[:500]}", "status": "ok" if ok else "failed"}

    async def _server_tool(
        self, name: str, args: dict[str, Any], turn: Turn, sources: Sources, state: dict[str, Any]
    ) -> tuple[str, list[dict[str, Any]]]:
        if name in ("viewport", "layer_state") and not state.get("map_shared", True):
            return MAP_WITHHELD, []
        if name == "viewport":
            return json.dumps(turn.viewport or {}, ensure_ascii=False)[:2000], []
        if name == "layer_state":
            return json.dumps(turn.layer_state or {}, ensure_ascii=False)[:2000], []
        if name in ("news_search", "news_near"):
            return self._news(name, args, sources)
        budget = int(state["budgets"]["web"] * state["density"]) - state["web_chars"]
        if budget <= 200:
            return "error: this turn's web reading budget is used up; answer from what you have.", []
        if name == "web_search":
            if person_lookup(args["query"]):
                return "error: refused, the query asks to locate or profile a person.", []
            results = await self.search.search(
                args["query"], args.get("recency", "any"), args.get("limit", 5)
            )
            if not results:
                return "No results.", []
            lines, new = [], []
            for result in results:
                number, fresh = sources.add(result.url, result.title, _host(result.url))
                if fresh:
                    new.append(sources.items[number - 1])
                dated = f" ({result.published})" if result.published else ""
                lines.append(f"[{number}] {result.title}{dated}\n{result.url}\n{result.snippet}")
            text = wrap_untrusted(f"web_search:{args['query'][:80]}", "\n\n".join(lines))[:budget] + CITE_HINT
            state["web_chars"] += len(text)
            return text, new
        if name == "fetch_page":
            limit = min(int(state["budgets"]["page"] * state["density"]), budget)
            page = await self.fetcher.fetch(args["url"], max_chars=limit)
            number, fresh = sources.add(page.url, page.title, _host(page.url))
            note = " (truncated)" if page.truncated else ""
            text = (
                wrap_untrusted(page.url, f"[{number}] {page.title or page.url}{note}\n{page.text}")
                + CITE_HINT
            )
            state["web_chars"] += len(text)
            return text, [sources.items[number - 1]] if fresh else []
        return f"error: {name} is not a server tool", []

    def _news(self, name: str, args: dict[str, Any], sources: Sources) -> tuple[str, list[dict[str, Any]]]:
        now = int(self.clock())
        since = now - int(args.get("since_hours", 72)) * 3600
        limit = int(args.get("limit", 6))
        if name == "news_near":
            radius = float(args.get("radius_km", 300))
            dlat = radius / 111.0
            dlon = min(180.0, radius / max(1.0, 111.0 * math.cos(math.radians(args["lat"]))))
            west, east = args["lon"] - dlon, args["lon"] + dlon
            west = west + 360 if west < -180 else west
            east = east - 360 if east > 180 else east
            query = NewsQuery(
                since=since,
                bbox=(west, max(-90.0, args["lat"] - dlat), east, min(90.0, args["lat"] + dlat)),
                min_geo_confidence=0.6,
                limit=limit,
                open_only=self.open_only(),
            )
            rows, _ = self.news.query(query)
        else:
            base = NewsQuery(
                q=args.get("query"),
                since=since,
                region=args.get("region"),
                categories=(args["category"],) if args.get("category") else (),
                limit=limit,
                open_only=self.open_only(),
            )
            rows, _ = self.news.query(base)
            if not rows and args.get("query"):
                rows, _ = self.news.query(NewsQuery(**{**base.__dict__, "any_term": True}))
        if not rows:
            return "No stories in the news store match.", []
        lines, new = [], []
        for row in rows:
            primary = (row.get("sources") or [{}])[0]
            outlet = primary.get("source_name") or primary.get("name") or _host(row["url"])
            number, fresh = sources.add(row["url"], row["title"], outlet)
            if fresh:
                new.append(sources.items[number - 1])
            place = f", {row['place_name']}" if row.get("place_name") else ""
            heading = f"[{number}] {row['title']} ({outlet}, {iso(row['published_at'])}{place})"
            lines.append(f"{heading}\n{row.get('summary') or ''}")
        return wrap_untrusted("news store", "\n\n".join(lines)) + CITE_HINT, new


def _error_event(error: ProviderError) -> dict[str, Any]:
    """The SSE error. Ollama keeps the `ollama_<code>` codes the panel knows;
    other providers send the taxonomy code (ADR-002 D7)."""
    code = f"ollama_{error.detail}" if error.provider == "ollama" and error.detail else error.code
    return {
        "code": code,
        "message": str(error),
        "provider": error.provider or None,
        "retryable": error.retryable,
    }


def _refusal(code: str, message: str, provider: ChatProvider) -> dict[str, Any]:
    return {"code": code, "message": message, "provider": provider.id, "retryable": False}


# -- constrained-JSON fallback (models without native tool calling) ----------

FALLBACK_FORMAT = {
    "type": "object",
    "properties": {
        "tool": {"type": "string"},
        "arguments": {"type": "object"},
        "answer": {"type": "string"},
    },
    "required": ["tool"],
}


def _fallback_instructions(registry: ToolRegistry) -> str:
    tools = [
        {"name": tool["function"]["name"], "parameters": tool["function"]["parameters"]}
        for tool in registry.all_tools
    ]
    return (
        "\n\nThis model has no native tool calling. Reply with one JSON object only: "
        '{"tool": "<tool name or none>", "arguments": {...}, "answer": "<text when tool is none>"}. '
        f"Tools: {json.dumps(tools, separators=(',', ':'))}"
    )


VIEW_KEYS = frozenset({"observer", "viewport", "cameraPosition"})


def _without_view(value: Any) -> Any:
    """A globe-tool result without the camera or observer position, which
    some tools fall back to when no place was given (D6 map switch)."""
    if isinstance(value, dict):
        return {k: _without_view(v) for k, v in value.items() if k not in VIEW_KEYS}
    if isinstance(value, list):
        return [_without_view(v) for v in value]
    return value


def _parse_fallback(content: str, round_number: int = 0) -> tuple[str, list[ToolCall]]:
    try:
        data = json.loads(content.strip())
    except ValueError:
        return content, []
    if not isinstance(data, dict):
        return content, []
    tool = data.get("tool")
    if tool and tool != "none":
        call_id = f"call_{round_number}"  # unique per round: providers pair results by id
        return "", [ToolCall(id=call_id, name=str(tool), args=normalize_args(data.get("arguments") or {}))]
    return str(data.get("answer") or ""), []
