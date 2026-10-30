"""The adapters `providers.default.yaml` can name (ADR-002 D1), built with the
shared HTTP client and getters for the settings that may change while the
service runs (so a new key, workspace or model list applies at once)."""

from __future__ import annotations

from collections.abc import Callable
from functools import partial

import httpx2

from .anthropic_messages import AnthropicProvider
from .openai_chat import OpenAIChatProvider
from .openai_responses import OpenAIResponsesProvider
from .registry import Factory


def api_factories(
    http: httpx2.AsyncClient,
    *,
    workspace_for: Callable[[str], str | None],
    chat_models_for: Callable[[str], frozenset[str]],
) -> dict[str, Factory]:
    return {
        "openai_compat": lambda spec, url, key: OpenAIChatProvider(spec, url, key, http=http),
        "anthropic": lambda spec, url, key: AnthropicProvider(
            spec, url, key, http=http, workspace=partial(workspace_for, spec.id)
        ),
        "openai": lambda spec, url, key: OpenAIResponsesProvider(
            spec, url, key, http=http, chat_models=partial(chat_models_for, spec.id)
        ),
    }
