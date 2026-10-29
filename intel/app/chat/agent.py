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
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

from ..config import Settings
from ..schema import iso
from ..store.chat import ChatStore
from ..store.news import NewsQuery, NewsStore
from ..web.fetch import FetchError, PageFetcher
from ..web.guard import BlockedURL
from ..web.search import SearchError, SearchService
from .ollama import OllamaClient
from .policy import REFUSAL, person_lookup, system_prompt, wrap_untrusted
from .providers.base import (
    ChatProvider,
    ChatRequest,
    Done,
    Message,
    TextDelta,
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
CLIENT_TOOL_TIMEOUT = 15.0
CHARS_PER_TOKEN = 4
MAX_CLIENT_RESULT_CHARS = 4000
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
    ) -> None:
        self.settings = settings
        # The status route and the eval still read Ollama directly.
        self.ollama = ollama
        self.provider = provider or OllamaProvider(ollama)
        self.news = news
        self.chats = chats
        self.search = search
        self.fetcher = fetcher
        self.registry = registry
        self.open_only = open_only
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

    # -- the turn --------------------------------------------------------------

    def _now_local(self) -> str:
        return dt.datetime.fromtimestamp(self.clock()).astimezone().strftime("%Y-%m-%d %H:%M %Z")

    def _history(self, history: list[dict[str, Any]]) -> list[Message]:
        budget = self.settings.budgets["history"] * CHARS_PER_TOKEN
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
                )
            )
        return list(reversed(kept))

    def _request(self, messages: list[Message], *, native: bool, allow_tools: bool) -> ChatRequest:
        """One round's request. A native model always gets the tool list; the
        last round asks for an answer with tool_choice "none" (the adapter
        decides how its API takes that). A model without native tools gets
        the JSON fallback format instead, except in the last round."""
        return ChatRequest(
            model=self.settings.ollama_model,
            messages=tuple(messages),
            tools=tuple(self.registry.all_tools) if native else (),
            tool_choice="auto" if allow_tools else "none",
            json_schema=FALLBACK_FORMAT if allow_tools and not native else None,
            params={
                "think": self.settings.ollama_think,
                "keep_alive": self.settings.ollama_keep_alive,
                "num_ctx": self.settings.num_ctx,
                "temperature": 0.2,
            },
        )

    async def run(self, turn: Turn) -> AsyncIterator[Event]:
        started = self.clock()
        yield "turn", {"turn_id": turn.turn_id, "conversation_id": turn.conversation_id}
        if person_lookup(turn.message):
            yield "token", {"text": REFUSAL}
            self.chats.add_message(turn.conversation_id, "assistant", REFUSAL, meta={"refused": True})
            yield (
                "done",
                {"model": self.settings.ollama_model, "refused": True, "as_of": None, "citations": []},
            )
            return
        try:
            capabilities = await self.capabilities()
        except ProviderError as error:
            yield "error", _error_event(error)
            return
        native = "tools" in capabilities
        system = system_prompt(
            now_local=self._now_local(), viewport=turn.viewport, layer_state=turn.layer_state
        )
        if not native:
            system += _fallback_instructions(self.registry)
        messages: list[Message] = [
            Message("system", system),
            *self._history(turn.history),
            Message("user", turn.message),
        ]
        sources = Sources()
        state = {"web_chars": 0, "info": False}
        answer: list[str] = []
        usage = Usage(0, 0)
        rounds = 0
        provider = self.provider
        try:
            for rounds in range(1, MAX_TOOL_ROUNDS + 2):
                allow_tools = rounds <= MAX_TOOL_ROUNDS
                think = ThinkFilter()
                content, calls = "", []
                provider_state: dict[str, Any] | None = None
                request = self._request(messages, native=native, allow_tools=allow_tools)
                events = stream_with_retries(
                    functools.partial(provider.stream, request), attempts=provider.max_attempts
                )
                async for event in events:
                    if isinstance(event, TextDelta):
                        piece = think.feed(event.text)
                        if piece:
                            content += piece
                            if native:
                                yield "token", {"text": piece}
                    elif isinstance(event, ToolCallEvent):
                        calls.append(event.call)
                    elif isinstance(event, Usage):
                        usage = event
                    elif isinstance(event, Done):
                        provider_state = event.provider_state
                if not native:
                    content, calls = _parse_fallback(content)
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
            yield "error", _error_event(error)
            return
        text = "".join(answer).strip()
        eval_count = usage.output
        eval_seconds = usage.output_seconds or 0
        as_of = self._now_local() if state["info"] else None
        done = {
            "model": self.settings.ollama_model,
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
            model=self.settings.ollama_model,
        )
        yield "done", done

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
            async for event in self._client_tool(name, args, turn):
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

    async def _client_tool(self, name: str, args: dict[str, Any], turn: Turn) -> AsyncIterator[Event]:
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
        body = json.dumps(
            payload.get("result") if ok else {"error": payload.get("error")}, ensure_ascii=False
        )
        yield "tool_status", {"tool": name, "state": "done" if ok else "error"}
        text = wrap_untrusted(f"globe:{name}", body[:MAX_CLIENT_RESULT_CHARS])
        yield "result", {"text": text if ok else f"error: {body[:500]}", "status": "ok" if ok else "failed"}

    async def _server_tool(
        self, name: str, args: dict[str, Any], turn: Turn, sources: Sources, state: dict[str, Any]
    ) -> tuple[str, list[dict[str, Any]]]:
        if name == "viewport":
            return json.dumps(turn.viewport or {}, ensure_ascii=False)[:2000], []
        if name == "layer_state":
            return json.dumps(turn.layer_state or {}, ensure_ascii=False)[:2000], []
        if name in ("news_search", "news_near"):
            return self._news(name, args, sources)
        budget = self.settings.budgets["web"] * CHARS_PER_TOKEN - state["web_chars"]
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
            limit = min(self.settings.budgets["page"] * CHARS_PER_TOKEN, budget)
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
    return {"code": code, "message": str(error)}


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


def _parse_fallback(content: str) -> tuple[str, list[ToolCall]]:
    try:
        data = json.loads(content.strip())
    except ValueError:
        return content, []
    if not isinstance(data, dict):
        return content, []
    tool = data.get("tool")
    if tool and tool != "none":
        return "", [ToolCall(id="call_0", name=str(tool), args=normalize_args(data.get("arguments") or {}))]
    return str(data.get("answer") or ""), []
