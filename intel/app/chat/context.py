"""The context budget (ADR-002 D9).

What a round sends must fit the model's input limit. Over the limit, the
oldest tool results shrink to a stub first (a call never loses its result:
Anthropic and OpenAI reject an unanswered call), then the oldest history goes.
The system prompt, the question and the latest round's results always stay.

Sizes are estimated in characters: 4 per token until the provider's reported
usage shows a denser tokenizer. The estimate only ever tightens, because a
prompt Ollama reads from its cache, or Anthropic from a cache, reports fewer
tokens than it holds.
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from dataclasses import replace
from typing import Any

from .providers.base import Message

CHARS_PER_TOKEN = 4.0
MIN_CHARS_PER_TOKEN = 1.5
# Ollama sets no output cap, so the window keeps this much room for the answer.
OLLAMA_OUTPUT_RESERVE = 1024
TRIMMED = "[trimmed: an earlier tool result, removed to fit the context budget]"


def message_chars(message: Message) -> int:
    return len(message.content) + sum(
        len(call.name) + len(json.dumps(call.args, ensure_ascii=False)) for call in message.tool_calls
    )


def tools_chars(tools: Iterable[dict[str, Any]]) -> int:
    tools = list(tools)
    return len(json.dumps(tools, ensure_ascii=False)) if tools else 0


def chars_per_token(sent_chars: int, input_tokens: int) -> float | None:
    """The estimate a reported input count supports, between the floor and 4;
    None when the provider reported nothing."""
    if input_tokens <= 0:
        return None
    return max(MIN_CHARS_PER_TOKEN, min(CHARS_PER_TOKEN, sent_chars / input_tokens))


def fit(messages: list[Message], limit: int, fixed: int = 0) -> list[Message]:
    """The messages trimmed to `limit` characters, `fixed` (the tool
    definitions) included; the same list when they already fit."""
    total = fixed + sum(message_chars(message) for message in messages)
    if total <= limit:
        return messages
    out = list(messages)
    question = max(i for i, message in enumerate(out) if message.role == "user")
    latest = max(
        (i for i, message in enumerate(out) if i > question and message.tool_calls),
        default=len(out),
    )
    for i in range(question + 1, latest):
        if total <= limit:
            break
        message = out[i]
        if message.role == "tool" and len(message.content) > len(TRIMMED):
            total -= len(message.content) - len(TRIMMED)
            out[i] = replace(message, content=TRIMMED)
    first = 1 if out[0].role == "system" else 0
    while total > limit and question > first:
        total -= message_chars(out.pop(first))
        question -= 1
    while question > first and out[first].role != "user":  # history starts with a question
        out.pop(first)
        question -= 1
    return out
