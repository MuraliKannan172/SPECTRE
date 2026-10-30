"""A fake OpenAI-compatible Chat Completions server (OpenRouter's flavour by
default), from the wire facts in ADR-002 §1.4: `data:` chunks, tool-call
deltas by index with id and name in the first one, usage in the last chunk."""

from __future__ import annotations

import json
from typing import Any

from sse import CANARY, Reply, Upstream, data_frames, fake_server

from app.chat.providers.openai_chat import OpenAIChatProvider
from app.chat.providers.registry import ProviderSpec

SPECS = {
    "openrouter": ProviderSpec(
        "openrouter",
        "OpenRouter",
        "openai_compat",
        "cloud",
        "https://openrouter.ai/api/v1",
        ("OPENROUTER_API_KEY",),
    ),
    "deepseek": ProviderSpec(
        "deepseek", "DeepSeek", "openai_compat", "cloud", "https://api.deepseek.com", ("DEEPSEEK_API_KEY",)
    ),
    "nvidia": ProviderSpec(
        "nvidia",
        "NVIDIA NIM",
        "openai_compat",
        "cloud",
        "https://integrate.api.nvidia.com/v1",
        ("NVIDIA_API_KEY",),
    ),
    "openai": ProviderSpec(
        "openai", "ChatGPT", "openai", "cloud", "https://api.openai.com/v1", ("OPENAI_API_KEY",)
    ),
    "custom": ProviderSpec(
        "custom",
        "Custom",
        "openai_compat",
        "local",
        "http://127.0.0.1:1234/v1",
        ("SPECTRE_CUSTOM_API_KEY",),
        key_optional=True,
    ),
}

MODELS = {
    "object": "list",
    "data": [
        {
            "id": "m",
            "name": "Model M",
            "context_length": 131072,
            "supported_parameters": ["tools", "temperature"],
            "architecture": {"input_modalities": ["text", "image"]},
            "pricing": {"prompt": "0.000001", "completion": "0.000002"},
        },
        {"id": "plain", "supported_parameters": ["temperature"]},
        {"id": "json-ok", "supported_parameters": ["temperature", "response_format"]},
        {"id": "text-embedding-3", "supported_parameters": []},
    ],
}


def chunk(delta: dict[str, Any] | None = None, finish: str | None = None, **extra: Any) -> dict[str, Any]:
    choices = [] if delta is None else [{"index": 0, "delta": delta, "finish_reason": finish}]
    return {
        "id": "c",
        "object": "chat.completion.chunk",
        "created": 1,
        "model": "m",
        "choices": choices,
        **extra,
    }


USAGE = chunk(None, usage={"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5})


class OpenAIChatHarness:
    name = "openai_chat"
    unsupported: dict[str, str] = {}

    def __init__(
        self, provider_id: str = "openrouter", *, key: str | None = CANARY, base_url: str | None = None
    ) -> None:
        self.upstream = Upstream()
        self.replies: list[Reply] = []
        self.http = fake_server(self.upstream, self.replies, lambda: MODELS)
        spec = SPECS[provider_id]
        self.provider = OpenAIChatProvider(spec, base_url or spec.base_url, lambda: key, http=self.http)

    def stream(self, *payloads: dict[str, Any] | str) -> None:
        self.replies.append((200, {}, data_frames(*payloads)))

    def answer(self, *chunks: str) -> None:
        body = [chunk({"role": "assistant", "content": text}) for text in chunks]
        self.stream(*body, chunk({}, "stop"), USAGE)

    def tool_calls(self, *calls: tuple[str, dict[str, Any]]) -> None:
        body = []
        for index, (name, args) in enumerate(calls):
            text = json.dumps(args)
            first = {"index": index, "id": f"call_{name}_{index}", "type": "function"}
            body.append(chunk({"tool_calls": [{**first, "function": {"name": name, "arguments": text[:3]}}]}))
            body.append(chunk({"tool_calls": [{"index": index, "function": {"arguments": text[3:]}}]}))
        self.stream(*body, chunk({}, "tool_calls"), USAGE)

    def fail(self, status: int, headers: dict[str, str] | None = None) -> None:
        self.replies.append((status, headers or {}, {"error": {"code": status, "message": "scripted"}}))

    def fail_echoing_key(self, status: int) -> None:
        message = f"Incorrect API key provided: {CANARY}."
        self.replies.append((status, {}, {"error": {"code": "invalid_api_key", "message": message}}))

    def fail_context(self) -> None:
        error = {"code": "context_length_exceeded", "message": "This model's maximum context length is 8192."}
        self.replies.append((400, {}, {"error": error}))

    def answer_with_unknown_event(self, text: str) -> None:
        self.stream(
            ": OPENROUTER PROCESSING\n\n",
            chunk({"role": "assistant", "content": ""}, future_field={"x": 1}),
            chunk({"content": text, "annotations_v9": []}),
            chunk({}, "stop"),
            USAGE,
        )

    def long_answer(self, chunks: int) -> None:
        self.answer(*(f"t{n} " for n in range(chunks)))

    @property
    def upstream_requests(self) -> int:
        return len(self.upstream.bodies)

    @property
    def upstream_closed(self) -> bool:
        return self.upstream.closed_early > 0

    def sent_tool_results(self) -> list[tuple[str, str]]:
        messages = self.upstream.bodies[-1]["messages"]
        names = {
            call["id"]: call["function"]["name"]
            for message in messages
            for call in message.get("tool_calls") or []
        }
        return [(names[m["tool_call_id"]], m["content"]) for m in messages if m["role"] == "tool"]
