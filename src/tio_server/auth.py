"""Authentication primitives: password hashing, tokens, admin sessions, CSRF.

* Admin users log in with a password (Argon2id) and receive an HttpOnly signed
  cookie.  The server keeps a session record so it can revoke and can validate a
  CSRF token that is *not* readable from a cross-site request.
* Agents use ``Authorization: Bearer <api_token>``; only the Argon2 hash of the
  token is stored in the config file, the raw token lives in a 0600 file that
  ``tio-mcp`` reads.
* The ttyd bridge uses a separate bridge token so a leaked browser cookie can
  never open a raw serial stream.
"""

from __future__ import annotations

import hmac
import os
import secrets
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

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


def needs_rehash(hashed: str) -> bool:
    try:
        return _hasher.check_needs_rehash(hashed)
    except InvalidHashError:
        return True


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


@dataclass(slots=True)
class AdminSession:
    sid: str
    username: str
    csrf: str
    created: float
    expires: float
    remote: str = ""

    @property
    def expired(self) -> bool:
        return time.time() > self.expires


@dataclass
class LoginLimiter:
    """Very small in-memory brute-force guard (per client address)."""

    limit: int = 10
    window_seconds: float = 300.0
    _attempts: dict[str, list[float]] = field(default_factory=dict)
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def allow(self, key: str) -> bool:
        now = time.time()
        with self._lock:
            stamps = [t for t in self._attempts.get(key, []) if now - t < self.window_seconds]
            self._attempts[key] = stamps
            return len(stamps) < self.limit

    def record_failure(self, key: str) -> None:
        with self._lock:
            self._attempts.setdefault(key, []).append(time.time())

    def reset(self, key: str) -> None:
        with self._lock:
            self._attempts.pop(key, None)


class AuthManager:
    """Owns admin sessions, the bearer token check and the signing secret."""

    COOKIE_NAME = "tio_session"

    def __init__(
        self,
        *,
        session_secret: str,
        admin_username: str,
        admin_password_hash: str,
        api_token_hash: str,
        session_ttl_hours: int = 12,
        secure_cookie: bool = False,
        bridge_token: str | None = None,
    ) -> None:
        self._serializer = URLSafeTimedSerializer(session_secret, salt="tio-admin-session")
        self.admin_username = admin_username
        self.admin_password_hash = admin_password_hash
        self.api_token_hash = api_token_hash
        self.session_ttl = session_ttl_hours * 3600
        self.secure_cookie = secure_cookie
        self.bridge_token = bridge_token
        self._sessions: dict[str, AdminSession] = {}
        self._lock = threading.Lock()
        self.limiter = LoginLimiter()
        #: Origin allow-list, filled from the server config after loading.
        self.allowed_origins: set[str] = set()

    # ------------------------------------------------------------- passwords
    def check_password(self, username: str, password: str) -> bool:
        if not hmac.compare_digest(username, self.admin_username):
            # Still run a hash to keep timing uniform.
            verify_secret(self.admin_password_hash, password)
            return False
        return verify_secret(self.admin_password_hash, password)

    # -------------------------------------------------------------- sessions
    def create_session(self, username: str, remote: str = "") -> AdminSession:
        sid = new_token(24)
        now = time.time()
        rec = AdminSession(
            sid=sid,
            username=username,
            csrf=new_token(24),
            created=now,
            expires=now + self.session_ttl,
            remote=remote,
        )
        with self._lock:
            self._sessions[sid] = rec
            self._purge_locked()
        return rec

    def get_session(self, sid: str | None) -> AdminSession | None:
        if not sid:
            return None
        with self._lock:
            rec = self._sessions.get(sid)
            if rec is None or rec.expired:
                self._sessions.pop(sid, None)
                return None
            return rec

    def destroy_session(self, sid: str | None) -> None:
        if not sid:
            return
        with self._lock:
            self._sessions.pop(sid, None)

    def _purge_locked(self) -> None:
        for sid in [s for s, rec in self._sessions.items() if rec.expired]:
            self._sessions.pop(sid, None)

    # ---------------------------------------------------------------- cookies
    def sign_cookie(self, sid: str) -> str:
        return self._serializer.dumps({"sid": sid})

    def read_cookie(self, value: str | None) -> str | None:
        if not value:
            return None
        try:
            data = self._serializer.loads(value, max_age=int(self.session_ttl))
        except (BadSignature, SignatureExpired):
            return None
        sid = data.get("sid") if isinstance(data, dict) else None
        return sid if isinstance(sid, str) else None

    # ----------------------------------------------------------------- tokens
    def check_api_token(self, token: str | None) -> bool:
        if not token:
            return False
        return verify_secret(self.api_token_hash, token)

    def check_bridge_token(self, token: str | None) -> bool:
        if not self.bridge_token or not token:
            return False
        return hmac.compare_digest(token, self.bridge_token)

    # ----------------------------------------------------------------- origin
    def origin_allowed(self, origin: str | None) -> bool:
        """Origin check for state-changing browser calls and WebSockets."""
        if not origin:
            # Non-browser clients (curl, MCP SDK) send no Origin.
            return True
        return origin.rstrip("/") in self.allowed_origins
