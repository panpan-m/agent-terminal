"""ttyd process supervision.

Each session can expose two ttyd instances:

* ``view``    -- read-only, no ``-W``;
* ``control`` -- writable (``-W``) with basic auth.

ttyd runs ``tio-web-bridge`` as its child command; the bridge connects back to
this server over WebSocket.  ttyd is optional: when the binary is missing the
admin UI shows the console instead and the rest of the server is unaffected.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

from ..auth import read_secret_file
from ..config import Config
from ..platform.paths import find_ttyd, is_windows
from ..transcript import AuditLog


@dataclass
class TtydProcess:
    session_id: str
    mode: str
    port: int
    process: subprocess.Popen
    started_at: float = field(default_factory=time.time)

    def alive(self) -> bool:
        return self.process.poll() is None


class TtydSupervisor:
    def __init__(self, config: Config, audit: AuditLog) -> None:
        self.config = config
        self.audit = audit
        self.binary = find_ttyd(config.ttyd.binary) if config.ttyd.enabled else None
        self._procs: dict[tuple[str, str], TtydProcess] = {}
        self._lock = threading.Lock()

    @property
    def available(self) -> bool:
        return bool(self.binary)

    def version(self) -> str | None:
        if not self.binary:
            return None
        try:
            out = subprocess.run(
                [self.binary, "--version"], capture_output=True, text=True, timeout=5
            )
            return (out.stdout or out.stderr).strip().splitlines()[0] if out.returncode == 0 else None
        except (OSError, subprocess.SubprocessError):
            return None

    # ------------------------------------------------------------- command line
    def bridge_command(self, session_id: str, mode: str, url: str, token_file: Path) -> list[str]:
        if getattr(sys, "frozen", False):
            exe = Path(sys.executable).parent / ("tio-web-bridge.exe" if is_windows() else "tio-web-bridge")
            base = [str(exe)]
        else:
            base = [sys.executable, "-m", "tio_web_bridge"]
        return base + [
            "--url",
            url,
            "--mode",
            mode,
            "--token-file",
            str(token_file),
            "--replay-bytes",
            str(self.config.ttyd.replay_bytes),
        ]

    def _args(self, session_id: str, mode: str, port: int) -> list[str]:
        cfg = self.config.ttyd
        base_url = f"ws://{self.config.server.bind}:{self.config.server.port}/ws/bridge/{session_id}"
        token_file = self.config.bridge_token_file
        bridge = self.bridge_command(session_id, mode, base_url, token_file)
        args = [
            str(self.binary),
            "-p",
            str(port),
            "-i",
            "127.0.0.1",
            "-O",
            "-m",
            str(cfg.control_max_clients if mode == "rw" else cfg.view_max_clients),
        ]
        if mode == "rw":
            args.append("-W")
            if cfg.auth_mode == "basic":
                password = read_secret_file(Path(cfg.control_password_file or self.config.ttyd_password_file)) or ""
                args += ["-c", f"{cfg.control_user}:{password}"]
            else:
                args += ["-H", "X-Forwarded-User"]
        args += bridge
        return args

    # ---------------------------------------------------------------- lifecycle
    def start(self, session_id: str, mode: str, port: int) -> TtydProcess:
        if not self.binary:
            raise RuntimeError("ttyd binary not found")
        with self._lock:
            key = (session_id, mode)
            existing = self._procs.get(key)
            if existing and existing.alive():
                return existing
            args = self._args(session_id, mode, port)
            log_path = self.config.log_dir / f"ttyd-{session_id}-{mode}.log"
            log_path.parent.mkdir(parents=True, exist_ok=True)
            fh = log_path.open("ab")
            creationflags = 0
            if is_windows():
                creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            proc = subprocess.Popen(
                args,
                stdin=subprocess.DEVNULL,
                stdout=fh,
                stderr=fh,
                cwd=str(self.config.data_dir),
                creationflags=creationflags,
            )
            rec = TtydProcess(session_id=session_id, mode=mode, port=port, process=proc)
            self._procs[key] = rec
        self.audit.write("ttyd.start", session=session_id, mode=mode, port=port, pid=proc.pid)
        return rec

    def stop(self, session_id: str, mode: str | None = None) -> None:
        with self._lock:
            keys = [k for k in self._procs if k[0] == session_id and (mode is None or k[1] == mode)]
            for key in keys:
                rec = self._procs.pop(key)
                if rec.alive():
                    rec.process.terminate()
                    try:
                        rec.process.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        rec.process.kill()
                self.audit.write("ttyd.stop", session=rec.session_id, mode=rec.mode, port=rec.port)

    def stop_all(self) -> None:
        for session_id, mode in list(self._procs):
            self.stop(session_id, mode)

    def status(self) -> dict:
        with self._lock:
            items = [
                {
                    "session_id": rec.session_id,
                    "mode": rec.mode,
                    "port": rec.port,
                    "pid": rec.process.pid,
                    "alive": rec.alive(),
                    "returncode": rec.process.returncode,
                    "url": f"http://127.0.0.1:{rec.port}/",
                }
                for rec in self._procs.values()
            ]
        return {
            "enabled": self.config.ttyd.enabled,
            "available": self.available,
            "binary": self.binary,
            "version": self.version(),
            "instances": items,
        }

    def allocate_ports(self, session_ids: list[str]) -> dict[str, tuple[int, int]]:
        """Assign (view, control) ports per session, 10 apart."""
        cfg = self.config.ttyd
        out = {}
        for index, sid in enumerate(session_ids):
            view = cfg.view_port_base + index * 10
            control = cfg.control_port_base + index * 10
            if control <= view:
                control = view + 1
            out[sid] = (view, control)
        return out

    # ------------------------------------------------------- per-session entries
    @staticmethod
    def _port_available(port: int) -> bool:
        import socket

        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind(("127.0.0.1", port))
            except OSError:
                return False
        return True

    def _allocate(self, start: int) -> int:
        with self._lock:
            used = {rec.port for rec in self._procs.values()}
        for port in range(start, start + 200):
            if port in used:
                continue
            if self._port_available(port):
                return port
        raise RuntimeError(f"no free port in {start}..{start + 200}")

    def start_for(self, session_id: str) -> dict:
        """Start (or reuse) the read-only and control entries for one session."""
        if not self.config.ttyd.enabled:
            raise RuntimeError("ttyd is disabled (ttyd.enabled = false)")
        if not self.binary:
            raise RuntimeError("ttyd binary not found")
        cfg = self.config.ttyd
        view = self._allocate(cfg.view_port_base)
        control = self._allocate(cfg.control_port_base)
        self.start(session_id, "ro", view)
        self.start(session_id, "rw", control)
        return self.info(session_id)

    def info(self, session_id: str) -> dict:
        """URLs of the live entries for a session (None when not started)."""
        with self._lock:
            out: dict[str, str | None] = {"view_url": None, "control_url": None}
            for rec in self._procs.values():
                if rec.session_id != session_id or not rec.alive():
                    continue
                if rec.mode == "ro":
                    out["view_url"] = f"http://127.0.0.1:{rec.port}/"
                elif rec.mode == "rw":
                    out["control_url"] = f"http://127.0.0.1:{rec.port}/"
            return out

    def ensure_for_all(self, session_ids: list[str]) -> None:
        if not self.config.ttyd.enabled or not self.binary:
            return
        for sid in session_ids:
            try:
                self.start_for(sid)
            except (OSError, RuntimeError):
                continue
