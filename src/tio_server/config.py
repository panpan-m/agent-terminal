"""TOML configuration: model, validation, atomic persistence and ``init``.

The config file is the *user's* intent (ports, baud rates, permissions).  Runtime
state (connection state, control ownership, counters) never lives here, so a
restart cannot resurrect a half-open session.
"""

from __future__ import annotations

import fnmatch
import os
import re
import shlex
import tomllib
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

import tomli_w

from .auth import hash_secret, new_token, write_secret_file
from .errors import CONFIG_INVALID, ToolFailure
from .platform.paths import default_data_dir, default_log_dir, is_windows

CONFIG_VERSION = 1
CONFIG_FILENAME = "config.toml"

_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")
PARITIES = ("none", "even", "odd", "mark", "space")
STOPBITS = (1, 1.5, 2)
FLOWS = ("none", "hard", "soft")
OPEN_MODES = ("preserve", "assert", "deassert")
PERMISSIONS = ("read", "write", "command")

MIN_BUFFER = 1 * 1024 * 1024
MAX_BUFFER = 64 * 1024 * 1024
MAX_BAUD = 4_000_000


def _fail(message: str, **details: Any) -> ToolFailure:
    return ToolFailure(CONFIG_INVALID, message, details)


@dataclass(slots=True)
class ServerConfig:
    bind: str = "127.0.0.1"
    port: int = 8765
    public_url: str = ""
    log_level: str = "info"
    data_dir: str = ""
    log_dir: str = ""


@dataclass(slots=True)
class AuthConfig:
    admin_username: str = "admin"
    admin_password_hash: str = ""
    api_token_hash: str = ""
    session_secret: str = ""
    session_ttl_hours: int = 12


@dataclass(slots=True)
class SecurityConfig:
    allowed_ports: list[str] = field(
        default_factory=lambda: [
            "/dev/ttyUSB*",
            "/dev/ttyACM*",
            "/dev/serial/by-id/*",
            "/dev/ttyS*",
            "COM[0-9]*",
        ]
    )
    allowed_baudrates: list[int] = field(
        default_factory=lambda: [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600, 1500000]
    )
    max_sessions: int = 4
    max_read_bytes: int = 16384
    max_pattern_length: int = 512
    regex_timeout_ms: int = 500
    max_write_bytes_per_call: int = 65536
    rate_limit_per_second: int = 20
    #: Allow ``loop://`` / ``sim://`` dev ports (never for production installs).
    allow_dev_ports: bool = False
    #: Allow binding to a non-loopback address (requires TLS reverse proxy).
    allow_remote_bind: bool = False


@dataclass(slots=True)
class TranscriptConfig:
    enabled: bool = True
    directory: str = ""
    max_file_mb: int = 10
    max_files: int = 5
    redact_patterns: list[str] = field(default_factory=list)


@dataclass(slots=True)
class TtydConfig:
    enabled: bool = False
    binary: str = ""
    view_port_base: int = 7681
    control_port_base: int = 7682
    view_max_clients: int = 4
    control_max_clients: int = 2
    auth_mode: str = "basic"
    control_user: str = "operator"
    control_password_file: str = ""
    replay_bytes: int = 4096


@dataclass(slots=True)
class ResetStep:
    dtr: bool | None = None
    rts: bool | None = None
    delay_ms: int = 100


@dataclass(slots=True)
class SessionConfig:
    id: str
    name: str = ""
    port: str = ""
    baudrate: int = 115200
    bytesize: int = 8
    parity: str = "none"
    stopbits: float = 1
    flow: str = "none"
    open_mode: str = "preserve"
    auto_open: bool = False
    auto_reconnect: bool = True
    buffer_bytes: int = 8 * 1024 * 1024
    agent_permissions: list[str] = field(default_factory=lambda: ["read", "write", "command"])
    replay_bytes: int = 4096
    transcript: bool = True
    reset_sequence: list[ResetStep] = field(default_factory=list)

    def key(self) -> str:
        return self.id


@dataclass(slots=True)
class Config:
    server: ServerConfig = field(default_factory=ServerConfig)
    auth: AuthConfig = field(default_factory=AuthConfig)
    security: SecurityConfig = field(default_factory=SecurityConfig)
    transcript: TranscriptConfig = field(default_factory=TranscriptConfig)
    ttyd: TtydConfig = field(default_factory=TtydConfig)
    sessions: list[SessionConfig] = field(default_factory=list)
    config_version: int = CONFIG_VERSION
    path: Path | None = field(default=None, compare=False, repr=False)

    # ------------------------------------------------------------------ paths
    @property
    def data_dir(self) -> Path:
        raw = self.server.data_dir or str(default_data_dir())
        return Path(raw).expanduser()

    @property
    def log_dir(self) -> Path:
        raw = self.server.log_dir or str(default_log_dir())
        return Path(raw).expanduser()

    @property
    def transcript_dir(self) -> Path:
        raw = self.transcript.directory or str(self.data_dir / "transcripts")
        return Path(raw).expanduser()

    @property
    def api_token_file(self) -> Path:
        return self.data_dir / "api-token"

    @property
    def bridge_token_file(self) -> Path:
        return self.data_dir / "bridge-token"

    @property
    def ttyd_password_file(self) -> Path:
        raw = self.ttyd.control_password_file
        return Path(raw).expanduser() if raw else self.data_dir / "ttyd-control.pass"

    @property
    def public_url(self) -> str:
        return self.server.public_url or f"http://{self.server.bind}:{self.server.port}"

    # ------------------------------------------------------------------- load
    @classmethod
    def load(cls, path: str | Path) -> "Config":
        p = Path(path)
        try:
            with p.open("rb") as fh:
                data = tomllib.load(fh)
        except FileNotFoundError as exc:
            raise _fail(f"config file not found: {p}", path=str(p)) from exc
        except tomllib.TOMLDecodeError as exc:
            raise _fail(f"invalid TOML in {p}: {exc}", path=str(p)) from exc
        cfg = cls.from_dict(data)
        cfg.path = p
        cfg.validate()
        return cfg

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Config":
        cfg = cls()
        cfg.config_version = int(data.get("config_version", CONFIG_VERSION))
        if "server" in data:
            cfg.server = _build(ServerConfig, data["server"])
        if "auth" in data:
            cfg.auth = _build(AuthConfig, data["auth"])
        if "security" in data:
            cfg.security = _build(SecurityConfig, data["security"])
        if "transcript" in data:
            cfg.transcript = _build(TranscriptConfig, data["transcript"])
        if "ttyd" in data:
            cfg.ttyd = _build(TtydConfig, data["ttyd"])
        sessions = []
        for raw in data.get("sessions", []):
            raw = dict(raw)
            steps = [ResetStep(**_known(ResetStep, s)) for s in raw.pop("reset_sequence", [])]
            sess = _build(SessionConfig, raw)
            sess.reset_sequence = steps
            sessions.append(sess)
        cfg.sessions = sessions
        return cfg

    def to_dict(self) -> dict[str, Any]:
        return {
            "config_version": self.config_version,
            "server": asdict(self.server),
            "auth": asdict(self.auth),
            "security": asdict(self.security),
            "transcript": asdict(self.transcript),
            "ttyd": asdict(self.ttyd),
            "sessions": [asdict(s) for s in self.sessions],
        }

    # ------------------------------------------------------------------- save
    def save(self, path: str | Path | None = None) -> Path:
        target = Path(path) if path else (self.path or (self.data_dir / CONFIG_FILENAME))
        target.parent.mkdir(parents=True, exist_ok=True)
        payload = tomli_w.dumps(self.to_dict())
        tmp = target.with_suffix(target.suffix + ".tmp")
        with tmp.open("w", encoding="utf-8", newline="\n") as fh:
            fh.write(payload)
            fh.flush()
            os.fsync(fh.fileno())
        try:
            os.chmod(tmp, 0o600)
        except OSError:
            pass
        os.replace(tmp, target)
        self.path = target
        return target

    # --------------------------------------------------------------- validate
    def validate(self) -> None:
        s, a, sec, tr, ty = self.server, self.auth, self.security, self.transcript, self.ttyd
        if not s.bind:
            raise _fail("server.bind must not be empty")
        if not sec.allow_remote_bind and s.bind not in ("127.0.0.1", "localhost", "::1"):
            raise _fail(
                "server.bind must stay on loopback; set security.allow_remote_bind=true only behind a TLS reverse proxy",
                bind=s.bind,
            )
        if not (1 <= int(s.port) <= 65535):
            raise _fail("server.port out of range", port=s.port)
        if s.log_level.lower() not in ("debug", "info", "warning", "error"):
            raise _fail("server.log_level must be debug|info|warning|error")
        if a.session_ttl_hours <= 0:
            raise _fail("auth.session_ttl_hours must be positive")
        if len(a.session_secret) < 32:
            raise _fail("auth.session_secret must be at least 32 characters (run `tio-server init`)")
        if not a.admin_password_hash:
            raise _fail("auth.admin_password_hash is empty (run `tio-server init`)")
        if not a.api_token_hash:
            raise _fail("auth.api_token_hash is empty (run `tio-server init`)")
        if sec.max_sessions < 1:
            raise _fail("security.max_sessions must be >= 1")
        if not (1024 <= sec.max_read_bytes <= 1024 * 1024):
            raise _fail("security.max_read_bytes must be 1 KiB..1 MiB")
        if not (1 <= sec.regex_timeout_ms <= 5000):
            raise _fail("security.regex_timeout_ms must be 1..5000")
        if sec.rate_limit_per_second < 1:
            raise _fail("security.rate_limit_per_second must be >= 1")
        for pattern in sec.allowed_ports:
            if not pattern:
                raise _fail("security.allowed_ports contains an empty pattern")
        if len(self.sessions) > sec.max_sessions:
            raise _fail(
                "more sessions configured than security.max_sessions",
                sessions=len(self.sessions),
                max_sessions=sec.max_sessions,
            )
        seen: set[str] = set()
        for sess in self.sessions:
            self.validate_session(sess)
            if sess.id in seen:
                raise _fail(f"duplicate session id: {sess.id}", session=sess.id)
            seen.add(sess.id)
        if tr.max_file_mb < 1 or tr.max_files < 1:
            raise _fail("transcript.max_file_mb and transcript.max_files must be >= 1")
        if ty.enabled:
            if ty.auth_mode not in ("basic", "proxy-header"):
                raise _fail("ttyd.auth_mode must be basic|proxy-header")
            for label, value in (("view_port_base", ty.view_port_base), ("control_port_base", ty.control_port_base)):
                if not (1 <= int(value) <= 65535):
                    raise _fail(f"ttyd.{label} out of range")
            if ty.control_max_clients < 1 or ty.view_max_clients < 1:
                raise _fail("ttyd max clients must be >= 1")
            if not ty.control_password_file and ty.auth_mode == "basic":
                # The file is generated by init; a missing file is a startup warning.
                pass

    def validate_session(self, sess: SessionConfig) -> None:
        if not _ID_RE.match(sess.id or ""):
            raise _fail(
                "session id must match ^[a-z0-9][a-z0-9_-]{0,31}$",
                session=sess.id,
            )
        if not sess.port:
            raise _fail(f"session {sess.id}: port is required", session=sess.id)
        if not _port_allowed(sess.port, self.security.allowed_ports, self.security.allow_dev_ports):
            raise _fail(
                f"session {sess.id}: port {sess.port!r} is not allowed by security.allowed_ports",
                session=sess.id,
                port=sess.port,
            )
        if int(sess.baudrate) <= 0 or int(sess.baudrate) > MAX_BAUD:
            raise _fail(f"session {sess.id}: baudrate out of range", session=sess.id)
        if self.security.allowed_baudrates and int(sess.baudrate) not in self.security.allowed_baudrates:
            raise _fail(
                f"session {sess.id}: baudrate {sess.baudrate} is not in security.allowed_baudrates",
                session=sess.id,
            )
        if sess.bytesize not in (5, 6, 7, 8):
            raise _fail(f"session {sess.id}: bytesize must be 5..8", session=sess.id)
        if sess.parity not in PARITIES:
            raise _fail(f"session {sess.id}: parity must be one of {PARITIES}", session=sess.id)
        if float(sess.stopbits) not in STOPBITS:
            raise _fail(f"session {sess.id}: stopbits must be 1, 1.5 or 2", session=sess.id)
        if sess.flow not in FLOWS:
            raise _fail(f"session {sess.id}: flow must be one of {FLOWS}", session=sess.id)
        if sess.open_mode not in OPEN_MODES:
            raise _fail(f"session {sess.id}: open_mode must be one of {OPEN_MODES}", session=sess.id)
        if not (MIN_BUFFER <= int(sess.buffer_bytes) <= MAX_BUFFER):
            raise _fail(
                f"session {sess.id}: buffer_bytes must be 1..64 MiB",
                session=sess.id,
            )
        bad = [p for p in sess.agent_permissions if p not in PERMISSIONS]
        if bad:
            raise _fail(f"session {sess.id}: unknown permissions {bad}", session=sess.id)
        if len(sess.reset_sequence) > 8:
            raise _fail(f"session {sess.id}: reset_sequence has too many steps", session=sess.id)
        for step in sess.reset_sequence:
            if step.delay_ms < 0 or step.delay_ms > 5000:
                raise _fail(f"session {sess.id}: reset step delay out of range", session=sess.id)
        if sess.name and len(sess.name) > 64:
            raise _fail(f"session {sess.id}: name too long", session=sess.id)

    # ----------------------------------------------------------------- helpers
    def get_session(self, session_id: str) -> SessionConfig | None:
        return next((s for s in self.sessions if s.id == session_id), None)

    def replace_session(self, sess: SessionConfig) -> None:
        for i, existing in enumerate(self.sessions):
            if existing.id == sess.id:
                self.sessions[i] = sess
                return
        self.sessions.append(sess)

    def remove_session(self, session_id: str) -> bool:
        before = len(self.sessions)
        self.sessions = [s for s in self.sessions if s.id != session_id]
        return len(self.sessions) != before


# --------------------------------------------------------------------- helpers
def _known(cls: type, data: dict[str, Any]) -> dict[str, Any]:
    names = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
    return {k: v for k, v in data.items() if k in names}


def _build(cls: type, data: dict[str, Any]):
    return cls(**_known(cls, dict(data)))


def _port_allowed(port: str, patterns: list[str], allow_dev: bool) -> bool:
    if port.startswith(("loop://", "sim://", "fake://")):
        return allow_dev
    normalised = port.replace("\\", "/")
    if is_windows() and re.fullmatch(r"COM\d+", port, re.IGNORECASE):
        normalised = port.upper()
    return any(
        fnmatch.fnmatchcase(normalised, pat) or fnmatch.fnmatchcase(port, pat)
        for pat in patterns
    )


def default_config() -> Config:
    cfg = Config()
    cfg.server.data_dir = str(default_data_dir())
    cfg.server.log_dir = str(default_log_dir())
    cfg.transcript.directory = str(default_data_dir() / "transcripts")
    cfg.ttyd.control_password_file = str(default_data_dir() / "ttyd-control.pass")
    return cfg


def init_config(data_dir: str | Path, *, force: bool = False) -> tuple[Config, dict[str, str]]:
    """Create config + secrets. Returns the config and the one-time plaintext secrets."""
    root = Path(data_dir).expanduser()
    root.mkdir(parents=True, exist_ok=True)
    config_path = root / CONFIG_FILENAME
    if config_path.exists() and not force:
        raise _fail(f"config already exists: {config_path}", path=str(config_path))

    admin_password = new_token(12)
    api_token = new_token(32)
    bridge_token = new_token(24)
    ttyd_password = new_token(12)

    cfg = default_config()
    cfg.server.data_dir = str(root)
    cfg.server.log_dir = str(root / "logs")
    cfg.transcript.directory = str(root / "transcripts")
    cfg.ttyd.control_password_file = str(root / "ttyd-control.pass")
    cfg.auth.admin_password_hash = hash_secret(admin_password)
    cfg.auth.api_token_hash = hash_secret(api_token)
    cfg.auth.session_secret = new_token(32)

    write_secret_file(root / "api-token", api_token)
    write_secret_file(root / "bridge-token", bridge_token)
    write_secret_file(root / "ttyd-control.pass", ttyd_password)
    cfg.save(config_path)
    (root / "transcripts").mkdir(parents=True, exist_ok=True)
    (root / "logs").mkdir(parents=True, exist_ok=True)
    return cfg, {
        "admin_password": admin_password,
        "api_token": api_token,
        "bridge_token": bridge_token,
        "ttyd_control_password": ttyd_password,
        "config": str(config_path),
    }


def shell_split(value: str) -> list[str]:
    """Split a command line (used by the ttyd supervisor)."""
    return shlex.split(value, posix=not is_windows())
