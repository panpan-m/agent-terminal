"""Thread-safe byte ring buffer with absolute cursors and chunk timestamps.

The buffer never consumes data on read: every reader keeps its own absolute
cursor.  Offsets are global for the lifetime of a session:

* ``start`` -- absolute offset of the oldest byte still buffered
* ``head``  -- absolute number of bytes ever appended (next write offset)

When the writer overwrites unread bytes, ``start`` advances and readers whose
cursor is older than ``start`` see ``gap=True`` with the number of bytes they
missed.  ``lost_bytes`` is by definition equal to ``start``.
"""

from __future__ import annotations

import threading
import time
from collections import deque
from dataclasses import dataclass, field


@dataclass(slots=True)
class ReadSlice:
    """Result of a buffered read."""

    start: int
    end: int
    data: bytes
    head: int
    gap: bool = False
    lost_bytes: int = 0
    truncated: bool = False
    #: ``(offset, timestamp_ms)`` for the first byte of each contiguous chunk.
    segments: list[tuple[int, float]] = field(default_factory=list)

    @property
    def next_cursor(self) -> int:
        return self.end


class RingBuffer:
    def __init__(self, capacity: int = 8 * 1024 * 1024) -> None:
        if capacity <= 0:
            raise ValueError("capacity must be positive")
        self._capacity = int(capacity)
        self._buf = bytearray(self._capacity)
        self._start = 0
        self._head = 0
        self._chunks: deque[tuple[int, int, float]] = deque()  # (start, end, ts_ms)
        self._cond = threading.Condition()
        self._closed = False

    # ------------------------------------------------------------------ state
    @property
    def capacity(self) -> int:
        return self._capacity

    @property
    def start(self) -> int:
        with self._cond:
            return self._start

    @property
    def head(self) -> int:
        with self._cond:
            return self._head

    @property
    def lost_bytes(self) -> int:
        """Total bytes dropped because the buffer wrapped."""
        return self.start

    @property
    def available(self) -> int:
        with self._cond:
            return self._head - self._start

    # ----------------------------------------------------------------- append
    def append(self, data: bytes, ts_ms: float | None = None) -> int:
        """Append bytes and return the absolute offset of the first byte."""
        if not data:
            with self._cond:
                return self._head
        ts = time.time() * 1000.0 if ts_ms is None else ts_ms
        with self._cond:
            n = len(data)
            first = self._head
            if n > self._capacity:
                # Only the newest `capacity` bytes can survive.
                drop = n - self._capacity
                data = bytes(data[drop:])
                first += drop
                n = self._capacity
                self._start = first
            # Absolute offset X always lives at index X % capacity.
            write_at = first % self._capacity
            room = self._capacity - write_at
            if n <= room:
                self._buf[write_at : write_at + n] = data
            else:
                self._buf[write_at:] = data[:room]
                self._buf[: n - room] = data[room:]
            self._head = first + n
            if self._head - self._start > self._capacity:
                self._start = self._head - self._capacity
            self._chunks.append((first, first + n, ts))
            self._prune_locked()
            self._cond.notify_all()
            return first

    def _prune_locked(self) -> None:
        while self._chunks and self._chunks[0][1] <= self._start:
            self._chunks.popleft()

    # ------------------------------------------------------------------- read
    def read(
        self,
        cursor: int | None = None,
        max_bytes: int = 16384,
        *,
        tail_bytes: int | None = None,
    ) -> ReadSlice:
        """Read at most ``max_bytes`` starting at absolute ``cursor``.

        ``tail_bytes`` ignores ``cursor`` and returns the newest N bytes.
        """
        with self._cond:
            head = self._head
            start = self._start
            if tail_bytes is not None:
                if tail_bytes < 0:
                    raise ValueError("tail_bytes must be >= 0")
                begin = max(start, head - int(tail_bytes))
                gap = False
            else:
                req = start if cursor is None else int(cursor)
                if req > head:
                    req = head
                if req < start:
                    gap = True
                    begin = start
                else:
                    gap = False
                    begin = req
            end = min(head, begin + max(0, int(max_bytes)))
            truncated = end < head
            data = self._slice_locked(begin, end)
            segments: list[tuple[int, float]] = []
            for c_start, c_end, ts in self._chunks:
                lo = max(begin, c_start)
                hi = min(end, c_end)
                if lo < hi:
                    segments.append((lo, ts))
            return ReadSlice(
                start=begin,
                end=end,
                data=data,
                head=head,
                gap=gap,
                lost_bytes=(begin - int(cursor)) if (gap and cursor is not None) else 0,
                truncated=truncated,
                segments=segments,
            )

    def _slice_locked(self, begin: int, end: int) -> bytes:
        if begin >= end:
            return b""
        n = end - begin
        pos = begin % self._capacity
        room = self._capacity - pos
        if n <= room:
            return bytes(self._buf[pos : pos + n])
        return bytes(self._buf[pos:]) + bytes(self._buf[: n - room])

    # ------------------------------------------------------------------- wait
    def wait_for_data(self, after_cursor: int, timeout: float) -> bool:
        """Block until ``head > after_cursor`` or timeout; return whether data exists."""
        deadline = time.monotonic() + max(0.0, timeout)
        with self._cond:
            while not self._closed and self._head <= after_cursor:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                self._cond.wait(remaining)
            return self._head > after_cursor

    # ---------------------------------------------------------------- control
    def close(self) -> None:
        with self._cond:
            self._closed = True
            self._cond.notify_all()

    def clear(self) -> None:
        with self._cond:
            self._chunks.clear()
            self._start = self._head
            self._cond.notify_all()
