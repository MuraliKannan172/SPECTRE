"""The one-time tool-calling probe (ADR-002 D3).

Anthropic, OpenAI, DeepSeek, NIM and custom servers publish no tools flag,
so a model they list starts as `unknown`. On its first turn, after consent,
one tiny prompt with a dummy tool settles it:

- the model calls the tool: `yes`, cached;
- the API rejects the tool request (`unsupported_feature`, a 400 about the
  feature): `no`, cached;
- the model answers in text instead: proof of nothing. The turn uses native
  tools (the API accepted them) and nothing is cached, so a later turn asks
  again.

Any other error (key, quota, network) is the turn's error.
"""

from __future__ import annotations

from contextlib import aclosing

from .providers import errors
from .providers.base import ChatProvider, ChatRequest, Message, Support, ToolCallEvent
from .providers.errors import ProviderError

PROBE_NAME = "spectre_probe"
PROBE_TOOL = {
    "type": "function",
    "function": {
        "name": PROBE_NAME,
        "description": "Confirms that tool calling works. Call it when asked to.",
        "parameters": {"type": "object", "properties": {"ok": {"type": "boolean"}}, "required": ["ok"]},
    },
}
PROBE_PROMPT = f"Call the {PROBE_NAME} tool with ok set to true. Do not reply with text."


async def probe_tools(provider: ChatProvider, model: str) -> Support | None:
    """`yes`, `no`, or None when the answer proves nothing."""
    request = ChatRequest(
        model,
        (Message("user", PROBE_PROMPT),),
        tools=(PROBE_TOOL,),
        params={"max_output_tokens": 512, "temperature": 0},
    )
    try:
        async with aclosing(provider.stream(request)) as events:
            async for event in events:
                if isinstance(event, ToolCallEvent):
                    return "yes" if event.call.name == PROBE_NAME else None
    except ProviderError as error:
        if error.code == errors.UNSUPPORTED_FEATURE:
            return "no"
        raise
    return None
