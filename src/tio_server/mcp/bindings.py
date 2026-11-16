"""Operator-configured MCP session bindings.

The MCP tool surface is bound to specific sessions from the MCP tab:
serial_* tools operate on the bound serial session, ssh_* tools on the bound
SSH session.  Without a binding the corresponding tools are not published at
all.  Bindings are runtime state (session ids are ephemeral, so there is
nothing worth persisting); the UI re-selects after a restart.
"""

from __future__ import annotations

import threading

_UNSET = object()


class McpBindings:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._serial: str | None = None
        self._ssh: str | None = None

    @property
    def serial_session_id(self) -> str | None:
        with self._lock:
            return self._serial

    @property
    def ssh_session_id(self) -> str | None:
        with self._lock:
            return self._ssh

    def set(
        self,
        *,
        serial_session_id: object = _UNSET,
        ssh_session_id: object = _UNSET,
    ) -> dict[str, str | None]:
        """Update the given fields (None unbinds); returns the new values."""
        with self._lock:
            if serial_session_id is not _UNSET:
                self._serial = serial_session_id or None  # type: ignore[assignment]
            if ssh_session_id is not _UNSET:
                self._ssh = ssh_session_id or None  # type: ignore[assignment]
            return {"serial_session_id": self._serial, "ssh_session_id": self._ssh}
