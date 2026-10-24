"""In-process fan-out of new-story events to SSE subscribers."""

from __future__ import annotations

import asyncio
from typing import Any

LAGGED = {"type": "lagged"}


class EventHub:
    """Each subscriber gets a bounded queue.

    A subscriber that falls a whole queue behind is not allowed to slow the
    others or grow memory: its queue is cleared and it receives LAGGED, which
    ends its stream. The client reconnects with Last-Event-ID and replays the
    gap from the store.
    """

    def __init__(self, max_queue: int = 256) -> None:
        self._max_queue = max_queue
        self._subscribers: set[asyncio.Queue[dict[str, Any]]] = set()

    def __len__(self) -> int:
        return len(self._subscribers)

    def subscribe(self) -> asyncio.Queue[dict[str, Any]]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(self._max_queue)
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[dict[str, Any]]) -> None:
        self._subscribers.discard(queue)

    def publish(self, event: dict[str, Any]) -> None:
        for queue in list(self._subscribers):
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                self._subscribers.discard(queue)
                while not queue.empty():
                    queue.get_nowait()
                queue.put_nowait(LAGGED)
