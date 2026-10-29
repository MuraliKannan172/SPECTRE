"""A scripted provider (ADR-002 P1): the reference implementation the
contract suite checks every adapter against, and a stand-in for the agent's
tests. Each `stream()` call plays the next script; a `ProviderError` in a
script is raised at that point."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Sequence
from typing import Any

from .base import ChatRequest, Kind, ModelInfo, StreamEvent
from .errors import ProviderError

Script = Sequence[StreamEvent | ProviderError]


class MockProvider:
    id = "mock"
    kind: Kind = "local"

    def __init__(
        self,
        scripts: Sequence[Script] = (),
        *,
        models: Sequence[ModelInfo] = (),
        max_attempts: int = 3,
    ) -> None:
        self.scripts = list(scripts)
        self.models = list(models)
        self.max_attempts = max_attempts
        self.requests: list[ChatRequest] = []
        self.opened = 0
        self.closed_early = 0

    async def list_models(self) -> list[ModelInfo]:
        return list(self.models)

    async def model_caps(self, model: str) -> ModelInfo:
        for info in self.models:
            if info.id == model:
                return info
        raise ProviderError("model_not_found", model, provider=self.id)

    async def test(self) -> dict[str, Any]:
        return {"ok": True}

    async def stream(self, request: ChatRequest) -> AsyncIterator[StreamEvent]:
        self.requests.append(request)
        self.opened += 1
        script = list(self.scripts.pop(0)) if self.scripts else []
        try:
            for item in script:
                if isinstance(item, ProviderError):
                    raise item
                yield item
                await asyncio.sleep(0)
        except GeneratorExit:
            self.closed_early += 1
            raise
