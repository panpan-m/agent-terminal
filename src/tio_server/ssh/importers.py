"""Read-only import candidates from the server's ~/.ssh/config."""

from __future__ import annotations

import getpass
import os
import re
from pathlib import Path
from typing import Any

from .profiles import _slug


def parse_ssh_config(path: Path | str) -> list[dict[str, Any]]:
    path = Path(path)
    if not path.is_file():
        return []
    entries: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    default_user = getpass.getuser()
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = re.split(r"\s+", line, maxsplit=1)
        if len(parts) != 2:
            continue
        key, value = parts[0].lower(), parts[1].strip()
        if key == "host":
            if current is not None:
                entries.append(current)
            aliases = [alias for alias in value.split() if "*" not in alias and "?" not in alias]
            current = {
                "aliases": aliases,
                "hostname": "",
                "user": default_user,
                "port": 22,
                "identity_file": "",
                "proxy_jump": "",
            }
            continue
        if current is None:
            continue
        if key == "hostname":
            current["hostname"] = value
        elif key == "user":
            current["user"] = value
        elif key == "port":
            try:
                current["port"] = int(value)
            except ValueError:
                pass
        elif key == "identityfile":
            current["identity_file"] = os.path.expanduser(value)
        elif key == "proxyjump":
            current["proxy_jump"] = value
    if current is not None:
        entries.append(current)

    out = []
    for entry in entries:
        for alias in entry["aliases"]:
            out.append(
                {
                    "id": _slug(alias),
                    "name": alias,
                    "host": entry["hostname"] or alias,
                    "port": entry["port"],
                    "username": entry["user"],
                    "auth": "key" if entry["identity_file"] else "password",
                    "key_file": entry["identity_file"],
                    "proxy_jump": entry["proxy_jump"],
                }
            )
    return out
