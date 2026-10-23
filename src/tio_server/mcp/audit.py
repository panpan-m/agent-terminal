"""In-memory audit trail of MCP tool calls, served to the admin UI.

Every ``tools/call`` is recorded with the timestamp, the MCP client identity
(from the ``initialize`` handshake), the session the tool targeted, the raw
arguments and a snipped view of the result.  Bounded and newest-first; the
persistent audit file in the session manager keeps the long-term record.
"""

from __future__ import annotations

import json
import threading
from collections import deque
from datetime import datetime
from typing import Any

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

    def __init__(self, capacity: int = MAX_EVENTS) -> None:
        self._lock = threading.Lock()
        self._events: deque[dict[str, Any]] = deque(maxlen=capacity)

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

    def recent(self, limit: int = 100) -> list[dict[str, Any]]:
        with self._lock:
            return list(self._events)[: max(1, min(int(limit), MAX_EVENTS))]


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
