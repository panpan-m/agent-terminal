"""Session engine: the single owner of each serial port.

One :class:`Session` per configured port.  It owns the ring buffer, the reader
thread, the write lock, the reconnect loop and the transcript.  All higher
layers (MCP, admin API, WebSocket bridge) call into this module and never touch
a serial handle directly.

Concurrency model
-----------------
* one reader thread per session appends to the ring buffer and fans out to
  subscribers (UI, bridge, transcript);
* writers serialise on a per-session lock; ``serial_command`` keeps the lock for
  write + response;
* state changes and RX chunks are published to bounded subscriber queues, so a
  slow browser can never stall the reader.
"""

from __future__ import annotations

import codecs
import fnmatch
import queue
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, Callable, Iterator

from .config import Config, ResetStep, SessionConfig
from .errors import (
    CONFLICT,
    DISCONNECTED,
    INVALID_ARGUMENT,
    NO_SESSION,
    RATE_LIMITED,
    READ_DISABLED,
    SESSION_NOT_FOUND,
    WRITE_DISABLED,
    WRITE_LOCKED,
    ToolFailure,
)
from .errors import BUFFER_GAP as BUFFER_GAP_CODE
from .ring import ReadSlice, RingBuffer
from .serial import Disconnected, SerialError, SerialHandle, WriteTimeout, make_backend
from .transcript import AuditLog, TranscriptRegistry, TranscriptWriter, now_iso

BUSY = "BUSY"

NEWLINE_BYTES = {"none": b"", "lf": b"\n", "cr": b"\r", "crlf": b"\r\n"}

#: Error codes that mean "the device went away"; these trigger a reconnect.
_DISCONNECT_CODES = {"DISCONNECTED", "PORT_NOT_FOUND", "PORT_BUSY"}


class SessionState(str, Enum):
    UNCONFIGURED = "unconfigured"
    OPENING = "opening"
    OPEN = "open"
    RECONNECTING = "reconnecting"
    ERROR = "error"
    CLOSED = "closed"


@dataclass
class Subscriber:
    """A bounded stream of session events for one WebSocket client."""

    maxsize: int = 1024
    q: queue.Queue = field(default_factory=queue.Queue)
    dropped: int = 0
    overflowed: bool = False

    def put(self, item: Any) -> None:
        try:
            self.q.put_nowait(item)
            self.overflowed = False
        except queue.Full:
            self.dropped += 1
            if not self.overflowed:
                self.overflowed = True
                try:
                    self.q.put_nowait({"type": "overflow", "dropped": self.dropped})
                except queue.Full:
                    pass

    def get(self, timeout: float) -> Any | None:
        try:
            return self.q.get(timeout=timeout)
        except queue.Empty:
            return None


@dataclass
class CommandResult:
    tx_bytes: int
    rx_data: bytes
    matched: bool
    match: str | None
    groups: list[str]
    next_cursor: int
    timed_out: bool
    elapsed_ms: int
    truncated: bool


class RateLimiter:
    def __init__(self, per_second: int) -> None:
        self.per_second = max(1, per_second)
        self._events: list[float] = []
        self._lock = threading.Lock()

    def check(self) -> None:
        now = time.monotonic()
        with self._lock:
            self._events = [t for t in self._events if now - t < 1.0]
            if len(self._events) >= self.per_second:
                raise ToolFailure(
                    RATE_LIMITED,
                    f"rate limit exceeded ({self.per_second}/s)",
                    {"limit": self.per_second},
                    retryable=True,
                )
            self._events.append(now)


class Session:
    def __init__(self, cfg: SessionConfig, manager: "SessionManager") -> None:
        self.cfg = cfg
        self.manager = manager
        self.ring = RingBuffer(cfg.buffer_bytes)
        self.state = SessionState.UNCONFIGURED
        self.control_owner = "human"
        self.handle: SerialHandle | None = None
        self.last_error: str | None = None
        self.last_error_code: str | None = None
        self.opened_at: str | None = None
        self.last_rx_at: str | None = None
        self.last_tx_at: str | None = None
        self.reconnect_count = 0
        self.rx_bytes = 0
        self.tx_bytes = 0
        self.last_write_source: str | None = None
        self.config_revision = 1
        self._stop = threading.Event()
        self._reader: threading.Thread | None = None
        self._write_lock = threading.Lock()
        self._sub_lock = threading.Lock()
        self._subs: list[Subscriber] = []
        self._decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self.transcript: TranscriptWriter = manager.transcripts.writer(cfg.id, cfg.transcript)
        self._identity = cfg.port

    # ------------------------------------------------------------------ naming
    @property
    def id(self) -> str:
        return self.cfg.id

    @property
    def name(self) -> str:
        return self.cfg.name or self.cfg.id

    def permission(self, what: str) -> bool:
        return what in self.cfg.agent_permissions

    @property
    def is_open(self) -> bool:
        return self.state is SessionState.OPEN

    # --------------------------------------------------------------- lifecycle
    def open(self) -> None:
        if self.state in (SessionState.OPEN, SessionState.OPENING):
            return
        self._stop.clear()
        self._set_state(SessionState.OPENING)
        try:
            self.handle = self.manager.backend.open(self.manager.serial_config(self.cfg))
        except SerialError as exc:
            self._set_error(exc.code, exc.message)
            raise ToolFailure(exc.code, exc.message, {"port": self.cfg.port}) from exc
        self._identity = self._resolve_identity()
        self._set_state(SessionState.OPEN)
        self.opened_at = now_iso()
        self.last_error = None
        self.last_error_code = None
        self.transcript.event(
            "open",
            config=self.cfg.port,
            baudrate=self.cfg.baudrate,
            bytesize=self.cfg.bytesize,
            parity=self.cfg.parity,
            stopbits=self.cfg.stopbits,
            flow=self.cfg.flow,
        )
        self.manager.audit.write("session.open", session=self.id, port=self.cfg.port)
        self._reader = threading.Thread(target=self._reader_loop, name=f"rx-{self.id}", daemon=True)
        self._reader.start()

    def close(self) -> None:
        self._stop.set()
        if self._reader is not None and self._reader.is_alive():
            self._reader.join(timeout=2.0)
        self._reader = None
        if self.handle is not None:
            try:
                self.manager.backend.close(self.handle)
            except Exception:  # pragma: no cover - close must never mask
                pass
            self.handle = None
        if self.state is not SessionState.ERROR:
            self._set_state(SessionState.CLOSED)
        self.ring.close()
        self.transcript.event("close")
        self.manager.audit.write("session.close", session=self.id)
        for sub in list(self._subs):
            sub.put({"type": "state", "state": self.state.value})

    def restart(self) -> None:
        was_open = self.state is SessionState.OPEN
        self.close()
        self.ring = RingBuffer(self.cfg.buffer_bytes)
        self._decoder.reset()
        self.state = SessionState.UNCONFIGURED
        if was_open:
            self.open()

    # ------------------------------------------------------------------ reader
    def _reader_loop(self) -> None:
        while not self._stop.is_set():
            handle = self.handle
            if handle is None:
                return
            try:
                data = self.manager.backend.read(handle, 4096, 100)
            except Disconnected as exc:
                self._on_disconnect(str(exc))
                return
            except SerialError as exc:
                self._on_disconnect(exc.message)
                return
            except Exception as exc:  # pragma: no cover - defensive
                self._on_disconnect(str(exc))
                return
            if data:
                self._ingest(data)

    def _ingest(self, data: bytes) -> None:
        with self._sub_lock:
            offset = self.ring.append(data)
            self.rx_bytes += len(data)
            self.last_rx_at = now_iso()
            if self.cfg.transcript:
                self.transcript.data("rx", offset, data, "device")
            for sub in list(self._subs):
                sub.put({"type": "rx", "offset": offset, "data": data})

    def _on_disconnect(self, message: str) -> None:
        if self._stop.is_set():
            return
        self.last_error = message
        self.last_error_code = DISCONNECTED
        handle, self.handle = self.handle, None
        if handle is not None:
            try:
                self.manager.backend.close(handle)
            except Exception:
                pass
        self._set_state(SessionState.RECONNECTING)
        self.transcript.event("disconnected", error=message)
        self.manager.audit.write("session.disconnected", session=self.id, error=message)
        if not self.cfg.auto_reconnect:
            self._set_state(SessionState.ERROR)
            return
        threading.Thread(target=self._reconnect_loop, name=f"reconnect-{self.id}", daemon=True).start()

    def _reconnect_loop(self) -> None:
        backoff = [0.2, 0.5, 1.0, 2.0, 5.0]
        attempt = 0
        while not self._stop.is_set():
            delay = backoff[min(attempt, len(backoff) - 1)]
            if self._stop.wait(delay):
                return
            attempt += 1
            try:
                handle = self.manager.backend.open(self.manager.serial_config(self.cfg))
            except SerialError as exc:
                self.last_error = exc.message
                self._broadcast_status()
                continue
            except Exception as exc:  # pragma: no cover - defensive
                self.last_error = str(exc)
                continue
            with self._sub_lock:
                self.handle = handle
            self.reconnect_count += 1
            self.last_error = None
            self.last_error_code = None
            self._set_state(SessionState.OPEN)
            self.transcript.event("reconnected", attempt=attempt)
            self.manager.audit.write("session.reconnected", session=self.id, attempts=attempt)
            self._reader = threading.Thread(target=self._reader_loop, name=f"rx-{self.id}", daemon=True)
            self._reader.start()
            return

    def _resolve_identity(self) -> str:
        """Prefer a stable by-id path so replug works on a different ttyUSB number."""
        try:
            for info in self.manager.backend.list_ports():
                if info.port == self.cfg.port and info.by_id:
                    return info.by_id
        except Exception:  # pragma: no cover
            pass
        return self.cfg.port

    # ------------------------------------------------------------------- state
    def _set_state(self, state: SessionState) -> None:
        self.state = state
        self._broadcast_status()

    def _set_error(self, code: str, message: str) -> None:
        self.state = SessionState.ERROR
        self.last_error = message
        self.last_error_code = code
        self._broadcast_status()

    def _broadcast_status(self) -> None:
        payload = {"type": "status", "status": self.status()}
        with self._sub_lock:
            for sub in list(self._subs):
                sub.put(payload)

    # -------------------------------------------------------------- subscribers
    def subscribe(self, replay_bytes: int = 0, maxsize: int = 1024) -> Subscriber:
        sub = Subscriber(maxsize=maxsize)
        with self._sub_lock:
            replay = b""
            offset = self.ring.head
            if replay_bytes > 0:
                sl = self.ring.read(tail_bytes=replay_bytes)
                replay, offset = sl.data, sl.start
            self._subs.append(sub)
        if replay:
            sub.put({"type": "replay", "offset": offset, "data": replay})
        sub.put({"type": "status", "status": self.status()})
        return sub

    def unsubscribe(self, sub: Subscriber) -> None:
        with self._sub_lock:
            if sub in self._subs:
                self._subs.remove(sub)

    # --------------------------------------------------------------- read path
    def read(
        self,
        *,
        cursor: int | None = None,
        tail_bytes: int | None = None,
        timeout_ms: int = 0,
        max_bytes: int = 16384,
        source: str = "agent",
    ) -> ReadSlice:
        if source == "agent" and not self.permission("read"):
            raise ToolFailure(READ_DISABLED, "agent read permission is disabled", {"session_id": self.id})
        if cursor is not None and tail_bytes is not None:
            raise ToolFailure(INVALID_ARGUMENT, "cursor and tail_bytes are mutually exclusive")
        if timeout_ms > 0:
            base = self.ring.head if (cursor is None and tail_bytes is None) else (cursor if cursor is not None else None)
            if tail_bytes is not None:
                base = self.ring.head
            else:
                base = self.ring.head if base is None else base
            if self.ring.head <= base:
                self.ring.wait_for_data(base, timeout_ms / 1000.0)
        return self.ring.read(cursor, max_bytes, tail_bytes=tail_bytes)

    def expect(
        self,
        pattern: str,
        *,
        mode: str = "literal",
        cursor: int | None = None,
        timeout_ms: int = 5000,
        max_bytes: int = 16384,
        ignore_case: bool = False,
        source: str = "agent",
    ) -> tuple[ReadSlice, bool, str | None, list[str], bool]:
        if source == "agent" and not self.permission("read"):
            raise ToolFailure(READ_DISABLED, "agent read permission is disabled", {"session_id": self.id})
        matcher = self._make_matcher(pattern, mode, ignore_case)
        start = self.ring.head if cursor is None else cursor
        deadline = time.monotonic() + timeout_ms / 1000.0
        collected = bytearray()
        matched = False
        match_text: str | None = None
        groups: list[str] = []
        truncated = False
        while True:
            sl = self.ring.read(start, max_bytes)
            if sl.data:
                collected.extend(sl.data)
                start = sl.next_cursor
                text = collected.decode("utf-8", "replace")
                hit = matcher(text)
                if hit is not None:
                    matched, match_text, groups = True, hit[0], hit[1]
                    break
                if len(collected) >= max_bytes:
                    truncated = True
                    break
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            self.ring.wait_for_data(start, min(remaining, 0.05))
        timed_out = not matched
        data = bytes(collected)
        sl = ReadSlice(
            start=(self.ring.head if cursor is None else cursor),
            end=(self.ring.head if cursor is None else cursor) + len(data),
            data=data,
            head=self.ring.head,
            gap=False,
            truncated=truncated,
        )
        return sl, matched, match_text, groups, timed_out

    # -------------------------------------------------------------- write path
    def _check_write(self, source: str, need: str = "write") -> None:
        if self.state is SessionState.RECONNECTING:
            raise ToolFailure(DISCONNECTED, "serial device is reconnecting", {"session_id": self.id}, retryable=True)
        if self.state is not SessionState.OPEN:
            raise ToolFailure(DISCONNECTED, f"session is not open (state={self.state.value})", {"session_id": self.id})
        if source == "agent":
            if need not in self.cfg.agent_permissions:
                raise ToolFailure(
                    WRITE_DISABLED,
                    f"agent {need} permission is disabled",
                    {"session_id": self.id, "permissions": self.cfg.agent_permissions},
                )
            if self.control_owner != "agent":
                raise ToolFailure(
                    WRITE_LOCKED,
                    "control owner is human; ask the operator to hand control to the agent",
                    {"session_id": self.id, "control_owner": self.control_owner},
                    retryable=True,
                )
        else:  # human / ttyd / admin
            if self.control_owner != "human":
                raise ToolFailure(
                    WRITE_LOCKED,
                    "the agent currently owns write control; take control back in the admin UI",
                    {"session_id": self.id, "control_owner": self.control_owner},
                    retryable=True,
                )

    @contextmanager
    def writing(self, source: str, need: str = "write", timeout_s: float = 30.0) -> Iterator[None]:
        self._check_write(source, need)
        acquired = self._write_lock.acquire(timeout=timeout_s)
        if not acquired:
            raise ToolFailure(BUSY, "another writer is active on this session", {"session_id": self.id}, retryable=True)
        try:
            self._check_write(source, need)
            yield
        finally:
            self._write_lock.release()

    def write_bytes(
        self,
        data: bytes,
        *,
        source: str = "agent",
        need: str = "write",
        chunk_size: int = 0,
        delay_ms: int = 0,
    ) -> int:
        with self.writing(source, need):
            written = self._write_raw(data, source, chunk_size=chunk_size, delay_ms=delay_ms)
        if written == 0 and data:
            # A stalled USB-UART (e.g. a bridge that stops draining while DTR is
            # low) accepts nothing; that is a timeout, not a successful write.
            raise ToolFailure(
                "TIMEOUT",
                "device accepted 0 bytes (write stalled); check its control lines",
                {"session_id": self.id, "requested": len(data)},
                retryable=True,
            )
        return written

    def _write_raw(self, data: bytes, source: str, *, chunk_size: int = 0, delay_ms: int = 0) -> int:
        handle = self.handle
        if handle is None:
            raise ToolFailure(DISCONNECTED, "serial device is not open", {"session_id": self.id})
        total = 0
        chunk_size = max(0, int(chunk_size))
        pieces = [data] if not chunk_size else [data[i : i + chunk_size] for i in range(0, len(data), chunk_size)]
        for piece in pieces:
            try:
                written = self.manager.backend.write(handle, piece, 2000)
            except WriteTimeout as exc:
                total += exc.written
                self.transcript.event(
                    "tx_timeout", requested=len(piece), written=exc.written, source=source
                )
                break
            except Disconnected as exc:
                self._on_disconnect(str(exc))
                raise ToolFailure(DISCONNECTED, str(exc), {"session_id": self.id}) from exc
            total += written
            if written < len(piece):
                break
            if delay_ms > 0:
                time.sleep(delay_ms / 1000.0)
        self.tx_bytes += total
        self.last_tx_at = now_iso()
        self.last_write_source = source
        if self.cfg.transcript:
            self.transcript.data("tx", self.ring.head, data[:total], source)
        with self._sub_lock:
            for sub in list(self._subs):
                sub.put({"type": "tx", "data": data[:total], "source": source})
        return total

    def command(
        self,
        command: str,
        *,
        newline: str = "lf",
        expect: str | None = None,
        expect_mode: str = "literal",
        timeout_ms: int = 5000,
        max_bytes: int = 16384,
        settle_ms: int = 100,
        ignore_case: bool = False,
        source: str = "agent",
    ) -> CommandResult:
        if newline not in NEWLINE_BYTES:
            raise ToolFailure(INVALID_ARGUMENT, f"newline must be one of {sorted(NEWLINE_BYTES)}")
        payload = command.encode("utf-8") + NEWLINE_BYTES[newline]
        started = time.monotonic()
        matcher = self._make_matcher(expect, expect_mode, ignore_case) if expect else None
        with self.writing(source, "command"):
            head_before = self.ring.head
            written = self._write_raw(payload, source)
            collected = bytearray()
            read_cursor = head_before
            matched = False
            match_text: str | None = None
            groups: list[str] = []
            truncated = False
            last_data_at = time.monotonic()
            deadline = started + timeout_ms / 1000.0
            while True:
                budget = max(1, max_bytes - len(collected))
                sl = self.ring.read(read_cursor, budget)
                if sl.gap:
                    read_cursor = sl.start
                if sl.data:
                    collected.extend(sl.data)
                    read_cursor = sl.next_cursor
                    last_data_at = time.monotonic()
                    if matcher is not None:
                        hit = matcher(collected.decode("utf-8", "replace"))
                        if hit is not None:
                            matched, match_text, groups = True, hit[0], hit[1]
                            break
                    if len(collected) >= max_bytes:
                        truncated = True
                        break
                now = time.monotonic()
                if matcher is None:
                    if collected and (now - last_data_at) * 1000 >= settle_ms:
                        break
                if now >= deadline:
                    break
                self.ring.wait_for_data(read_cursor, min(0.05, max(0.001, deadline - now)))
            elapsed = int((time.monotonic() - started) * 1000)
            timed_out = bool(matcher is not None and not matched)
            return CommandResult(
                tx_bytes=written,
                rx_data=bytes(collected),
                matched=matched,
                match=match_text,
                groups=groups,
                next_cursor=read_cursor,
                timed_out=timed_out,
                elapsed_ms=elapsed,
                truncated=truncated,
            )

    # --------------------------------------------------------------- matchers
    def _make_matcher(self, pattern: str | None, mode: str, ignore_case: bool):
        if pattern is None:
            return None
        limit = self.manager.config.security.max_pattern_length
        if len(pattern) > limit:
            raise ToolFailure(INVALID_ARGUMENT, f"pattern longer than {limit} characters")
        if mode not in ("literal", "regex", "glob"):
            raise ToolFailure(INVALID_ARGUMENT, "expect_mode must be literal|regex|glob")
        timeout_ms = self.manager.config.security.regex_timeout_ms
        if mode == "literal":
            needle = pattern.lower() if ignore_case else pattern

            def literal(text: str) -> tuple[str, list[str]] | None:
                hay = text.lower() if ignore_case else text
                idx = hay.find(needle)
                return (needle, []) if idx >= 0 else None

            return literal
        if mode == "glob":
            import re

            rx = re.compile(fnmatch.translate(pattern), re.IGNORECASE if ignore_case else 0)

            def glob(text: str):
                m = rx.search(text)
                return (m.group(0), []) if m else None

            return glob
        try:
            import regex as regex_mod

            flags = regex_mod.IGNORECASE if ignore_case else 0
            compiled = regex_mod.compile(pattern, flags)

            def rx_match(text: str):
                try:
                    m = compiled.search(text, timeout=timeout_ms / 1000.0)
                except TimeoutError as exc:
                    raise ToolFailure(
                        "TIMEOUT",
                        f"pattern matching exceeded {timeout_ms} ms; simplify the regex",
                        {"pattern_length": len(pattern)},
                    ) from exc
                if not m:
                    return None
                return (m.group(0), [g or "" for g in m.groups()])

            return rx_match
        except ImportError:  # pragma: no cover - regex is a declared dependency
            import re

            compiled = re.compile(pattern, re.IGNORECASE if ignore_case else 0)

            def re_match(text: str):
                m = compiled.search(text)
                return (m.group(0), [g or "" for g in m.groups()]) if m else None

            return re_match
        except Exception as exc:
            raise ToolFailure(INVALID_ARGUMENT, f"invalid regex: {exc}") from exc

    # ------------------------------------------------------------- control lines
    def lines(self) -> dict[str, Any] | None:
        if self.handle is None:
            return None
        try:
            return self.manager.backend.get_lines(self.handle).to_dict()
        except SerialError as exc:
            self._on_disconnect(exc.message)
            return None

    def set_lines(self, dtr: bool | None, rts: bool | None, *, source: str = "admin") -> dict[str, Any]:
        if self.handle is None:
            raise ToolFailure(DISCONNECTED, "session is not open", {"session_id": self.id})
        with self.writing(source, "write", timeout_s=2.0):
            try:
                return self.manager.backend.set_lines(self.handle, dtr, rts).to_dict()
            except SerialError as exc:
                raise ToolFailure(exc.code, exc.message) from exc

    def apply_reset_sequence(self) -> dict[str, Any]:
        """Admin-only reset: pulse the configured DTR/RTS sequence.

        The pre-reset line state is restored afterwards.  Some USB-UART
        bridges (e.g. the Raspberry Pi Debug Probe) stop draining their TX pipe
        while DTR is deasserted; leaving the last reset step's state in place
        would make later writes time out.  Use the line controls to hold a
        state deliberately.
        """
        if self.state is not SessionState.OPEN:
            raise ToolFailure(DISCONNECTED, "session must be open before resetting", {"session_id": self.id})
        steps = self.cfg.reset_sequence or [
            ResetStep(dtr=False, rts=True, delay_ms=100),
            ResetStep(dtr=True, rts=False, delay_ms=100),
            ResetStep(dtr=False, rts=False, delay_ms=50),
        ]
        start_cursor = self.ring.head
        before = None
        try:
            before = self.manager.backend.get_lines(self.handle)
        except SerialError:
            before = None
        with self.writing("admin", "write", timeout_s=5.0):
            for step in steps:
                try:
                    self.manager.backend.set_lines(self.handle, step.dtr, step.rts)
                except SerialError as exc:
                    raise ToolFailure(exc.code, exc.message) from exc
                time.sleep(max(0, step.delay_ms) / 1000.0)
            if before is not None:
                try:
                    self.manager.backend.set_lines(self.handle, before.dtr, before.rts)
                except SerialError:
                    pass
        self.transcript.event("reset", cursor=start_cursor, restored=before.to_dict() if before else None)
        self.manager.audit.write("session.reset", session=self.id, cursor=start_cursor)
        return {"reset_cursor": start_cursor, "steps": len(steps), "restored": before.to_dict() if before else None}

    def pulse(self, line: str, active: bool, duration_ms: int) -> None:
        if self.handle is None:
            raise ToolFailure(DISCONNECTED, "session is not open", {"session_id": self.id})
        with self.writing("admin", "write", timeout_s=2.0):
            try:
                self.manager.backend.pulse_line(self.handle, line, active, duration_ms)
            except SerialError as exc:
                raise ToolFailure(exc.code, exc.message) from exc

    # ------------------------------------------------------------------ status
    def status(self) -> dict[str, Any]:
        cfg = self.cfg
        return {
            "session_id": cfg.id,
            "name": self.name,
            "state": self.state.value,
            "port": cfg.port,
            "config": {
                "baudrate": cfg.baudrate,
                "bytesize": cfg.bytesize,
                "parity": cfg.parity,
                "stopbits": cfg.stopbits,
                "flow": cfg.flow,
                "open_mode": cfg.open_mode,
            },
            "control_owner": self.control_owner,
            "agent_permissions": list(cfg.agent_permissions),
            "rx_bytes": self.rx_bytes,
            "tx_bytes": self.tx_bytes,
            "rx_start": self.ring.start,
            "rx_head": self.ring.head,
            "buffer_bytes": self.ring.capacity,
            "lost_bytes": self.ring.lost_bytes,
            "lines": self.lines(),
            "last_error": self.last_error,
            "last_error_code": self.last_error_code,
            "opened_at": self.opened_at,
            "last_rx_at": self.last_rx_at,
            "last_tx_at": self.last_tx_at,
            "last_write_source": self.last_write_source,
            "reconnect_count": self.reconnect_count,
            "auto_reconnect": cfg.auto_reconnect,
            "config_revision": self.config_revision,
            "platform": "windows" if self.manager.is_windows else "posix",
        }


class SessionManager:
    def __init__(
        self,
        config: Config,
        *,
        backend=None,
        on_config_changed: Callable[[Config], None] | None = None,
    ) -> None:
        self.config = config
        self.backend = backend or make_backend()
        self.transcripts = TranscriptRegistry(config)
        self.audit = AuditLog(config.log_dir / "audit", redactor=self.transcripts.redactor)
        self._sessions: dict[str, Session] = {}
        self._lock = threading.RLock()
        self._on_config_changed = on_config_changed
        self.limiter = RateLimiter(config.security.rate_limit_per_second)
        self.is_windows = __import__("os").name == "nt"
        for scfg in config.sessions:
            self._sessions[scfg.id] = Session(scfg, self)

    # ------------------------------------------------------------------ lookup
    @property
    def sessions(self) -> dict[str, Session]:
        return dict(self._sessions)

    def get(self, session_id: str) -> Session:
        sess = self._sessions.get(session_id)
        if sess is None:
            raise ToolFailure(SESSION_NOT_FOUND, f"unknown session: {session_id}", {"session_id": session_id})
        return sess

    def resolve(self, session_id: str | None) -> Session:
        if session_id:
            return self.get(session_id)
        with self._lock:
            sessions = list(self._sessions.values())
        if not sessions:
            raise ToolFailure(NO_SESSION, "no serial session is configured")
        if len(sessions) > 1:
            raise ToolFailure(
                INVALID_ARGUMENT,
                "session_id is required when more than one session exists",
                {"sessions": [s.id for s in sessions]},
            )
        return sessions[0]

    def serial_config(self, scfg: SessionConfig):
        from .serial import SerialConfig

        return SerialConfig(
            port=scfg.port,
            baudrate=scfg.baudrate,
            bytesize=scfg.bytesize,
            parity=scfg.parity,
            stopbits=scfg.stopbits,
            flow=scfg.flow,
            open_mode=scfg.open_mode,
        )

    # --------------------------------------------------------------- lifecycle
    def start(self) -> None:
        for sess in list(self._sessions.values()):
            if sess.cfg.auto_open:
                try:
                    sess.open()
                except ToolFailure as exc:
                    self.audit.write("session.auto_open_failed", session=sess.id, error=exc.message)

    def stop(self) -> None:
        for sess in list(self._sessions.values()):
            sess.close()
        self.transcripts.close()

    def ports(self) -> list[dict]:
        return [p.to_dict() for p in self.backend.list_ports()]

    # ------------------------------------------------------------------ config
    def create_session(self, scfg: SessionConfig) -> Session:
        with self._lock:
            if scfg.id in self._sessions:
                raise ToolFailure(CONFLICT, f"session already exists: {scfg.id}", {"session_id": scfg.id})
            if len(self._sessions) >= self.config.security.max_sessions:
                raise ToolFailure(CONFLICT, "maximum number of sessions reached")
            self.config.validate_session(scfg)
            self.config.sessions.append(scfg)
            sess = Session(scfg, self)
            self._sessions[scfg.id] = sess
        self._persist()
        return sess

    def update_session(self, scfg: SessionConfig, *, reopen: bool = True) -> Session:
        with self._lock:
            old = self._sessions.get(scfg.id)
            if old is None:
                raise ToolFailure(SESSION_NOT_FOUND, f"unknown session: {scfg.id}")
            self.config.validate_session(scfg)
            was_open = old.is_open
            old.cfg = scfg
            old.config_revision += 1
            self.config.replace_session(scfg)
        self._persist()
        if reopen and was_open:
            old.close()
            old.state = SessionState.UNCONFIGURED
            old.open()
        return old

    def remove_session(self, session_id: str) -> None:
        with self._lock:
            sess = self._sessions.pop(session_id, None)
            if sess is None:
                raise ToolFailure(SESSION_NOT_FOUND, f"unknown session: {session_id}")
            self.config.remove_session(session_id)
        sess.close()
        self._persist()

    def set_control_owner(self, session_id: str, owner: str) -> str:
        if owner not in ("human", "agent"):
            raise ToolFailure(INVALID_ARGUMENT, "control_owner must be human or agent")
        sess = self.get(session_id)
        previous = sess.control_owner
        sess.control_owner = owner
        sess.transcript.event("control_owner", previous=previous, owner=owner)
        self.audit.write("session.control_owner", session=session_id, previous=previous, owner=owner)
        sess._broadcast_status()
        return owner

    def set_permissions(self, session_id: str, permissions: list[str]) -> list[str]:
        valid = {"read", "write", "command"}
        bad = [p for p in permissions if p not in valid]
        if bad:
            raise ToolFailure(INVALID_ARGUMENT, f"unknown permissions: {bad}")
        sess = self.get(session_id)
        sess.cfg.agent_permissions = list(dict.fromkeys(permissions))
        self.config.replace_session(sess.cfg)
        self._persist()
        self.audit.write("session.permissions", session=session_id, permissions=permissions)
        sess._broadcast_status()
        return sess.cfg.agent_permissions

    def _persist(self) -> None:
        if self._on_config_changed is not None:
            self._on_config_changed(self.config)

    # ---------------------------------------------------------------- readiness
    def any_open(self) -> bool:
        return any(s.is_open for s in self._sessions.values())
