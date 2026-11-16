"""Operator-configured MCP session binding.

The serial ``serial_*`` tool surface is bound to one session from the MCP tab.
Without a binding the tools are not published at all.  The binding is runtime
state (session ids are ephemeral, so there is nothing worth persisting); the UI
re-selects after a restart.
"""

from __future__ import annotations

import threading

_UNSET = object()


class McpBindings:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._serial: str | None = None

    @property
    def serial_session_id(self) -> str | None:
        with self._lock:
            return self._serial

    def set(self, *, serial_session_id: object = _UNSET) -> dict[str, str | None]:
        """Update the binding (None unbinds); returns the new value."""
        with self._lock:
            if serial_session_id is not _UNSET:
                self._serial = serial_session_id or None  # type: ignore[assignment]
            return {"serial_session_id": self._serial}
