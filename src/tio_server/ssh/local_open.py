"""Open remote files with the OS default application and upload saves back.

MobaXterm-style local open: the file is downloaded to a deterministic
per-session temp path (so re-opening reuses the same local copy and unsaved
edits survive), launched with the OS file association, and a watcher thread
polls mtime/size.  Once a save settles (unchanged for ``SETTLE_SECONDS``)
the file is streamed back over SFTP.
"""

from __future__ import annotations

import hashlib
import os
import posixpath
import re
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

from ..errors import INVALID_ARGUMENT, SSH_ERROR, ToolFailure
from ..transcript import AuditLog

MAX_OPEN_BYTES = 128 * 1024 * 1024
POLL_SECONDS = 1.0
SETTLE_SECONDS = 1.5
MAX_UPLOAD_FAILURES = 5

# characters Windows filenames cannot contain; POSIX names may include them
_INVALID_FS_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def _safe_name(name: str, max_length: int = 120) -> str:
    cleaned = _INVALID_FS_CHARS.sub("_", name).rstrip(" .")
    if not cleaned:
        return "file"
    if len(cleaned) <= max_length:
        return cleaned
    # keep the extension (what the OS association lookup needs) when trimming
    stem, dot, suffix = cleaned.rpartition(".")
    if dot and len(suffix) <= 16:
        return f"{stem[: max_length - len(suffix) - 1]}.{suffix}"
    return cleaned[:max_length]


class _Tracked:
    __slots__ = ("session", "session_id", "remote", "local", "fingerprint", "dirty_since", "failures")

    def __init__(self, session: Any, remote: str, local: Path, fingerprint: tuple[int, int]) -> None:
        self.session = session
        self.session_id = session.session_id
        self.remote = remote
        self.local = local
        self.fingerprint = fingerprint
        self.dirty_since: float | None = None
        self.failures = 0


class LocalOpenManager:
    def __init__(self, audit: AuditLog, root: Path | None = None) -> None:
        self._audit = audit
        self._root = root or Path(tempfile.gettempdir()) / "tio-open"
        self._lock = threading.Lock()
        self._tracked: dict[tuple[str, str], _Tracked] = {}
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    # ------------------------------------------------------------------ open
    def open_remote(self, session: Any, remote_path: str) -> dict[str, Any]:
        info = session.sftp_stat(remote_path)
        if info["is_dir"]:
            raise ToolFailure(INVALID_ARGUMENT, "cannot open a directory with a local application")
        if info["size"] > MAX_OPEN_BYTES:
            raise ToolFailure(
                INVALID_ARGUMENT,
                f"file too large to open locally ({info['size']} bytes; max {MAX_OPEN_BYTES}) — use download instead",
            )
        remote = session._remote_path(remote_path)
        key = (session.session_id, remote)
        local = self._local_path(session.session_id, remote)
        with self._lock:
            entry = self._tracked.get(key)
            reused = entry is not None
            if entry is None:
                local.parent.mkdir(parents=True, exist_ok=True)
                session.sftp_fetch(remote, str(local))
                st = os.stat(local)
                entry = _Tracked(session, remote, local, (st.st_mtime_ns, st.st_size))
                self._tracked[key] = entry
                self._ensure_thread()
        self._launch(local)
        self._write_audit(
            "ssh.sftp_open_local",
            session=session.session_id,
            path=remote,
            local=str(local),
            bytes=info["size"],
            reused=reused,
        )
        return {"path": remote, "local": str(local), "bytes": info["size"], "reused": reused}

    def _local_path(self, session_id: str, remote: str) -> Path:
        digest = hashlib.sha1(remote.encode("utf-8", "replace")).hexdigest()[:10]
        folder = _safe_name(session_id, max_length=40)
        return self._root / folder / digest / _safe_name(posixpath.basename(remote) or "file")

    @staticmethod
    def _launch(path: Path) -> None:
        if sys.platform == "win32":
            os.startfile(str(path))  # noqa: S606 - intended: OS association
            return
        command = ["open", str(path)] if sys.platform == "darwin" else ["xdg-open", str(path)]
        try:
            subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except OSError as exc:
            raise ToolFailure(SSH_ERROR, f"cannot launch local opener: {exc}") from exc

    # --------------------------------------------------------------- watcher
    def _ensure_thread(self) -> None:
        # caller holds self._lock
        if self._thread is None or not self._thread.is_alive():
            self._thread = threading.Thread(target=self._poll_loop, name="tio-local-open", daemon=True)
            self._thread.start()

    def _poll_loop(self) -> None:
        while not self._stop.wait(POLL_SECONDS):
            now = time.monotonic()
            for entry in list(self._tracked.values()):
                try:
                    st = os.stat(entry.local)
                except OSError:
                    self._drop(entry, "local file removed")
                    continue
                fingerprint = (st.st_mtime_ns, st.st_size)
                if fingerprint != entry.fingerprint:
                    entry.fingerprint = fingerprint
                    entry.dirty_since = now
                    entry.failures = 0
                    continue
                if entry.dirty_since is not None and now - entry.dirty_since >= SETTLE_SECONDS:
                    self._upload(entry)

    def _upload(self, entry: _Tracked) -> None:
        try:
            written = entry.session.sftp_put(str(entry.local), entry.remote)
        except Exception as exc:
            entry.failures += 1
            message = getattr(exc, "message", str(exc))
            if entry.failures >= MAX_UPLOAD_FAILURES:
                self._drop(entry, f"upload failed: {message}")
            return
        entry.dirty_since = None
        entry.failures = 0
        self._write_audit(
            "ssh.sftp_local_save",
            session=entry.session_id,
            path=entry.remote,
            bytes=written,
            local=str(entry.local),
        )

    def _drop(self, entry: _Tracked, reason: str) -> None:
        with self._lock:
            self._tracked.pop((entry.session_id, entry.remote), None)
        self._write_audit(
            "ssh.sftp_local_save_dropped",
            session=entry.session_id,
            path=entry.remote,
            local=str(entry.local),
            reason=reason,
        )

    def _write_audit(self, event: str, **fields: Any) -> None:
        try:
            self._audit.write(event, **fields)
        except Exception:
            pass  # monitoring must never break the watch loop

    # ------------------------------------------------------------------ stop
    def stop(self) -> None:
        self._stop.set()
        thread = self._thread
        if thread is not None and thread.is_alive():
            thread.join(timeout=2.0)
