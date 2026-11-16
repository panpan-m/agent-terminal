"""Shared streaming core and per-client event streams for every transport.

The serial session fans data out to WebSocket clients.
The queue is bounded on purpose: a stalled client must lose chunks (and be told
so), never grow the single-owner process until the reader thread starves.  This
lives in its own module so the two transports cannot drift apart — the previous
two verbatim copies both forgot to apply ``maxsize`` to the queue, which left the
overflow branch permanently unreachable.

:class:`StreamSession` is the same idea one level up: the ring buffer, the
subscriber fan-out, the replay ordering and the transcript writes are identical
for every transport, so a new transport implements connect/read/write and
inherits the parts that are easy to get subtly wrong.
"""

from __future__ import annotations

import queue
import threading
from typing import Any

from .ring import ReadSlice, RingBuffer


class Subscriber:
    """A bounded stream of session events for one WebSocket client."""

    __slots__ = ("maxsize", "q", "dropped", "overflowed")

    def __init__(self, maxsize: int = 2048) -> None:
        # A capacity of 0 would mean "unbounded" to queue.Queue, which is exactly
        # the bug this class exists to prevent.
        self.maxsize = max(1, int(maxsize))
        self.q: queue.Queue = queue.Queue(self.maxsize)
        self.dropped = 0
        self.overflowed = False

    def put(self, item: Any) -> None:
        """Enqueue without ever blocking the caller (the reader thread)."""
        try:
            self.q.put_nowait(item)
            self.overflowed = False
            return
        except queue.Full:
            self.dropped += 1
        if self.overflowed:
            return
        # First drop in a burst: discard one held chunk so the notice itself fits,
        # otherwise the client would be starved silently.
        self.overflowed = True
        try:
            self.q.get_nowait()
        except queue.Empty:
            pass
        try:
            self.q.put_nowait({"type": "overflow", "dropped": self.dropped})
        except queue.Full:
            pass

    def get(self, timeout: float) -> Any | None:
        try:
            return self.q.get(timeout=timeout)
        except queue.Empty:
            return None


class StreamSession:
    """Ring buffer + subscriber fan-out + transcript, shared by all transports.

    Subclasses provide :meth:`status` (for the status frame) and call
    :meth:`_init_streaming` once the ring and transcript exist.
    """

    subscriber_type: type[Subscriber] = Subscriber

    def _init_streaming(self, *, ring: RingBuffer, transcript: Any) -> None:
        self.ring = ring
        self.transcript = transcript
        self._sub_lock = threading.Lock()
        self._subs: list[Subscriber] = []

    # ------------------------------------------------------------------ fan-out
    def subscribe(
        self, replay_bytes: int = 0, maxsize: int = 2048, cursor: int | None = None
    ) -> Subscriber:
        sub = self.subscriber_type(maxsize=maxsize)
        replay = b""
        offset = self.ring.head
        dropped = 0
        with self._sub_lock:
            if cursor is not None:
                sl = self.ring.read(cursor=max(0, int(cursor)), max_bytes=1024 * 1024)
                replay, offset = sl.data, sl.start
                dropped = sl.lost_bytes if sl.gap else 0
            elif replay_bytes > 0:
                sl = self.ring.read(tail_bytes=replay_bytes, max_bytes=replay_bytes)
                replay, offset = sl.data, sl.start
            # history must land in the queue before the subscriber goes live,
            # or a chunk ingested in between would render ahead of the replay
            if dropped:
                sub.put({"type": "overflow", "dropped": dropped})
            if replay:
                sub.put({"type": "replay", "offset": offset, "data": replay})
            self._subs.append(sub)
        sub.put({"type": "status", "status": self.status()})
        return sub

    def unsubscribe(self, sub: Subscriber) -> None:
        with self._sub_lock:
            if sub in self._subs:
                self._subs.remove(sub)

    def _broadcast(self, payload: dict[str, Any]) -> None:
        with self._sub_lock:
            for sub in list(self._subs):
                sub.put(payload)

    def _broadcast_status(self) -> None:
        self._broadcast({"type": "status", "status": self.status()})

    # ------------------------------------------------------------------ traffic
    def _after_append(self, data: bytes, offset: int) -> None:
        """Hook: run under the subscriber lock, right after the ring append.

        Counters must be updated here, not after :meth:`_append_rx` returns: the
        ring publishes the new head and wakes readers *inside* ``append``, so a
        caller that updates its counters afterwards can be observed with data
        already readable but counters still zero.
        """

    def _append_rx(self, data: bytes, source: str, *, transcript: bool = True) -> int:
        """Append received bytes and fan them out; returns the absolute offset."""
        with self._sub_lock:
            offset = self.ring.append(data)
            self._after_append(data, offset)
            if transcript:
                self.transcript.data("rx", offset, data, source)
            for sub in list(self._subs):
                sub.put({"type": "rx", "offset": offset, "data": data})
            return offset

    def _fan_tx(
        self,
        data: bytes,
        source: str,
        *,
        transcript: bool = True,
        owner: str | None = None,
    ) -> None:
        """Record written bytes and fan them out.

        ``owner`` is the MCP client that wrote them; it goes into the transcript
        record so the log can be read one client at a time.
        """
        offset = self.ring.head
        if transcript:
            self.transcript.data("tx", offset, data, source, owner=owner)
        payload: dict[str, Any] = {"type": "tx", "data": data, "source": source}
        if owner is not None:
            payload["owner"] = owner
        self._broadcast(payload)

    def read_slice(
        self,
        *,
        cursor: int | None = None,
        tail_bytes: int | None = None,
        max_bytes: int = 16384,
    ) -> ReadSlice:
        return self.ring.read(cursor, max_bytes, tail_bytes=tail_bytes)

    # Subclasses override; kept explicit so the dependency is visible.
    def status(self) -> dict[str, Any]:  # pragma: no cover - implemented by subclass
        raise NotImplementedError

