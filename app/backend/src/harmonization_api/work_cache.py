"""Bounded result cache and shared work, without blocking HTTP worker threads."""
from __future__ import annotations

import asyncio
import threading
import time
from collections import OrderedDict
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Any, Callable


class WorkCache:
    def __init__(self, *, workers: int, capacity: int, ttl: float, name: str):
        self.executor = ThreadPoolExecutor(max_workers=workers, thread_name_prefix=name)
        self.capacity = capacity
        self.ttl = ttl
        self.lock = threading.RLock()
        self.results: OrderedDict[tuple, tuple[float, Any]] = OrderedDict()
        self.pending: dict[tuple, Future] = {}

    def submit(self, key: tuple, build: Callable[[], Any]) -> Future:
        with self.lock:
            cached = self.results.get(key)
            if cached and time.monotonic() - cached[0] < self.ttl:
                self.results.move_to_end(key)
                ready = Future()
                ready.set_result(cached[1])
                return ready
            self.results.pop(key, None)
            if key in self.pending:
                return self.pending[key]
            future = self.executor.submit(build)
            self.pending[key] = future
            future.add_done_callback(lambda done: self._complete(key, done))
            return future

    def _complete(self, key: tuple, future: Future) -> None:
        with self.lock:
            self.pending.pop(key, None)
            # Failures are retriable, never cached as successful results.
            if not future.cancelled() and future.exception() is None:
                self.results[key] = (time.monotonic(), future.result())
                self.results.move_to_end(key)
                while len(self.results) > self.capacity:
                    self.results.popitem(last=False)

    async def get(self, key: tuple, build: Callable[[], Any]) -> Any:
        # Disconnecting one tile waiter must not cancel work shared by others.
        return await asyncio.shield(asyncio.wrap_future(self.submit(key, build)))
