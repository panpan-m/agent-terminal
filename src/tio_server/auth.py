"""Token and origin primitives.

The web UI is a local, single-user tool: the server binds loopback, there is no
login or admin account, and ``/api`` requests are instead guarded against
browser cross-site attacks by a Host/Origin allow-list in the web app.

* Agents use ``Authorization: Bearer <api_token>`` on ``/mcp``; only the Argon2
  hash of the token is stored in the config file, the raw token lives in a 0600
  file that ``tio-mcp`` reads.
"""

from __future__ import annotations

import hmac
import os
import secrets
from pathlib import Path

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError

_hasher = PasswordHasher(time_cost=3, memory_cost=64 * 1024, parallelism=4, hash_len=32, salt_len=16)


def hash_secret(secret: str) -> str:
    return _hasher.hash(secret)


def verify_secret(hashed: str, secret: str) -> bool:
    if not hashed:
        return False
    try:
        return _hasher.verify(hashed, secret)
    except (VerifyMismatchError, InvalidHashError, ValueError):
        return False


def new_token(nbytes: int = 32) -> str:
    return secrets.token_urlsafe(nbytes)


def write_secret_file(path: Path, value: str) -> None:
    """Write a secret atomically with owner-only permissions."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, value.encode("utf-8"))
        os.write(fd, b"\n")
    finally:
        os.close(fd)
    os.replace(tmp, path)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def read_secret_file(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8").strip()
    except OSError:
        return None


class AuthManager:
    """Bearer-token checks for MCP and the origin allow-list."""

    def __init__(self, *, api_token_hash: str = "") -> None:
        self.api_token_hash = api_token_hash
        #: Origin allow-list, filled from the server config after loading.
        self.allowed_origins: set[str] = set()

    # ----------------------------------------------------------------- tokens
    def check_api_token(self, token: str | None) -> bool:
        if not token:
            return False
        return verify_secret(self.api_token_hash, token)

    # ----------------------------------------------------------------- origin
    def origin_allowed(self, origin: str | None) -> bool:
        """Origin check for browser-facing calls and WebSockets."""
        if not origin:
            # Non-browser clients (curl, MCP SDK) send no Origin.
            return True
        return origin.rstrip("/") in self.allowed_origins
