"""SSH host profiles: persisted configuration, no secrets.

Profiles live in ``<data_dir>/ssh_hosts.json``.  Passwords and key passphrases
are never stored here; they are supplied per connection and kept only in memory.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import threading
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from ..errors import CONFLICT, INVALID_ARGUMENT, NOT_FOUND, ToolFailure
from ..transcript import now_iso

_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")
_TERM_RE = re.compile(r"^[A-Za-z0-9._+-]{1,64}$")
AUTH_METHODS = ("password", "key", "agent", "interactive")


def _bad(message: str, **details: Any) -> ToolFailure:
    return ToolFailure(INVALID_ARGUMENT, message, details)


def _clean(value: Any, field_name: str, *, max_len: int = 255) -> str:
    text = "" if value is None else str(value)
    text = text.strip()
    if len(text) > max_len:
        raise _bad(f"{field_name} is too long", field=field_name)
    if any(ord(ch) < 32 for ch in text):
        raise _bad(f"{field_name} contains control characters", field=field_name)
    return text


def _slug(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return (slug or "ssh")[:32].rstrip("-")


@dataclass(slots=True)
class SshHost:
    id: str
    name: str
    host: str
    port: int = 22
    username: str = ""
    auth: str = "password"
    key_file: str = ""
    known_hosts: str = ""
    jump_host_id: str = ""
    term: str = "xterm-256color"
    connect_timeout_s: int = 10
    created_at: str = field(default_factory=now_iso)
    updated_at: str = field(default_factory=now_iso)

    def validate(self) -> None:
        if not _ID_RE.fullmatch(self.id):
            raise _bad("id must match [a-z0-9][a-z0-9_-]{0,31}", field="id")
        if not self.name:
            raise _bad("name is required", field="name")
        if not self.host:
            raise _bad("host is required", field="host")
        if "://" in self.host or "/" in self.host:
            raise _bad("host must be a hostname or IP, not a URL", field="host")
        if any(ch.isspace() for ch in self.host):
            raise _bad("host must not contain whitespace", field="host")
        if not (1 <= int(self.port) <= 65535):
            raise _bad("port must be 1..65535", field="port")
        if not self.username:
            raise _bad("username is required", field="username")
        if any(ch.isspace() for ch in self.username):
            raise _bad("username must not contain whitespace", field="username")
        if self.auth not in AUTH_METHODS:
            raise _bad("auth must be password or key", field="auth")
        if self.auth == "key" and not self.key_file:
            raise _bad("key_file is required when auth=key", field="key_file")
        if self.jump_host_id and not _ID_RE.fullmatch(self.jump_host_id):
            raise _bad("jump_host_id must be a saved host id", field="jump_host_id")
        if self.jump_host_id == self.id:
            raise _bad("a host cannot jump through itself", field="jump_host_id")
        if not _TERM_RE.fullmatch(self.term):
            raise _bad("term contains invalid characters", field="term")
        if not (1 <= int(self.connect_timeout_s) <= 120):
            raise _bad("connect_timeout_s must be 1..120", field="connect_timeout_s")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class SshProfileStore:
    """Thread-safe JSON store with atomic writes and 0600 permissions."""

    def __init__(self, data_dir: Path | str) -> None:
        self.data_dir = Path(data_dir)
        self.path = self.data_dir / "ssh_hosts.json"
        self._lock = threading.RLock()
        self._hosts: dict[str, SshHost] = {}
        self._load()

    # ------------------------------------------------------------------ load
    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ToolFailure(INVALID_ARGUMENT, f"cannot read {self.path}: {exc}") from exc
        hosts = raw.get("hosts") if isinstance(raw, dict) else raw
        if not isinstance(hosts, list):
            raise ToolFailure(INVALID_ARGUMENT, f"{self.path}: hosts must be a list")
        for item in hosts:
            if not isinstance(item, dict):
                continue
            try:
                host = SshHost(**{key: item[key] for key in SshHost.__dataclass_fields__ if key in item})
                host.validate()
            except (TypeError, ToolFailure):
                continue
            self._hosts[host.id] = host

    def _save(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        payload = {
            "version": 1,
            "hosts": [self._hosts[key].to_dict() for key in sorted(self._hosts)],
        }
        fd, tmp_name = tempfile.mkstemp(prefix=".ssh_hosts-", suffix=".json", dir=str(self.data_dir))
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
                json.dump(payload, fh, ensure_ascii=False, indent=2)
                fh.write("\n")
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp_name, self.path)
            try:
                os.chmod(self.path, 0o600)
            except OSError:
                pass
        finally:
            if os.path.exists(tmp_name):
                try:
                    os.unlink(tmp_name)
                except OSError:
                    pass

    # ------------------------------------------------------------------- crud
    def list(self) -> list[dict[str, Any]]:
        with self._lock:
            return [self._hosts[key].to_dict() for key in sorted(self._hosts)]

    def get(self, host_id: str) -> SshHost:
        with self._lock:
            host = self._hosts.get(host_id)
        if host is None:
            raise ToolFailure(NOT_FOUND, f"unknown SSH host: {host_id}", {"host_id": host_id})
        return host

    def create(self, payload: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            name = _clean(payload.get("name"), "name", max_len=80)
            requested = _clean(payload.get("id"), "id", max_len=32)
            host_id = requested or _slug(name)
            if not host_id:
                host_id = "ssh"
            if host_id in self._hosts:
                raise ToolFailure(CONFLICT, f"SSH host already exists: {host_id}", {"host_id": host_id})
            host = SshHost(
                id=host_id,
                name=name or host_id,
                host=_clean(payload.get("host"), "host", max_len=255),
                port=22 if payload.get("port") is None else int(payload["port"]),
                username=_clean(payload.get("username"), "username", max_len=64),
                auth=str(payload.get("auth") or "password"),
                key_file=_clean(payload.get("key_file"), "key_file", max_len=1024),
                known_hosts=_clean(payload.get("known_hosts"), "known_hosts", max_len=1024),
                jump_host_id=_clean(payload.get("jump_host_id"), "jump_host_id", max_len=32),
                term=_clean(payload.get("term") or "xterm-256color", "term", max_len=64),
                connect_timeout_s=10
                if payload.get("connect_timeout_s") is None
                else int(payload["connect_timeout_s"]),
            )
            host.validate()
            self._hosts[host.id] = host
            self._save()
            return host.to_dict()

    def update(self, host_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            current = self._hosts.get(host_id)
            if current is None:
                raise ToolFailure(NOT_FOUND, f"unknown SSH host: {host_id}", {"host_id": host_id})
            merged = current.to_dict()
            for key in (
                "name",
                "host",
                "port",
                "username",
                "auth",
                "key_file",
                "known_hosts",
                "jump_host_id",
                "term",
                "connect_timeout_s",
            ):
                if key in payload and payload[key] is not None:
                    merged[key] = payload[key]
            host = SshHost(
                id=host_id,
                name=_clean(merged["name"], "name", max_len=80) or host_id,
                host=_clean(merged["host"], "host", max_len=255),
                port=int(merged["port"]),
                username=_clean(merged["username"], "username", max_len=64),
                auth=str(merged["auth"]),
                key_file=_clean(merged.get("key_file"), "key_file", max_len=1024),
                known_hosts=_clean(merged.get("known_hosts"), "known_hosts", max_len=1024),
                jump_host_id=_clean(merged.get("jump_host_id"), "jump_host_id", max_len=32),
                term=_clean(merged.get("term") or "xterm-256color", "term", max_len=64),
                connect_timeout_s=int(merged["connect_timeout_s"]),
                created_at=current.created_at,
                updated_at=now_iso(),
            )
            host.validate()
            self._hosts[host_id] = host
            self._save()
            return host.to_dict()

    def delete(self, host_id: str) -> None:
        with self._lock:
            if host_id not in self._hosts:
                raise ToolFailure(NOT_FOUND, f"unknown SSH host: {host_id}", {"host_id": host_id})
            del self._hosts[host_id]
            self._save()
