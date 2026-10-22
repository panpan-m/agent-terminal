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


def executable_suffix() -> str:
    return ".exe" if is_windows() else ""


def python_executable() -> str:
    return sys.executable
