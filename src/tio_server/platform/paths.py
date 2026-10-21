"""Platform-specific locations for config, state, logs and secrets."""

from __future__ import annotations

import os
import sys
from pathlib import Path


def is_windows() -> bool:
    return os.name == "nt"


def default_data_dir() -> Path:
    """Writable directory for config, transcripts, logs and tokens."""
    override = os.environ.get("TIO_SERVER_HOME")
    if override:
        return Path(override).expanduser()
    if is_windows():
        base = os.environ.get("ProgramData", r"C:\ProgramData")
        return Path(base) / "tio-server"
    return Path("/var/lib/tio-server")


def default_log_dir() -> Path:
    override = os.environ.get("TIO_SERVER_LOG_DIR")
    if override:
        return Path(override).expanduser()
    if is_windows():
        return default_data_dir() / "logs"
    return Path("/var/log/tio-server")


def default_ttyd_candidates() -> list[str]:
    if is_windows():
        return [
            str(Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "tio-server" / "bin" / "ttyd.exe"),
            str(Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")) / "tio-server" / "bin" / "ttyd.exe"),
            "ttyd.exe",
        ]
    return ["/usr/bin/ttyd", "/usr/local/bin/ttyd", "ttyd"]


def find_ttyd(configured: str | None) -> str | None:
    """Resolve the ttyd binary: explicit path first, then PATH, then defaults."""
    import shutil

    candidates = [configured] if configured else []
    candidates.extend(default_ttyd_candidates())
    for cand in candidates:
        if not cand:
            continue
        p = Path(cand)
        if p.is_file():
            return str(p)
        found = shutil.which(cand)
        if found:
            return found
    return None


def executable_suffix() -> str:
    return ".exe" if is_windows() else ""


def python_executable() -> str:
    return sys.executable
