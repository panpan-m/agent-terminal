"""One SSH connection with a PTY-backed interactive shell.

Paramiko is synchronous, so every blocking call is executed by the caller via
``asyncio.to_thread``; this class only owns threads for the RX reader.  The
ring buffer and subscriber model intentionally mirror the serial session so the
browser, transcript and audit behave the same way.
"""

from __future__ import annotations

import base64
import fnmatch
import hashlib
import os
import posixpath
import queue
import re
import socket
import stat as stat_module
import threading
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

import paramiko

from ..errors import (
    DISCONNECTED,
    INVALID_ARGUMENT,
    ToolFailure,
)
from ..errors import SSH_AUTH_FAILED, SSH_ERROR, SSH_HOST_KEY_CHANGED, SSH_HOST_UNKNOWN, SSH_UNREACHABLE
from ..ring import ReadSlice, RingBuffer
from ..transcript import TranscriptWriter, now_iso
from .profiles import SshHost


class SshState(str, Enum):
    CONNECTING = "connecting"
    OPEN = "open"
    RECONNECTING = "reconnecting"
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
        self.agent_visible = False
        self.ring = RingBuffer(8 * 1024 * 1024)
        self.rx_bytes = 0
        self.tx_bytes = 0
        self.last_write_source: str | None = None
        self.last_tx_at: str | None = None
        self.agent_last_action: str | None = None
        self.agent_last_at: str | None = None
        self.agent_action_count = 0
        self.agent_last_command: str | None = None
        self.agent_last_output: str | None = None
        self.agent_last_output_truncated = False
        self.last_exec_exit_code: int | None = None
        self.last_exec_elapsed_ms: int | None = None
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
        self._jump_client: Any | None = None
        self._jump_transport: Any | None = None
        self._sftp: Any | None = None
        self._sftp_lock = threading.Lock()
        self._client_factory = client_factory or paramiko.SSHClient
        self._stop = threading.Event()
        self._reader: threading.Thread | None = None
        self._write_lock = threading.Lock()
        self._sub_lock = threading.Lock()
        self._subs: list[SshSubscriber] = []
        self._auth_args: dict[str, Any] = {}
        self._reconnecting = False
        self._reconnect_thread: threading.Thread | None = None
        self.reconnect_count = 0
        self.auto_reconnect = bool(host.auto_reconnect)
        self._last_cols = 120
        self._last_rows = 30
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
    def _configure_known_hosts(self, client: Any, profile: SshHost) -> None:
        client.load_system_host_keys()
        known_hosts = os.path.expanduser(profile.known_hosts) if profile.known_hosts else ""
        if known_hosts:
            if not os.path.exists(known_hosts):
                raise ToolFailure(
                    SSH_HOST_UNKNOWN,
                    f"known_hosts file does not exist: {known_hosts}",
                    {"host_id": profile.id, "known_hosts": known_hosts},
                )
            client.load_host_keys(known_hosts)
        client.set_missing_host_key_policy(paramiko.RejectPolicy())

    def _connect_kwargs(self, profile: SshHost, password: str | None, passphrase: str | None) -> dict[str, Any]:
        kwargs: dict[str, Any] = {
            "hostname": profile.host,
            "port": int(profile.port),
            "username": profile.username,
            "timeout": int(profile.connect_timeout_s),
            "banner_timeout": int(profile.connect_timeout_s),
            "auth_timeout": int(profile.connect_timeout_s),
            "allow_agent": False,
            "look_for_keys": False,
        }
        if profile.auth == "password":
            if not password:
                raise ToolFailure(
                    SSH_AUTH_FAILED,
                    "password is required for this host",
                    {"host_id": profile.id},
                )
            kwargs["password"] = password
        elif profile.auth == "key":
            key_file = os.path.expanduser(profile.key_file)
            if not os.path.isfile(key_file):
                raise ToolFailure(
                    SSH_AUTH_FAILED,
                    f"private key file not found or unreadable: {key_file}",
                    {"host_id": profile.id, "key_file": key_file},
                )
            kwargs["key_filename"] = key_file
            if passphrase:
                kwargs["passphrase"] = passphrase
        elif profile.auth == "agent":
            kwargs["allow_agent"] = True
        else:
            raise ToolFailure(
                INVALID_ARGUMENT,
                "keyboard-interactive hosts cannot use the jump-host path",
                {"host_id": profile.id},
            )
        return kwargs

    def _known_key_status(self, profile: SshHost, key: Any) -> tuple[str, Any]:
        known = paramiko.HostKeys()
        system_known = os.path.expanduser("~/.ssh/known_hosts")
        if os.path.isfile(system_known):
            known.load(system_known)
        if profile.known_hosts and os.path.isfile(os.path.expanduser(profile.known_hosts)):
            known.load(os.path.expanduser(profile.known_hosts))
        lookup = profile.host if int(profile.port) == 22 else f"[{profile.host}]:{profile.port}"
        entry = known.lookup(lookup)
        if not entry:
            return "unknown", None
        expected = entry.get(key.get_name())
        if expected is not None and expected.asbytes() == key.asbytes():
            return "known", expected
        return "changed", expected

    def _connect_interactive(self, password: str | None, responses: list[str]) -> Any:
        transport = paramiko.Transport((self.host.host, int(self.host.port)))
        try:
            transport.start_client(timeout=int(self.host.connect_timeout_s))
            key = transport.get_remote_server_key()
            status, _ = self._known_key_status(self.host, key)
            if status == "unknown":
                raise ToolFailure(
                    SSH_HOST_UNKNOWN,
                    "SSH host is not in known_hosts; add its key before connecting",
                    {
                        "host_id": self.host.id,
                        "host": self.host.host,
                        "port": self.host.port,
                        "fingerprint": _fingerprint(key),
                    },
                )
            if status == "changed":
                raise ToolFailure(
                    SSH_HOST_KEY_CHANGED,
                    "SSH host key changed; refusing to connect",
                    {"host_id": self.host.id, "host": self.host.host, "actual_fingerprint": _fingerprint(key)},
                )
            answers = list(responses)
            if password:
                answers.insert(0, password)

            def handler(title: str, instructions: str, prompts: list[tuple[str, bool]]) -> list[str]:
                del title, instructions
                out = []
                for _prompt, _echo in prompts:
                    out.append(answers.pop(0) if answers else "")
                return out

            transport.auth_interactive(self.host.username, handler)
            client = self._client_factory()
            client._transport = transport
            client._policy = paramiko.RejectPolicy()
            return client
        except Exception:
            try:
                transport.close()
            except Exception:
                pass
            raise

    def connect(
        self,
        *,
        password: str | None = None,
        passphrase: str | None = None,
        jump_password: str | None = None,
        jump_passphrase: str | None = None,
        responses: list[str] | None = None,
        cols: int = 120,
        rows: int = 30,
    ) -> None:
        if self.state is SshState.OPEN:
            return
        self._auth_args = {
            "password": password,
            "passphrase": passphrase,
            "jump_password": jump_password,
            "jump_passphrase": jump_passphrase,
            "responses": list(responses or []),
        }
        self.state = SshState.CONNECTING
        self.last_error = None
        self.last_error_code = None
        client = self._client_factory()
        try:
            if self.host.auth == "interactive":
                if self.host.jump_host_id:
                    raise ToolFailure(
                        INVALID_ARGUMENT,
                        "keyboard-interactive auth through a jump host is not supported yet",
                        {"host_id": self.host.id},
                    )
                client = self._connect_interactive(password, responses or [])
                transport = client.get_transport()
            else:
                self._configure_known_hosts(client, self.host)
                kwargs = self._connect_kwargs(self.host, password, passphrase)
                if self.host.jump_host_id:
                    jump = self.manager.profiles.get(self.host.jump_host_id)
                    jump_client = self._client_factory()
                    try:
                        self._configure_known_hosts(jump_client, jump)
                        jump_client.connect(**self._connect_kwargs(jump, jump_password, jump_passphrase))
                        jump_transport = jump_client.get_transport()
                        if jump_transport is None:
                            raise paramiko.SSHException("jump host has no transport")
                        jump_channel = jump_transport.open_channel(
                            "direct-tcpip",
                            (self.host.host, int(self.host.port)),
                            ("127.0.0.1", 0),
                        )
                    except Exception as exc:
                        self._safe_close(jump_client)
                        raise ToolFailure(
                            SSH_ERROR,
                            f"jump host {jump.id} failed: {exc}",
                            {"host_id": self.host.id, "jump_host_id": jump.id},
                        ) from exc
                    self._jump_client = jump_client
                    self._jump_transport = jump_transport
                    kwargs["sock"] = jump_channel
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
            self._last_cols = max(20, min(int(cols), 400))
            self._last_rows = max(5, min(int(rows), 200))
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
            self._reconnecting = False
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
        jump = self._jump_client
        self._jump_client = None
        self._jump_transport = None
        if jump is not None:
            try:
                jump.close()
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
            if not self._reconnecting:
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
        if self._stop.is_set():
            return
        self.last_error = message or None
        self.last_error_code = DISCONNECTED
        self.transcript.event("disconnect", reason=message)
        try:
            self.audit.write("ssh.disconnect", session=self.session_id, host_id=self.host.id, reason=message)
        except Exception:
            pass
        self._close_transport()
        if self.auto_reconnect and self._auth_args and not self._stop.is_set():
            self.state = SshState.RECONNECTING
            self._broadcast_status()
            self._start_reconnect()
            return
        self.state = SshState.CLOSED
        self.ring.close()
        try:
            self.transcript.close()
        except Exception:
            pass
        self._broadcast_status()

    def _close_transport(self) -> None:
        channel, client, sftp = self._channel, self._client, self._sftp
        jump = self._jump_client
        self._channel = None
        self._client = None
        self._sftp = None
        self._jump_client = None
        self._jump_transport = None
        if sftp is not None:
            try:
                sftp.close()
            except Exception:
                pass
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
        if jump is not None:
            try:
                jump.close()
            except Exception:
                pass

    def _start_reconnect(self) -> None:
        with self._sub_lock:
            if self._reconnect_thread is not None and self._reconnect_thread.is_alive():
                return
            self._reconnect_thread = threading.Thread(
                target=self._reconnect_loop, name=f"ssh-reconnect-{self.session_id}", daemon=True
            )
            self._reconnect_thread.start()

    def _reconnect_loop(self) -> None:
        delay = 2.0
        attempts = 0
        while not self._stop.is_set() and attempts < 8:
            attempts += 1
            if self._stop.wait(delay):
                return
            if self._stop.is_set():
                return
            self._reconnecting = True
            self.state = SshState.RECONNECTING
            self._broadcast_status()
            try:
                self.connect(
                    **self._auth_args,
                    cols=self._last_cols,
                    rows=self._last_rows,
                )
                self.reconnect_count += 1
                self._reconnecting = False
                self.transcript.event("reconnected", attempt=attempts)
                try:
                    self.audit.write(
                        "ssh.reconnected", session=self.session_id, host_id=self.host.id, attempt=attempts
                    )
                except Exception:
                    pass
                return
            except ToolFailure as exc:
                self.last_error = f"reconnect attempt {attempts}: {exc.message}"
                self.last_error_code = exc.code
                self._broadcast_status()
                if exc.code in (SSH_AUTH_FAILED, SSH_HOST_KEY_CHANGED, SSH_HOST_UNKNOWN):
                    break
                delay = min(delay * 2, 30.0)
        if self._stop.is_set():
            return
        self._reconnecting = False
        self.state = SshState.CLOSED
        self.ring.close()
        try:
            self.transcript.event("reconnect_failed", attempts=attempts)
            self.transcript.close()
        except Exception:
            pass
        try:
            self.audit.write("ssh.reconnect_failed", session=self.session_id, host_id=self.host.id, attempts=attempts)
        except Exception:
            pass
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

    def expect(
        self,
        pattern: str,
        *,
        mode: str = "literal",
        cursor: int | None = None,
        timeout_ms: int = 5000,
        max_bytes: int = 16384,
        ignore_case: bool = False,
    ) -> tuple[ReadSlice, bool, str | None, list[str], bool]:
        if mode not in ("literal", "regex", "glob"):
            raise ToolFailure(INVALID_ARGUMENT, "mode must be literal, regex or glob")
        flags = re.IGNORECASE if ignore_case else 0
        try:
            if mode == "literal":
                matcher = re.compile(re.escape(pattern), flags)
            elif mode == "glob":
                matcher = re.compile(fnmatch.translate(pattern), flags)
            else:
                matcher = re.compile(pattern, flags)
        except re.error as exc:
            raise ToolFailure(INVALID_ARGUMENT, f"invalid pattern: {exc}") from exc
        start = self.ring.head if cursor is None else max(0, int(cursor))
        deadline = time.monotonic() + max(1, int(timeout_ms)) / 1000.0
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
                hit = matcher.search(text)
                if hit is not None:
                    matched, match_text, groups = True, hit.group(0), list(hit.groups())
                    break
                if len(collected) >= max_bytes:
                    truncated = True
                    break
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            self.ring.wait_for_data(start, min(remaining, 0.05))
        data = bytes(collected)
        sl = ReadSlice(
            start=(self.ring.head if cursor is None else int(cursor)),
            end=(self.ring.head if cursor is None else int(cursor)) + len(data),
            data=data,
            head=self.ring.head,
            gap=False,
            truncated=truncated,
        )
        return sl, matched, match_text, groups, not matched

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
        self._note_tx(source, command=data.decode("utf-8", "replace") if source == "agent" else None)
        return len(data)

    @staticmethod
    def _preview_text(text: str, limit: int = 4000) -> tuple[str, bool]:
        if len(text) <= limit:
            return text, False
        return text[:limit] + "\n… [truncated]", True

    def _note_tx(
        self,
        source: str,
        *,
        action: str | None = None,
        command: str | None = None,
        output: str | None = None,
        exit_code: int | None = None,
        elapsed_ms: int | None = None,
    ) -> None:
        self.last_write_source = source
        self.last_tx_at = now_iso()
        if source == "agent":
            self.agent_last_action = action or "write"
            self.agent_last_at = self.last_tx_at
            self.agent_action_count += 1
            if command is not None:
                self.agent_last_command, _ = self._preview_text(command, 1000)
            self.agent_last_output = None
            self.agent_last_output_truncated = False
            if output is not None:
                self.agent_last_output, self.agent_last_output_truncated = self._preview_text(output)
            if exit_code is not None:
                self.last_exec_exit_code = int(exit_code)
            if elapsed_ms is not None:
                self.last_exec_elapsed_ms = int(elapsed_ms)
        self._broadcast_status()
        with self._sub_lock:
            for sub in list(self._subs):
                sub.put(
                    {
                        "type": "agent",
                        "action": self.agent_last_action if source == "agent" else action or "write",
                        "source": source,
                        "at": self.last_tx_at,
                        "command": self.agent_last_command if source == "agent" else None,
                        "output": self.agent_last_output if source == "agent" else None,
                        "output_truncated": self.agent_last_output_truncated if source == "agent" else False,
                        "exit_code": self.last_exec_exit_code if source == "agent" else None,
                        "elapsed_ms": self.last_exec_elapsed_ms if source == "agent" else None,
                    }
                )

    def _note_exec(
        self,
        command: str,
        exit_code: int,
        elapsed_ms: int,
        stdout: str,
        stderr: str,
    ) -> None:
        output = stdout
        if stderr:
            output = f"{stdout}\n[stderr]\n{stderr}" if stdout else f"[stderr]\n{stderr}"
        self._note_tx(
            "agent",
            action="exec",
            command=command,
            output=output,
            exit_code=exit_code,
            elapsed_ms=elapsed_ms,
        )

    def resize(self, cols: int, rows: int) -> None:
        if self._channel is None or self.state is not SshState.OPEN:
            return
        cols = max(20, min(int(cols), 400))
        rows = max(5, min(int(rows), 200))
        self._last_cols = cols
        self._last_rows = rows
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
        elapsed_ms = int((time.monotonic() - started) * 1000)
        self._note_exec(
            command,
            int(code),
            elapsed_ms,
            out.decode("utf-8", "replace"),
            err.decode("utf-8", "replace"),
        )
        return {
            "command": command,
            "stdout": out.decode("utf-8", "replace"),
            "stderr": err.decode("utf-8", "replace"),
            "exit_code": int(code),
            "elapsed_ms": elapsed_ms,
        }

    # ------------------------------------------------------------------ sftp
    @staticmethod
    def _remote_path(path: str) -> str:
        if not path or not str(path).startswith("/"):
            raise ToolFailure(INVALID_ARGUMENT, "SFTP path must be absolute")
        normalized = posixpath.normpath(str(path))
        if normalized.startswith("//"):
            normalized = "/" + normalized.lstrip("/")
        return normalized

    def _sftp_client(self) -> Any:
        if self._sftp is None:
            if self._client is None or self.state is not SshState.OPEN:
                raise ToolFailure(DISCONNECTED, "SSH session is not open")
            try:
                transport = self._client.get_transport()
                if transport is None:
                    raise paramiko.SSHException("no SSH transport")
                self._sftp = paramiko.SFTPClient.from_transport(transport)
            except Exception as exc:
                raise ToolFailure(SSH_ERROR, f"cannot open SFTP subsystem: {exc}") from exc
        return self._sftp

    def sftp_list(self, path: str) -> dict[str, Any]:
        remote = self._remote_path(path)
        try:
            with self._sftp_lock:
                attrs = self._sftp_client().listdir_attr(remote)
        except ToolFailure:
            raise
        except Exception as exc:
            raise ToolFailure(SSH_ERROR, f"SFTP list failed: {exc}") from exc
        entries = []
        for attr in sorted(attrs, key=lambda item: (not stat_module.S_ISDIR(item.st_mode), item.filename.lower())):
            mode = int(attr.st_mode or 0)
            entries.append(
                {
                    "name": attr.filename,
                    "path": posixpath.join(remote, attr.filename),
                    "size": int(attr.st_size or 0),
                    "mtime": int(attr.st_mtime or 0),
                    "mode": oct(mode & 0o777),
                    "is_dir": stat_module.S_ISDIR(mode),
                    "is_link": stat_module.S_ISLNK(mode),
                }
            )
        return {"path": remote, "entries": entries}

    def sftp_read(self, path: str, *, max_bytes: int = 32 * 1024 * 1024) -> bytes:
        remote = self._remote_path(path)
        try:
            with self._sftp_lock:
                with self._sftp_client().open(remote, "rb") as handle:
                    data = handle.read(max_bytes + 1)
        except ToolFailure:
            raise
        except Exception as exc:
            raise ToolFailure(SSH_ERROR, f"SFTP download failed: {exc}") from exc
        if len(data) > max_bytes:
            raise ToolFailure(INVALID_ARGUMENT, f"file larger than {max_bytes} bytes")
        return data

    def sftp_write(self, path: str, data: bytes) -> int:
        remote = self._remote_path(path)
        try:
            with self._sftp_lock:
                with self._sftp_client().open(remote, "wb") as handle:
                    handle.write(data)
        except ToolFailure:
            raise
        except Exception as exc:
            raise ToolFailure(SSH_ERROR, f"SFTP upload failed: {exc}") from exc
        return len(data)

    def sftp_mkdir(self, path: str) -> str:
        remote = self._remote_path(path)
        try:
            with self._sftp_lock:
                self._sftp_client().mkdir(remote)
        except ToolFailure:
            raise
        except Exception as exc:
            raise ToolFailure(SSH_ERROR, f"SFTP mkdir failed: {exc}") from exc
        return remote

    def sftp_delete(self, path: str) -> str:
        remote = self._remote_path(path)
        try:
            with self._sftp_lock:
                client = self._sftp_client()
                attr = client.stat(remote)
                if stat_module.S_ISDIR(attr.st_mode or 0):
                    client.rmdir(remote)
                else:
                    client.remove(remote)
        except ToolFailure:
            raise
        except Exception as exc:
            raise ToolFailure(SSH_ERROR, f"SFTP delete failed: {exc}") from exc
        return remote

    def sftp_rename(self, old_path: str, new_path: str) -> tuple[str, str]:
        old = self._remote_path(old_path)
        new = self._remote_path(new_path)
        try:
            with self._sftp_lock:
                self._sftp_client().rename(old, new)
        except ToolFailure:
            raise
        except Exception as exc:
            raise ToolFailure(SSH_ERROR, f"SFTP rename failed: {exc}") from exc
        return old, new

    # ------------------------------------------------------------------ close
    def close(self) -> None:
        if self.state is SshState.CLOSED and self._stop.is_set():
            return
        self._stop.set()
        self._auth_args = {}
        self._reconnecting = False
        channel, client = self._channel, self._client
        sftp = self._sftp
        self._channel = None
        self._client = None
        self._sftp = None
        if sftp is not None:
            try:
                sftp.close()
            except Exception:
                pass
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
        jump = self._jump_client
        self._jump_client = None
        self._jump_transport = None
        if jump is not None:
            try:
                jump.close()
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
            "jump_host_id": self.host.jump_host_id or None,
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
            "agent_visible": self.agent_visible,
            "last_write_source": self.last_write_source,
            "last_tx_at": self.last_tx_at,
            "agent_last_action": self.agent_last_action,
            "agent_last_at": self.agent_last_at,
            "agent_action_count": self.agent_action_count,
            "agent_last_command": self.agent_last_command,
            "agent_last_output": self.agent_last_output,
            "agent_last_output_truncated": self.agent_last_output_truncated,
            "last_exec_exit_code": self.last_exec_exit_code,
            "last_exec_elapsed_ms": self.last_exec_elapsed_ms,
            "auto_reconnect": self.auto_reconnect,
            "reconnect_count": self.reconnect_count,
        }
