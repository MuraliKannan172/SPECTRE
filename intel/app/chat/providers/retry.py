"""One retry policy for every provider (ADR-002 D8).

A request is retried only when it failed before its first event: once text
has reached the panel, a retry would repeat it. Only retryable errors are
retried, after the provider's `Retry-After` when it gave one (up to
MAX_RETRY_AFTER; a longer wait fails now) or a jittered exponential backoff.
Closing the returned stream closes the provider's stream, so Stop and a
browser disconnect stop the upstream request too.
"""

from __future__ import annotations

import asyncio
import random
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import TypeVar

from .errors import ProviderError

T = TypeVar("T")

BASE_DELAY = 0.5
MAX_DELAY = 8.0
MAX_RETRY_AFTER = 30.0


def backoff(attempt: int, *, jitter: float) -> float:
    """Delay before retry `attempt` (1-based), with `jitter` in [0, 1)."""
    return min(MAX_DELAY, BASE_DELAY * 2 ** (attempt - 1)) * (0.5 + jitter / 2)


async def stream_with_retries(
    open_stream: Callable[[], AsyncIterator[T]],
    *,
    attempts: int,
    sleep: Callable[[float], Awaitable[object]] = asyncio.sleep,
    jitter: Callable[[], float] = random.random,
) -> AsyncIterator[T]:
    attempt = 0
    while True:
        attempt += 1
        stream = open_stream()
        started = False
        try:
            async for event in stream:
                started = True
                yield event
            return
        except ProviderError as error:
            if started or not error.retryable or attempt >= max(1, attempts):
                raise
            if error.retry_after is not None:
                if error.retry_after > MAX_RETRY_AFTER:
                    raise
                delay = error.retry_after
            else:
                delay = backoff(attempt, jitter=jitter())
        finally:
            close = getattr(stream, "aclose", None)
            if close is not None:
                await close()
        await sleep(delay)
