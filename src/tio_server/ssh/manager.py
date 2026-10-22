"""SSH connection manager (operator-created sessions only)."""

from __future__ import annotations

import secrets
import threading
from typing import Any

from ..config import Config
from ..errors import CONFLICT, NOT_FOUND, ToolFailure
from ..transcript import AuditLog, TranscriptRegistry
from .profiles import SshHost, SshProfileStore
from .session import SshSession


class SshManager:
    def __init__(
        self,
        config: Config,
        profiles: SshProfileStore,
        *,
        transcripts: TranscriptRegistry,
        audit: AuditLog,
        max_sessions: int | None = None,
    ) -> None:
        self.config = config
        self.profiles = profiles
        self.transcripts = transcripts
        self.audit = audit
        self.max_sessions = max_sessions or max(2, int(config.security.max_sessions))
        self._sessions: dict[str, SshSession] = {}
        self._lock = threading.RLock()

    def connect(
        self,
        host_id: str,
        *,
        password: str | None = None,
        passphrase: str | None = None,
        cols: int = 120,
        rows: int = 30,
    ) -> SshSession:
        host: SshHost = self.profiles.get(host_id)
        with self._lock:
            if len(self._sessions) >= self.max_sessions:
                raise ToolFailure(CONFLICT, "maximum number of SSH sessions reached")
            session_id = f"ssh-{host.id}-{secrets.token_hex(3)}"
            session = SshSession(host, self, session_id)
            self._sessions[session_id] = session
        try:
            session.connect(password=password, passphrase=passphrase, cols=cols, rows=rows)
        except Exception:
            with self._lock:
                self._sessions.pop(session_id, None)
            raise
        return session

    def get(self, session_id: str) -> SshSession:
        with self._lock:
            session = self._sessions.get(session_id)
        if session is None:
            raise ToolFailure(NOT_FOUND, f"unknown SSH session: {session_id}", {"session_id": session_id})
        return session

    def list(self) -> list[dict[str, Any]]:
        with self._lock:
            sessions = list(self._sessions.values())
        return [session.status() for session in sessions]

    def disconnect(self, session_id: str) -> None:
        session = self.get(session_id)
        session.close()
        with self._lock:
            self._sessions.pop(session_id, None)

    def stop(self) -> None:
        with self._lock:
            sessions = list(self._sessions.values())
            self._sessions.clear()
        for session in sessions:
            try:
                session.close()
            except Exception:
                pass
