"""One SSH connection with a PTY-backed interactive shell.

Paramiko is synchronous, so every blocking call is executed by the caller via
``asyncio.to_thread``; this class only owns threads for the RX reader.  The
ring buffer and subscriber model intentionally mirror the serial session so the
browser, transcript and audit behave the same way.
"""

from __future__ import annotations

import base64
import hashlib
import os
import queue
import socket
import threading
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

import paramiko

from ..errors import (
    DISCONNECTED,
    ToolFailure,
)
from ..errors import SSH_AUTH_FAILED, SSH_ERROR, SSH_HOST_KEY_CHANGED, SSH_HOST_UNKNOWN, SSH_UNREACHABLE
from ..ring import ReadSlice, RingBuffer
from ..transcript import TranscriptWriter, now_iso
from .profiles import SshHost


class SshState(str, Enum):
    CONNECTING = "connecting"
    OPEN = "open"
    CLOSED = "closed"
    ERROR = "error"


@dataclass
class SshSubscriber:
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


def _fingerprint(key: Any) -> str:
    digest = hashlib.sha256(key.asbytes()).digest()
    return "SHA256:" + base64.b64encode(digest).decode("ascii").rstrip("=")


def _key_type(key: Any) -> str:
    try:
        return str(key.get_name())
    except Exception:  # pragma: no cover - defensive
        return "unknown"


class SshSession:
    def __init__(
        self,
        host: SshHost,
        manager: Any,
        session_id: str,
        *,
        client_factory: Any | None = None,
    ) -> None:
        self.host = host
        self.manager = manager
        self.session_id = session_id
        self.state = SshState.CONNECTING
        self.control_owner = "human"
        self.ring = RingBuffer(8 * 1024 * 1024)
        self.rx_bytes = 0
        self.tx_bytes = 0
        self.opened_at: str | None = None
        self.last_error: str | None = None
        self.last_error_code: str | None = None
        self.host_key_fingerprint: str | None = None
        self.host_key_type: str | None = None
        self.remote_version: str | None = None
        self.cipher: str | None = None
        self.mac: str | None = None
        self._client: Any | None = None
        self._channel: Any | None = None
        self._client_factory = client_factory or paramiko.SSHClient
        self._stop = threading.Event()
        self._reader: threading.Thread | None = None
        self._write_lock = threading.Lock()
        self._sub_lock = threading.Lock()
        self._subs: list[SshSubscriber] = []
        self.transcript: TranscriptWriter = manager.transcripts.writer(session_id, True)
        self.audit = manager.audit

    # ------------------------------------------------------------------ props
    @property
    def id(self) -> str:
        return self.session_id

    @property
    def name(self) -> str:
        return self.host.name or self.host.id

    @property
    def is_open(self) -> bool:
        return self.state is SshState.OPEN

    # --------------------------------------------------------------- lifecycle
    def connect(
        self,
        *,
        password: str | None = None,
        passphrase: str | None = None,
        cols: int = 120,
        rows: int = 30,
    ) -> None:
        if self.state is SshState.OPEN:
            return
        self.state = SshState.CONNECTING
        self.last_error = None
        self.last_error_code = None
        client = self._client_factory()
        try:
            client.load_system_host_keys()
            known_hosts = os.path.expanduser(self.host.known_hosts) if self.host.known_hosts else ""
            if known_hosts:
                if not os.path.exists(known_hosts):
                    raise ToolFailure(
                        SSH_HOST_UNKNOWN,
                        f"known_hosts file does not exist: {known_hosts}",
                        {"host_id": self.host.id, "known_hosts": known_hosts},
                    )
                client.load_host_keys(known_hosts)
            client.set_missing_host_key_policy(paramiko.RejectPolicy())

            kwargs: dict[str, Any] = {
                "hostname": self.host.host,
                "port": int(self.host.port),
                "username": self.host.username,
                "timeout": int(self.host.connect_timeout_s),
                "banner_timeout": int(self.host.connect_timeout_s),
                "auth_timeout": int(self.host.connect_timeout_s),
                "allow_agent": False,
                "look_for_keys": False,
            }
            if self.host.auth == "password":
                if not password:
                    raise ToolFailure(
                        SSH_AUTH_FAILED,
                        "password is required for this host",
                        {"host_id": self.host.id},
                    )
                kwargs["password"] = password
            else:
                key_file = os.path.expanduser(self.host.key_file)
                if not os.path.isfile(key_file):
                    raise ToolFailure(
                        SSH_AUTH_FAILED,
                        f"private key file not found or unreadable: {key_file}",
                        {"host_id": self.host.id, "key_file": key_file},
                    )
                kwargs["key_filename"] = key_file
                if passphrase:
                    kwargs["passphrase"] = passphrase

            client.connect(**kwargs)
            transport = client.get_transport()
            if transport is None:
                raise paramiko.SSHException("no SSH transport after connect")
            key = transport.get_remote_server_key()
            self.host_key_fingerprint = _fingerprint(key)
            self.host_key_type = _key_type(key)
            self.remote_version = getattr(transport, "remote_version", None)
            self.cipher = getattr(transport, "local_cipher", None) or getattr(transport, "remote_cipher", None)
            self.mac = getattr(transport, "local_mac", None) or getattr(transport, "remote_mac", None)

            self._channel = client.invoke_shell(
                term=self.host.term,
                width=max(20, min(int(cols), 400)),
                height=max(5, min(int(rows), 200)),
            )
            self._channel.settimeout(0.2)
            self._client = client
            self.state = SshState.OPEN
            self.opened_at = now_iso()
            self._stop.clear()
            self._reader = threading.Thread(
                target=self._reader_loop, name=f"ssh-rx-{self.session_id}", daemon=True
            )
            self.transcript.event(
                "open",
                host=self.host.host,
                port=self.host.port,
                username=self.host.username,
                host_key=self.host_key_fingerprint,
                term=self.host.term,
            )
            self._reader.start()
            self.audit.write(
                "ssh.connect",
                session=self.session_id,
                host_id=self.host.id,
                host=self.host.host,
                port=self.host.port,
                username=self.host.username,
                auth=self.host.auth,
            )
            self._broadcast_status()
        except ToolFailure as exc:
            self._safe_close(client)
            self._fail(exc.code, exc.message)
            raise
        except paramiko.BadHostKeyException as exc:
            self._safe_close(client)
            expected = _fingerprint(exc.expected_key) if getattr(exc, "expected_key", None) else None
            actual = _fingerprint(exc.key) if getattr(exc, "key", None) else None
            self._fail(SSH_HOST_KEY_CHANGED, str(exc))
            raise ToolFailure(
                SSH_HOST_KEY_CHANGED,
                "SSH host key changed; refusing to connect",
                {
                    "host_id": self.host.id,
                    "host": self.host.host,
                    "expected_fingerprint": expected,
                    "actual_fingerprint": actual,
                },
            ) from exc
        except paramiko.AuthenticationException as exc:
            self._safe_close(client)
            self._fail(SSH_AUTH_FAILED, str(exc))
            raise ToolFailure(
                SSH_AUTH_FAILED,
                f"SSH authentication failed for {self.host.username}@{self.host.host}",
                {"host_id": self.host.id},
            ) from exc
        except paramiko.SSHException as exc:
            self._safe_close(client)
            text = str(exc)
            if "known_hosts" in text or "not found in" in text:
                fingerprint = self._probe_fingerprint()
                self._fail(SSH_HOST_UNKNOWN, text)
                raise ToolFailure(
                    SSH_HOST_UNKNOWN,
                    "SSH host is not in known_hosts; add its key before connecting",
                    {
                        "host_id": self.host.id,
                        "host": self.host.host,
                        "port": self.host.port,
                        "fingerprint": fingerprint,
                        "known_hosts": os.path.expanduser(self.host.known_hosts) or "~/.ssh/known_hosts",
                    },
                ) from exc
            self._fail(SSH_ERROR, text)
            raise ToolFailure(SSH_ERROR, f"SSH connection failed: {text}", {"host_id": self.host.id}) from exc
        except (socket.timeout, TimeoutError) as exc:
            self._safe_close(client)
            self._fail(SSH_UNREACHABLE, str(exc))
            raise ToolFailure(
                SSH_UNREACHABLE,
                f"SSH connection to {self.host.host}:{self.host.port} timed out",
                {"host_id": self.host.id},
            ) from exc
        except OSError as exc:
            self._safe_close(client)
            self._fail(SSH_UNREACHABLE, str(exc))
            raise ToolFailure(
                SSH_UNREACHABLE,
                f"cannot reach {self.host.host}:{self.host.port}: {exc}",
                {"host_id": self.host.id},
            ) from exc

    def _safe_close(self, client: Any) -> None:
        try:
            client.close()
        except Exception:
            pass

    def _probe_fingerprint(self) -> str | None:
        try:
            probe = paramiko.Transport((self.host.host, int(self.host.port)))
            try:
                probe.start_client(timeout=min(5, int(self.host.connect_timeout_s)))
                key = probe.get_remote_server_key()
                return _fingerprint(key)
            finally:
                probe.close()
        except Exception:
            return None

    def _fail(self, code: str, message: str) -> None:
        self.state = SshState.ERROR
        self.last_error = message
        self.last_error_code = code
        try:
            self.audit.write("ssh.connect_failed", session=self.session_id, host_id=self.host.id, code=code)
        except Exception:
            pass
        try:
            self.transcript.event("connect_failed", code=code)
            self.transcript.close()
        except Exception:
            pass
        self._broadcast_status()

    # ------------------------------------------------------------------ reader
    def _reader_loop(self) -> None:
        while not self._stop.is_set():
            channel = self._channel
            if channel is None:
                return
            try:
                data = channel.recv(8192)
            except socket.timeout:
                continue
            except Exception as exc:  # pragma: no cover - transport-specific
                self._on_closed(str(exc))
                return
            if not data:
                self._on_closed("remote closed the SSH channel")
                return
            self._ingest(data)

    def _ingest(self, data: bytes) -> None:
        with self._sub_lock:
            offset = self.ring.append(data)
            self.rx_bytes += len(data)
            self.transcript.data("rx", offset, data, "ssh")
            for sub in list(self._subs):
                sub.put({"type": "rx", "offset": offset, "data": data})

    def _on_closed(self, message: str) -> None:
        if self._stop.is_set() and self.state is SshState.CLOSED:
            return
        self.state = SshState.CLOSED
        self.last_error = message or None
        self.last_error_code = DISCONNECTED
        self.transcript.event("close", reason=message)
        try:
            self.audit.write("ssh.close", session=self.session_id, host_id=self.host.id, reason=message)
        except Exception:
            pass
        self.ring.close()
        self._broadcast_status()

    # -------------------------------------------------------------- subscribers
    def subscribe(
        self, replay_bytes: int = 0, maxsize: int = 1024, cursor: int | None = None
    ) -> SshSubscriber:
        sub = SshSubscriber(maxsize=maxsize)
        replay = b""
        offset = self.ring.head
        dropped = 0
        with self._sub_lock:
            if cursor is not None:
                sl = self.ring.read(cursor=max(0, int(cursor)), max_bytes=1024 * 1024)
                replay, offset = sl.data, sl.start
                dropped = sl.lost_bytes if sl.gap else 0
            elif replay_bytes > 0:
                sl = self.ring.read(tail_bytes=replay_bytes)
                replay, offset = sl.data, sl.start
            self._subs.append(sub)
        if dropped:
            sub.put({"type": "overflow", "dropped": dropped})
        if replay:
            sub.put({"type": "replay", "offset": offset, "data": replay})
        sub.put({"type": "status", "status": self.status()})
        return sub

    def unsubscribe(self, sub: SshSubscriber) -> None:
        with self._sub_lock:
            if sub in self._subs:
                self._subs.remove(sub)

    def _broadcast_status(self) -> None:
        payload = {"type": "status", "status": self.status()}
        with self._sub_lock:
            for sub in list(self._subs):
                sub.put(payload)

    # --------------------------------------------------------------- read path
    def read(
        self,
        *,
        cursor: int | None = None,
        tail_bytes: int | None = None,
        max_bytes: int = 16384,
    ) -> ReadSlice:
        return self.ring.read(cursor, max_bytes, tail_bytes=tail_bytes)

    # -------------------------------------------------------------- write path
    def write_bytes(self, data: bytes, *, source: str = "human") -> int:
        if self.state is not SshState.OPEN or self._channel is None:
            raise ToolFailure(DISCONNECTED, f"SSH session is not open (state={self.state.value})")
        if not data:
            return 0
        with self._write_lock:
            try:
                self._channel.sendall(data)
            except Exception as exc:
                self._on_closed(str(exc))
                raise ToolFailure(DISCONNECTED, f"SSH write failed: {exc}") from exc
            self.tx_bytes += len(data)
            self.transcript.data("tx", self.ring.head, data, source)
            with self._sub_lock:
                for sub in list(self._subs):
                    sub.put({"type": "tx", "data": data, "source": source})
        return len(data)

    def resize(self, cols: int, rows: int) -> None:
        if self._channel is None or self.state is not SshState.OPEN:
            return
        cols = max(20, min(int(cols), 400))
        rows = max(5, min(int(rows), 200))
        try:
            self._channel.resize_pty(width=cols, height=rows)
        except Exception as exc:
            raise ToolFailure(SSH_ERROR, f"resize failed: {exc}") from exc

    def exec(self, command: str, *, timeout_ms: int = 10000) -> dict[str, Any]:
        if self._client is None or self.state is not SshState.OPEN:
            raise ToolFailure(DISCONNECTED, "SSH session is not open")
        timeout = max(1, min(int(timeout_ms), 120000)) / 1000.0
        started = time.monotonic()
        try:
            stdin, stdout, stderr = self._client.exec_command(command, timeout=timeout)
            del stdin
            channel = stdout.channel
            channel.settimeout(timeout)
            out = stdout.read()
            err = stderr.read()
            code = channel.recv_exit_status()
        except socket.timeout as exc:
            raise ToolFailure("TIMEOUT", f"SSH exec timed out after {timeout_ms} ms") from exc
        except Exception as exc:
            raise ToolFailure(SSH_ERROR, f"SSH exec failed: {exc}") from exc
        return {
            "command": command,
            "stdout": out.decode("utf-8", "replace"),
            "stderr": err.decode("utf-8", "replace"),
            "exit_code": int(code),
            "elapsed_ms": int((time.monotonic() - started) * 1000),
        }

    # ------------------------------------------------------------------ close
    def close(self) -> None:
        if self.state is SshState.CLOSED and self._stop.is_set():
            return
        self._stop.set()
        channel, client = self._channel, self._client
        self._channel = None
        self._client = None
        if channel is not None:
            try:
                channel.close()
            except Exception:
                pass
        if client is not None:
            try:
                client.close()
            except Exception:
                pass
        if self._reader is not None and self._reader.is_alive():
            self._reader.join(timeout=1.0)
        self._reader = None
        if self.state is not SshState.ERROR:
            self.state = SshState.CLOSED
        self.ring.close()
        self.transcript.event("close")
        try:
            self.audit.write("ssh.disconnect", session=self.session_id, host_id=self.host.id)
        except Exception:
            pass
        self.transcript.close()
        self._broadcast_status()

    # ------------------------------------------------------------------ status
    def status(self) -> dict[str, Any]:
        return {
            "session_id": self.session_id,
            "host_id": self.host.id,
            "name": self.name,
            "host": self.host.host,
            "port": self.host.port,
            "username": self.host.username,
            "auth": self.host.auth,
            "state": self.state.value,
            "host_key_fingerprint": self.host_key_fingerprint,
            "host_key_type": self.host_key_type,
            "remote_version": self.remote_version,
            "cipher": self.cipher,
            "mac": self.mac,
            "rx_bytes": self.rx_bytes,
            "tx_bytes": self.tx_bytes,
            "rx_start": self.ring.start,
            "rx_head": self.ring.head,
            "buffer_bytes": self.ring.capacity,
            "opened_at": self.opened_at,
            "last_error": self.last_error,
            "last_error_code": self.last_error_code,
            "control_owner": self.control_owner,
        }
