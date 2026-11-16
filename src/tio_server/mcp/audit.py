"""Audit trail of MCP tool calls: a bounded in-memory view plus a durable record.

Every ``tools/call`` is recorded with the timestamp, the MCP client identity
(from the ``initialize`` handshake), the session the tool targeted, the raw
arguments and a snipped view of the result.

The in-memory ring is what the admin UI pages through; it is capped and lost on
restart, which is not acceptable for an audit trail.  When a durable
:class:`~tio_server.transcript.AuditLog` is supplied the same record is also
appended to the JSONL audit file, redacted by the configured patterns, so
"which agent ran what, and what came back" survives a restart.
"""

from __future__ import annotations

import json
import threading
from collections import deque
from datetime import datetime
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # pragma: no cover - typing only
    from ..transcript import AuditLog

MAX_INPUT_CHARS = 2000
MAX_OUTPUT_CHARS = 4000
MAX_EVENTS = 500


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="milliseconds")


def _snip(text: str, cap: int) -> str:
    return text if len(text) <= cap else text[: cap - 1] + "…"


def _snip_json(value: Any, cap: int) -> str:
    try:
        text = json.dumps(value, ensure_ascii=False, default=str)
    except Exception:  # pragma: no cover - defensive
        text = str(value)
    return _snip(text, cap)


class McpAuditLog:
    """Bounded, thread-safe record of tool invocations, newest first."""

    def __init__(self, capacity: int = MAX_EVENTS, durable: "AuditLog | None" = None) -> None:
        self._lock = threading.Lock()
        self._events: deque[dict[str, Any]] = deque(maxlen=capacity)
        self._durable = durable

    def record(
        self,
        *,
        tool: str,
        agent: str,
        agent_version: str | None,
        session: str | None,
        ok: bool,
        duration_ms: int,
        arguments: dict[str, Any] | None,
        result: Any = None,
        error: str | None = None,
    ) -> None:
        entry = {
            "ts": _now_iso(),
            "tool": tool,
            "agent": agent or "unknown",
            "agent_version": agent_version,
            "session": session,
            "ok": bool(ok),
            "duration_ms": int(duration_ms),
            "input": _snip_json(arguments, MAX_INPUT_CHARS),
            "output": _snip(error, MAX_OUTPUT_CHARS) if error is not None else _result_text(result),
        }
        with self._lock:
            self._events.appendleft(entry)
        if self._durable is not None:
            payload = dict(entry)
            payload.pop("ts", None)  # AuditLog stamps its own ts
            try:
                self._durable.write("mcp.tool_call", **payload)
            except OSError:  # disk full / file gone: never break the tool call
                pass

    def recent(self, limit: int = 100, client: str | None = None) -> list[dict[str, Any]]:
        """Newest calls first; `client` keeps only one MCP client's calls."""
        with self._lock:
            events = list(self._events)
        if client is not None:
            events = [event for event in events if event.get("agent") == client]
        return events[: max(1, min(int(limit), MAX_EVENTS))]


def _result_text(result: Any) -> str:
    structured = getattr(result, "structured_content", None)
    if structured:
        return _snip_json(structured, MAX_OUTPUT_CHARS)
    content = getattr(result, "content", None)
    if isinstance(content, list):
        texts = [getattr(item, "text", "") for item in content if getattr(item, "text", "")]
        if texts:
            return _snip(" | ".join(texts), MAX_OUTPUT_CHARS)
    if result is None:
        return ""
    return _snip(str(result), MAX_OUTPUT_CHARS)
