"""The provider contract (ADR-002 §3): one suite, run against every adapter.

Each adapter gets a harness that scripts its upstream: the mock provider
directly, Ollama through a fake server speaking its NDJSON wire format (no
network). P3 adds a harness per cloud adapter. Scenarios that a provider's
wire format cannot express are skipped with the reason.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest
from fakes_anthropic import AnthropicHarness
from fakes_openai_chat import OpenAIChatHarness
from fakes_openai_responses import ResponsesHarness
from sse import CANARY

from app.chat.ollama import OllamaClient
from app.chat.providers import errors
from app.chat.providers.base import (
    ChatRequest,
    Done,
    Message,
    ModelInfo,
    TextDelta,
    ToolCall,
    ToolCallEvent,
    Usage,
)
from app.chat.providers.errors import ProviderError, code_for_status, retry_after_seconds
from app.chat.providers.mock import MockProvider
from app.chat.providers.ollama import OllamaProvider
from app.chat.providers.retry import stream_with_retries

TOOL = {
    "type": "function",
    "function": {
        "name": "lookup",
        "description": "Look something up.",
        "parameters": {"type": "object", "properties": {"q": {"type": "string"}}},
    },
}


def request(*messages: Message, **kwargs: Any) -> ChatRequest:
    return ChatRequest(model="m", messages=messages or (Message("user", "hi"),), tools=(TOOL,), **kwargs)


# -- harnesses -------------------------------------------------------------------


class MockHarness:
    """The reference: scripts canonical events directly."""

    name = "mock"
    unsupported: dict[str, str] = {
        "unknown_event": "the mock emits canonical events only",
        "key": "the mock takes no API key",
    }

    def __init__(self) -> None:
        self.provider = MockProvider(models=[ModelInfo("m", "m", "local", "yes")])
        self.scripts = self.provider.scripts

    def answer(self, *chunks: str) -> None:
        self.scripts.append([*map(TextDelta, chunks), Usage(3, len(chunks)), Done("stop")])

    def tool_calls(self, *calls: tuple[str, dict[str, Any]]) -> None:
        events = [ToolCallEvent(ToolCall(f"call_{n}", name, args)) for n, (name, args) in enumerate(calls)]
        self.scripts.append([*events, Usage(3, 1), Done("tool_calls")])

    def fail(self, status: int, headers: dict[str, str] | None = None) -> None:
        retry_after = retry_after_seconds((headers or {}).get("Retry-After"))
        self.scripts.append([ProviderError(code_for_status(status), retry_after=retry_after, status=status)])

    def fail_context(self) -> None:
        self.scripts.append([ProviderError(errors.CONTEXT_TOO_LONG)])

    def answer_with_unknown_event(self, text: str) -> None:  # pragma: no cover - skipped
        raise NotImplementedError

    def long_answer(self, chunks: int) -> None:
        self.answer(*(f"t{n} " for n in range(chunks)))

    @property
    def upstream_requests(self) -> int:
        return self.provider.opened

    @property
    def upstream_closed(self) -> bool:
        return self.provider.closed_early > 0

    def sent_tool_results(self) -> list[tuple[str, str]]:
        messages = self.provider.requests[-1].messages
        return [(m.name or "", m.content) for m in messages if m.role == "tool"]


class _ClosableStream(httpx.AsyncByteStream):
    def __init__(self, lines: list[bytes], harness: OllamaHarness) -> None:
        self.lines = lines
        self.harness = harness

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for line in self.lines:
            yield line
            await asyncio.sleep(0)
        self.harness.completed += 1

    async def aclose(self) -> None:
        # httpx closes every response stream, also after reading it all: an
        # abort is a close before the last line was read.
        if not self.harness.completed:
            self.harness.closed += 1


class OllamaHarness:
    """A fake Ollama server: /api/tags, /api/show and a scripted /api/chat."""

    name = "ollama"
    unsupported = {
        "context_too_long": "Ollama documents no context-length error (ADR-002 §1.4)",
        "key": "Ollama takes no API key",
    }

    def __init__(self) -> None:
        self.replies: list[tuple[int, dict[str, str], list[dict[str, Any]]]] = []
        self.bodies: list[dict[str, Any]] = []
        self.closed = 0
        self.completed = 0
        client = httpx.AsyncClient(transport=httpx.MockTransport(self.handle))
        self.provider = OllamaProvider(OllamaClient("http://127.0.0.1:11434", client))

    def handle(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/tags":
            return httpx.Response(
                200, json={"models": [{"name": "m", "capabilities": ["completion", "tools"]}]}
            )
        if request.url.path == "/api/show":
            return httpx.Response(200, json={"capabilities": ["completion", "tools"]})
        self.bodies.append(json.loads(request.content))
        status, headers, chunks = self.replies.pop(0)
        if status != 200:
            return httpx.Response(status, headers=headers, json={"error": "scripted"})
        lines = [(json.dumps(chunk) + "\n").encode() for chunk in chunks]
        return httpx.Response(200, stream=_ClosableStream(lines, self))

    @staticmethod
    def _done(**extra: Any) -> dict[str, Any]:
        return {
            "message": {"role": "assistant", "content": ""},
            "done": True,
            "done_reason": "stop",
            "prompt_eval_count": 3,
            "eval_count": 2,
            "eval_duration": 10**9,
            **extra,
        }

    def answer(self, *chunks: str) -> None:
        body = [{"message": {"role": "assistant", "content": text}, "done": False} for text in chunks]
        self.replies.append((200, {}, [*body, self._done()]))

    def tool_calls(self, *calls: tuple[str, dict[str, Any]]) -> None:
        # Ollama may send calls across chunks: one per chunk here.
        body = [
            {
                "message": {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [{"function": {"name": n, "arguments": a}}],
                }
            }
            for n, a in calls
        ]
        self.replies.append((200, {}, [*body, self._done()]))

    def fail(self, status: int, headers: dict[str, str] | None = None) -> None:
        self.replies.append((status, headers or {}, []))

    def fail_context(self) -> None:  # pragma: no cover - skipped
        raise NotImplementedError

    def answer_with_unknown_event(self, text: str) -> None:
        unknown = {"message": {"role": "assistant", "content": "", "future_field": {"x": 1}}, "telemetry": 7}
        body = [unknown, {"message": {"role": "assistant", "content": text}, "done": False}]
        self.replies.append((200, {}, [*body, self._done()]))

    def long_answer(self, chunks: int) -> None:
        self.answer(*(f"t{n} " for n in range(chunks)))

    @property
    def upstream_requests(self) -> int:
        return len(self.bodies)

    @property
    def upstream_closed(self) -> bool:
        return self.closed > 0

    def sent_tool_results(self) -> list[tuple[str, str]]:
        messages = self.bodies[-1]["messages"]
        return [(m["tool_name"], m["content"]) for m in messages if m["role"] == "tool"]


HARNESSES = [MockHarness, OllamaHarness, OpenAIChatHarness, AnthropicHarness, ResponsesHarness]


@pytest.fixture(params=HARNESSES, ids=lambda cls: cls.name)
def harness(request: pytest.FixtureRequest) -> Any:
    return request.param()


def skip_unsupported(harness: Any, scenario: str) -> None:
    if scenario in harness.unsupported:
        pytest.skip(f"{harness.name}: {harness.unsupported[scenario]}")


def collect(harness: Any, chat: ChatRequest, *, attempts: int = 1) -> list[Any]:
    async def go() -> list[Any]:
        stream = stream_with_retries(
            lambda: harness.provider.stream(chat), attempts=attempts, sleep=_no_sleep
        )
        return [event async for event in stream]

    return asyncio.run(go())


async def _no_sleep(_: float) -> None:
    return None


# -- scenarios -------------------------------------------------------------------


def test_lists_models_as_canonical_model_info(harness: Any) -> None:
    models = asyncio.run(harness.provider.list_models())
    assert models and all(isinstance(model, ModelInfo) for model in models)
    for model in models:
        assert model.kind in ("local", "remote", "cloud")
        assert model.supports_tools in ("yes", "no", "unknown")


def test_a_plain_answer_streams_text_then_usage_then_done(harness: Any) -> None:
    harness.answer("Hel", "lo.")
    events = collect(harness, request())
    assert "".join(e.text for e in events if isinstance(e, TextDelta)) == "Hello."
    assert not [e for e in events if isinstance(e, ToolCallEvent)]
    assert isinstance(events[-1], Done) and isinstance(events[-2], Usage)
    assert events[-2].input > 0 and events[-2].output > 0


def test_a_parallel_tool_round_trip(harness: Any) -> None:
    harness.tool_calls(("lookup", {"q": "a"}), ("lookup", {"q": "b"}))
    events = collect(harness, request())
    calls = [e.call for e in events if isinstance(e, ToolCallEvent)]
    assert [(c.name, c.args) for c in calls] == [("lookup", {"q": "a"}), ("lookup", {"q": "b"})]
    assert len({c.id for c in calls}) == 2, "every call of a round has its own id"
    done = events[-1]
    assert isinstance(done, Done)
    follow_up = request(
        Message("user", "hi"),
        Message(
            "assistant",
            "",
            tool_calls=tuple(calls),
            provider_id=harness.provider.id,
            provider_state=done.provider_state,
        ),
        Message("tool", "A", tool_call_id=calls[0].id, name="lookup"),
        Message("tool", "B", tool_call_id=calls[1].id, name="lookup"),
    )
    harness.answer("Both done.")
    events = collect(harness, follow_up)
    assert harness.sent_tool_results() == [("lookup", "A"), ("lookup", "B")]
    assert "".join(e.text for e in events if isinstance(e, TextDelta)) == "Both done."


def test_aborting_mid_stream_closes_the_upstream_request(harness: Any) -> None:
    harness.long_answer(50)

    async def go() -> None:
        stream = stream_with_retries(lambda: harness.provider.stream(request()), attempts=1)
        assert isinstance(await anext(stream), TextDelta)
        await stream.aclose()

    asyncio.run(go())
    assert harness.upstream_closed


def test_401_is_auth_failed_and_never_retried(harness: Any) -> None:
    harness.fail(401)
    harness.answer("unreached")
    with pytest.raises(ProviderError) as raised:
        collect(harness, request(), attempts=3)
    assert raised.value.code == errors.AUTH_FAILED and not raised.value.retryable
    assert harness.upstream_requests == 1


def test_a_rejected_key_reaches_no_log_and_no_error_text(
    harness: Any, caplog: pytest.LogCaptureFixture
) -> None:
    skip_unsupported(harness, "key")
    caplog.set_level(logging.DEBUG)  # the SDKs log request details at debug level
    harness.fail_echoing_key(401)
    with pytest.raises(ProviderError) as raised:
        collect(harness, request(), attempts=3)
    error = raised.value
    assert error.code == errors.AUTH_FAILED and harness.upstream_requests == 1
    assert CANARY not in f"{error} {error.detail}" and CANARY not in caplog.text
    assert error.__cause__ is None and error.__context__ is None, "no link back to the SDK exception"


def test_429_honours_retry_after_and_then_succeeds(harness: Any) -> None:
    harness.fail(429, {"Retry-After": "2"})
    harness.answer("Second try.")
    slept: list[float] = []

    async def sleep(seconds: float) -> None:
        slept.append(seconds)

    async def go() -> list[Any]:
        stream = stream_with_retries(lambda: harness.provider.stream(request()), attempts=3, sleep=sleep)
        return [event async for event in stream]

    events = asyncio.run(go())
    assert slept == [2.0] and harness.upstream_requests == 2
    assert "".join(e.text for e in events if isinstance(e, TextDelta)) == "Second try."


def test_context_too_long_is_its_own_code(harness: Any) -> None:
    skip_unsupported(harness, "context_too_long")
    harness.fail_context()
    with pytest.raises(ProviderError) as raised:
        collect(harness, request(), attempts=3)
    assert raised.value.code == errors.CONTEXT_TOO_LONG and not raised.value.retryable


def test_unknown_stream_events_are_ignored(harness: Any) -> None:
    skip_unsupported(harness, "unknown_event")
    harness.answer_with_unknown_event("Still fine.")
    events = collect(harness, request())
    assert "".join(e.text for e in events if isinstance(e, TextDelta)) == "Still fine."


# -- Ollama-specific (ADR-002 §1.3, D3) -------------------------------------------


def test_ollama_lists_chat_models_and_badges_cloud_ones() -> None:
    tags = {
        "models": [
            {
                "name": "qwen:9b",
                "capabilities": ["completion", "tools"],
                "details": {"context_length": 262144},
            },
            {"name": "embed:1", "capabilities": ["embedding"]},
            {"name": "omni:1", "capabilities": ["decision", "vision"]},
            {
                "name": "big:cloud",
                "capabilities": ["completion", "tools"],
                "remote_host": "https://ollama.com",
            },
            {"name": "old:1"},
        ]
    }
    client = httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200, json=tags)))
    models = {
        m.id: m for m in asyncio.run(OllamaProvider(OllamaClient("http://127.0.0.1:1", client)).list_models())
    }
    assert set(models) == {"qwen:9b", "big:cloud", "old:1"}
    assert (models["qwen:9b"].kind, models["qwen:9b"].supports_tools) == ("local", "yes")
    assert models["qwen:9b"].context_window == 262144
    assert models["big:cloud"].kind == "cloud"
    assert models["old:1"].supports_tools == "unknown"


def test_ollama_model_caps_finds_cloud_models_in_tags_not_show() -> None:
    # Shapes recorded from Ollama 0.40.13: /api/show has no remote_host.
    tags = {
        "models": [
            {"name": "beam:cloud", "model": "beam:cloud", "remote_host": "https://ollama.com"},
            {"name": "qwen:latest", "model": "qwen:latest"},
        ]
    }
    shown = {"capabilities": ["completion", "thinking", "tools"], "details": {}, "model_info": {}}

    def handle(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=tags if request.url.path == "/api/tags" else shown)

    provider = OllamaProvider(
        OllamaClient("http://127.0.0.1:1", httpx.AsyncClient(transport=httpx.MockTransport(handle)))
    )
    cloud = asyncio.run(provider.model_caps("beam:cloud"))
    local = asyncio.run(provider.model_caps("qwen"))
    assert (cloud.kind, cloud.details["remote_host"]) == ("cloud", "https://ollama.com")
    assert local.kind == "local" and "remote_host" not in local.details


def test_ollama_answers_without_tools_when_asked_for_an_answer() -> None:
    harness = OllamaHarness()
    harness.answer("Final.")
    collect(harness, request(tool_choice="none"))
    assert "tools" not in harness.bodies[-1]
    harness.answer("Again.")
    collect(harness, request())
    assert harness.bodies[-1]["tools"] == [TOOL]


def test_ollama_replays_its_own_tool_calls_unchanged() -> None:
    harness = OllamaHarness()
    raw = [{"function": {"name": "lookup", "arguments": {"q": "a"}, "index": 0}, "id": "x"}]
    call = ToolCall("call_0", "lookup", {"q": "a"})
    mine = Message(
        "assistant", "", tool_calls=(call,), provider_id="ollama", provider_state={"tool_calls": raw}
    )
    other = Message(
        "assistant", "", tool_calls=(call,), provider_id="mock", provider_state={"tool_calls": raw}
    )
    for message, expected in (
        (mine, raw),
        (other, [{"function": {"name": "lookup", "arguments": {"q": "a"}}}]),
    ):
        harness.answer("ok")
        collect(harness, request(Message("user", "hi"), message))
        assert harness.bodies[-1]["messages"][-1]["tool_calls"] == expected
