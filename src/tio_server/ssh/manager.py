"""SSH connection manager (operator-created sessions only)."""

from __future__ import annotations

import os
import secrets
import threading
from typing import Any

import paramiko

from ..config import Config
from ..errors import CONFLICT, NOT_FOUND, SSH_UNREACHABLE, ToolFailure
from ..transcript import AuditLog, TranscriptRegistry
from .profiles import SshHost, SshProfileStore
from .session import SshSession, _fingerprint


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

    def test(self, host_id: str) -> dict[str, Any]:
        """TCP + SSH handshake only: no auth, no command, no side effects."""
        host = self.profiles.get(host_id)
        transport = None
        try:
            transport = paramiko.Transport((host.host, int(host.port)))
            transport.start_client(timeout=int(host.connect_timeout_s))
            key = transport.get_remote_server_key()
            known = paramiko.HostKeys()
            system_known = os.path.expanduser("~/.ssh/known_hosts")
            if os.path.isfile(system_known):
                known.load(system_known)
            if host.known_hosts and os.path.isfile(os.path.expanduser(host.known_hosts)):
                known.load(os.path.expanduser(host.known_hosts))
            lookup = host.host if int(host.port) == 22 else f"[{host.host}]:{host.port}"
            entry = known.lookup(lookup)
            if not entry:
                known_status = "unknown"
            else:
                expected = entry.get(key.get_name())
                known_status = "known" if expected is not None and expected.asbytes() == key.asbytes() else "changed"
            result = {
                "host_id": host.id,
                "host": host.host,
                "port": int(host.port),
                "reachable": True,
                "remote_version": transport.remote_version,
                "host_key_type": key.get_name(),
                "fingerprint": _fingerprint(key),
                "known_hosts_status": known_status,
                "known_hosts": os.path.expanduser(host.known_hosts) if host.known_hosts else system_known,
            }
            self.audit.write(
                "ssh.test",
                host_id=host.id,
                host=host.host,
                port=int(host.port),
                known_hosts=known_status,
            )
            return result
        except Exception as exc:
            raise ToolFailure(
                SSH_UNREACHABLE,
                f"cannot reach {host.host}:{host.port}: {exc}",
                {"host_id": host.id, "host": host.host, "port": int(host.port)},
            ) from exc
        finally:
            if transport is not None:
                try:
                    transport.close()
                except Exception:
                    pass

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
