"""FastAPI application: admin API, browser console, ttyd bridge, MCP mount."""

from __future__ import annotations

import asyncio
import base64
import hmac
import json
import os
import platform as platform_mod
import sys
import time
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlparse

from fastapi import Depends, FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from mcp.server.transport_security import TransportSecuritySettings
from pydantic import BaseModel, Field

from ..auth import AuthManager, AdminSession, read_secret_file
from ..config import Config, ResetStep, SessionConfig
from ..errors import CONFLICT, UNAUTHORIZED, ToolFailure
from ..mcp import build_mcp_server
from ..observability import setup_logging
from ..sessions import Session, SessionManager
from ..ssh import SshManager, SshProfileStore
from ..transcript import now_iso
from .ttyd_supervisor import TtydSupervisor

__version__ = "0.1.0"


def _mcp_shim_path() -> str:
    """Best-effort path of tio-mcp for the copy-paste install prompt."""
    override = os.environ.get("TIO_MCP_SHIM")
    if override:
        return override
    exe = "tio-mcp.exe" if sys.platform == "win32" else "tio-mcp"
    if getattr(sys, "frozen", False):
        candidate = Path(sys.executable).parent / exe
        if candidate.exists():
            return str(candidate)
    repo = Path(__file__).resolve().parents[3] / "dist" / exe
    if repo.exists():
        return str(repo)
    return exe


def _static_dir() -> Path:
    """Locate the built SPA both from source and inside a PyInstaller bundle."""
    candidates = [Path(__file__).resolve().parent / "static"]
    if getattr(sys, "frozen", False):  # pragma: no cover - frozen path
        base = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
        candidates = [
            base / "tio_server" / "web" / "static",
            Path(sys.executable).parent / "tio_server" / "web" / "static",
            *candidates,
        ]
    for candidate in candidates:
        if candidate.is_dir():
            return candidate
    return candidates[0]


STATIC_DIR = _static_dir()
COOKIE = AuthManager.COOKIE_NAME


# --------------------------------------------------------------------- helpers
def _allowed_origins(config: Config) -> set[str]:
    bind, port = config.server.bind, config.server.port
    origins = {
        f"http://{bind}:{port}",
        f"http://localhost:{port}",
        f"http://127.0.0.1:{port}",
        config.public_url.rstrip("/"),
    }
    if config.server.public_url:
        origins.add(config.server.public_url.rstrip("/"))
    return {o for o in origins if o}


class _RootPath:
    """Mount("/mcp") gives an empty child path for an exact ``/mcp`` request."""

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope, receive, send):  # type: ignore[no-untyped-def]
        if scope["type"] == "http" and scope.get("path") == "":
            scope = dict(scope)
            scope["path"] = "/"
        await self.app(scope, receive, send)


class _McpPathRewrite:
    """Serve ``/mcp`` without a 307 redirect (some MCP clients do not follow POSTs)."""

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope, receive, send):  # type: ignore[no-untyped-def]
        if scope["type"] == "http" and scope.get("path") == "/mcp":
            scope = dict(scope)
            scope["path"] = "/mcp/"
            scope["raw_path"] = b"/mcp/"
        await self.app(scope, receive, send)


class _BearerAuth:
    def __init__(self, app: Any, auth: AuthManager) -> None:
        self.app = app
        self.auth = auth

    async def __call__(self, scope, receive, send):  # type: ignore[no-untyped-def]
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = {k.decode().lower(): v.decode() for k, v in scope.get("headers", [])}
        raw = headers.get("authorization", "")
        token = raw[7:].strip() if raw.lower().startswith("bearer ") else None
        if not self.auth.check_api_token(token):
            body = json.dumps(
                {"error": {"code": UNAUTHORIZED, "message": "missing or invalid bearer token"}}
            ).encode()
            await send(
                {
                    "type": "http.response.start",
                    "status": 401,
                    "headers": [
                        (b"content-type", b"application/json"),
                        (b"www-authenticate", b'Bearer realm="tio-server"'),
                        (b"content-length", str(len(body)).encode()),
                    ],
                }
            )
            await send({"type": "http.response.body", "body": body})
            return
        await self.app(scope, receive, send)


# ------------------------------------------------------------------- API models
class LoginBody(BaseModel):
    username: str
    password: str


class ResetStepBody(BaseModel):
    dtr: bool | None = None
    rts: bool | None = None
    delay_ms: int = 100


class SessionBody(BaseModel):
    id: str | None = None
    name: str = ""
    port: str
    baudrate: int = 115200
    bytesize: int = 8
    parity: str = "none"
    stopbits: float = 1
    flow: str = "none"
    open_mode: str = "preserve"
    auto_open: bool = False
    auto_reconnect: bool = True
    buffer_bytes: int = 8 * 1024 * 1024
    agent_permissions: list[str] = Field(default_factory=lambda: ["read", "write", "command"])
    transcript: bool = True
    reset_sequence: list[ResetStepBody] = Field(default_factory=list)

    def to_config(self, session_id: str) -> SessionConfig:
        return SessionConfig(
            id=session_id,
            name=self.name or session_id,
            port=self.port,
            baudrate=self.baudrate,
            bytesize=self.bytesize,
            parity=self.parity,
            stopbits=self.stopbits,
            flow=self.flow,
            open_mode=self.open_mode,
            auto_open=self.auto_open,
            auto_reconnect=self.auto_reconnect,
            buffer_bytes=self.buffer_bytes,
            agent_permissions=list(self.agent_permissions),
            transcript=self.transcript,
            reset_sequence=[ResetStep(**s.model_dump()) for s in self.reset_sequence],
        )


class ControlBody(BaseModel):
    owner: str


class PermissionsBody(BaseModel):
    permissions: list[str]


class LinesBody(BaseModel):
    dtr: bool | None = None
    rts: bool | None = None


class WriteBody(BaseModel):
    text: str | None = None
    hex: str | None = None
    newline: str = "none"


class CommandBody(BaseModel):
    command: str
    expect: str | None = None
    expect_mode: str = "literal"
    timeout_ms: int = 5000
    settle_ms: int = 100
    ignore_case: bool = False


class BreakBody(BaseModel):
    duration_ms: int = Field(default=250, ge=1, le=5000)


class SshHostBody(BaseModel):
    id: str | None = None
    name: str = ""
    host: str
    port: int = Field(default=22, ge=1, le=65535)
    username: str = ""
    auth: Literal["password", "key"] = "password"
    key_file: str = ""
    known_hosts: str = ""
    term: str = "xterm-256color"
    connect_timeout_s: int = Field(default=10, ge=1, le=120)


class SshConnectBody(BaseModel):
    password: str | None = None
    passphrase: str | None = None
    cols: int = Field(default=120, ge=20, le=400)
    rows: int = Field(default=30, ge=5, le=200)


# ------------------------------------------------------------------- app factory
def create_app(config: Config) -> FastAPI:
    logger = setup_logging(config.log_dir, config.server.log_level)
    manager = SessionManager(config, on_config_changed=_save_config)
    ssh_profiles = SshProfileStore(config.data_dir)
    ssh_manager = SshManager(
        config,
        ssh_profiles,
        transcripts=manager.transcripts,
        audit=manager.audit,
    )
    auth = AuthManager(
        session_secret=config.auth.session_secret,
        admin_username=config.auth.admin_username,
        admin_password_hash=config.auth.admin_password_hash,
        api_token_hash=config.auth.api_token_hash,
        session_ttl_hours=config.auth.session_ttl_hours,
        secure_cookie=config.public_url.startswith("https://"),
        bridge_token=read_secret_file(config.bridge_token_file),
    )
    auth.allowed_origins = _allowed_origins(config)
    ttyd = TtydSupervisor(config, manager.audit)
    started_at = time.time()

    def session_payload(sess) -> dict:
        data = sess.status()
        data["terminal"] = ttyd.info(sess.id)
        return data

    def ensure_ttyd(session_id: str) -> None:
        if not config.ttyd.enabled or not ttyd.available:
            return
        info = ttyd.info(session_id)
        if info.get("view_url") and info.get("control_url"):
            return
        try:
            ttyd.start_for(session_id)
        except Exception as exc:  # ttyd is optional; never fail the API for it
            logger.warning("ttyd start failed for %s: %s", session_id, exc)

    async def ttyd_reconcile_loop() -> None:
        """Recreate entries that died (crash, port takeover, manual kill)."""
        while True:
            await asyncio.sleep(20)
            if not config.ttyd.enabled or not ttyd.available:
                continue
            for session_id in list(manager.sessions):
                try:
                    await asyncio.to_thread(ensure_ttyd, session_id)
                except Exception:  # pragma: no cover - best effort
                    pass

    mcp_server = build_mcp_server(manager, config, ssh_manager)
    allowed_hosts = [config.server.bind, f"{config.server.bind}:{config.server.port}"]
    for host in ("localhost", "127.0.0.1", "[::1]"):
        allowed_hosts += [host, f"{host}:{config.server.port}"]
    if config.server.public_url:
        parsed = urlparse(config.server.public_url)
        if parsed.hostname:
            allowed_hosts.append(parsed.hostname)
            if parsed.port:
                allowed_hosts.append(f"{parsed.hostname}:{parsed.port}")
    transport = TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=sorted(set(allowed_hosts)),
        allowed_origins=sorted(auth.allowed_origins),
    )
    mcp_asgi = mcp_server.streamable_http_app(
        streamable_http_path="/",
        transport_security=transport,
        json_response=False,
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        manager.start()
        ttyd.ensure_for_all(list(manager.sessions))
        reconcile = asyncio.create_task(ttyd_reconcile_loop(), name="ttyd-reconcile")
        try:
            async with mcp_server.session_manager.run():
                yield
        finally:
            reconcile.cancel()
            ttyd.stop_all()
            ssh_manager.stop()
            manager.stop()

    app = FastAPI(
        title="tio-server",
        version=__version__,
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.state.config = config
    app.state.manager = manager
    app.state.ssh = ssh_manager
    app.state.ssh_profiles = ssh_profiles
    app.state.auth = auth
    app.state.ttyd = ttyd
    app.state.logger = logger
    app.add_middleware(_McpPathRewrite)

    # ------------------------------------------------------------------ plumbing
    @app.exception_handler(ToolFailure)
    async def tool_failure_handler(request: Request, exc: ToolFailure):
        return JSONResponse(status_code=exc.http_status, content=exc.to_dict())

    @app.exception_handler(HTTPException)
    async def http_error_handler(request: Request, exc: HTTPException):
        code = "UNAUTHORIZED" if exc.status_code == 401 else "FORBIDDEN" if exc.status_code == 403 else "NOT_FOUND" if exc.status_code == 404 else "INVALID_ARGUMENT"
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": {"code": code, "message": str(exc.detail), "details": {}, "retryable": False}},
        )

    @app.middleware("http")
    async def request_context(request: Request, call_next):
        request_id = base64.urlsafe_b64encode(os.urandom(6)).decode()
        started = time.monotonic()
        response = await call_next(request)
        elapsed = int((time.monotonic() - started) * 1000)
        response.headers["X-Request-Id"] = request_id
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        if request.url.path.startswith("/api/"):
            logger.info(
                "http",
                extra={
                    "request_id": request_id,
                    "path": request.url.path,
                    "status": response.status_code,
                    "method": request.method,
                    "ms": elapsed,
                },
            )
        return response

    # ---------------------------------------------------------------- auth deps
    def admin_session(request: Request) -> AdminSession:
        sid = auth.read_cookie(request.cookies.get(COOKIE))
        rec = auth.get_session(sid)
        if rec is None:
            raise HTTPException(status_code=401, detail="not signed in")
        return rec

    def csrf_guard(request: Request, rec: AdminSession = Depends(admin_session)) -> AdminSession:
        origin = request.headers.get("origin")
        if origin and not auth.origin_allowed(origin):
            raise HTTPException(status_code=403, detail="origin not allowed")
        token = request.headers.get("x-csrf-token", "")
        if not token or not hmac.compare_digest(token, rec.csrf):
            raise HTTPException(status_code=403, detail="invalid CSRF token")
        return rec

    def client_ip(request: Request) -> str:
        return request.client.host if request.client else "unknown"

    # ------------------------------------------------------------------- health
    @app.get("/healthz")
    async def healthz():
        return {"status": "ok"}

    @app.get("/readyz")
    async def readyz():
        return {
            "status": "ready" if manager.any_open() else "degraded",
            "sessions_open": sum(1 for s in manager.sessions.values() if s.is_open),
            "sessions_total": len(manager.sessions),
        }

    @app.get("/api/version")
    async def api_version():
        return {
            "version": __version__,
            "platform": sys.platform,
            "python": platform_mod.python_version(),
            "config_version": config.config_version,
        }

    # --------------------------------------------------------------------- auth
    @app.post("/api/auth/login")
    async def login(body: LoginBody, request: Request, response: Response):
        ip = client_ip(request)
        if not auth.limiter.allow(ip):
            manager.audit.write("auth.rate_limited", remote=ip)
            raise HTTPException(status_code=429, detail="too many login attempts")
        if not auth.check_password(body.username, body.password):
            auth.limiter.record_failure(ip)
            manager.audit.write("auth.login_failed", remote=ip, username=body.username)
            raise HTTPException(status_code=401, detail="invalid credentials")
        auth.limiter.reset(ip)
        rec = auth.create_session(body.username, ip)
        response.set_cookie(
            COOKIE,
            auth.sign_cookie(rec.sid),
            httponly=True,
            samesite="lax",
            secure=auth.secure_cookie,
            max_age=auth.session_ttl,
            path="/",
        )
        manager.audit.write("auth.login", remote=ip, username=body.username)
        return {"username": rec.username, "csrf": rec.csrf, "expires_at": int(rec.expires)}

    @app.post("/api/auth/logout")
    async def logout(request: Request, response: Response, rec: AdminSession = Depends(csrf_guard)):
        auth.destroy_session(rec.sid)
        response.delete_cookie(COOKIE, path="/")
        manager.audit.write("auth.logout", username=rec.username, remote=rec.remote)
        return {"ok": True}

    @app.get("/api/auth/me")
    async def me(rec: AdminSession = Depends(admin_session)):
        return {"username": rec.username, "csrf": rec.csrf, "expires_at": int(rec.expires)}

    # -------------------------------------------------------------------- ports
    @app.get("/api/ports")
    async def list_ports(rec: AdminSession = Depends(admin_session)):
        return {"ports": manager.ports()}

    # ------------------------------------------------------------------ ssh
    @app.get("/api/ssh/hosts")
    async def ssh_list_hosts(rec: AdminSession = Depends(admin_session)):
        return {"hosts": ssh_profiles.list()}

    @app.post("/api/ssh/hosts", status_code=201)
    async def ssh_create_host(body: SshHostBody, rec: AdminSession = Depends(csrf_guard)):
        host = ssh_profiles.create(body.model_dump(exclude_none=True))
        manager.audit.write("ssh.host_created", host_id=host["id"], host=host["host"], username=host["username"])
        return host

    @app.put("/api/ssh/hosts/{host_id}")
    async def ssh_update_host(host_id: str, body: SshHostBody, rec: AdminSession = Depends(csrf_guard)):
        host = ssh_profiles.update(host_id, body.model_dump(exclude_none=True))
        manager.audit.write("ssh.host_updated", host_id=host_id)
        return host

    @app.delete("/api/ssh/hosts/{host_id}")
    async def ssh_delete_host(host_id: str, rec: AdminSession = Depends(csrf_guard)):
        for session in ssh_manager.list():
            if session["host_id"] == host_id and session["state"] in ("connecting", "open"):
                raise ToolFailure(
                    CONFLICT,
                    "disconnect the open SSH session before deleting this host",
                    {"host_id": host_id, "session_id": session["session_id"]},
                )
        ssh_profiles.delete(host_id)
        manager.audit.write("ssh.host_deleted", host_id=host_id)
        return {"ok": True}

    @app.post("/api/ssh/hosts/{host_id}/connect")
    async def ssh_connect(host_id: str, body: SshConnectBody, rec: AdminSession = Depends(csrf_guard)):
        session = await asyncio.to_thread(
            ssh_manager.connect,
            host_id,
            password=body.password,
            passphrase=body.passphrase,
            cols=body.cols,
            rows=body.rows,
        )
        return {"session": session.status()}

    @app.get("/api/ssh/sessions")
    async def ssh_list_sessions(rec: AdminSession = Depends(admin_session)):
        return {"sessions": ssh_manager.list()}

    @app.get("/api/ssh/sessions/{session_id}")
    async def ssh_get_session(session_id: str, rec: AdminSession = Depends(admin_session)):
        return ssh_manager.get(session_id).status()

    @app.post("/api/ssh/sessions/{session_id}/disconnect")
    async def ssh_disconnect(session_id: str, rec: AdminSession = Depends(csrf_guard)):
        await asyncio.to_thread(ssh_manager.disconnect, session_id)
        return {"ok": True}

    # ----------------------------------------------------------------- sessions
    @app.get("/api/sessions")
    async def list_sessions(rec: AdminSession = Depends(admin_session)):
        return {"sessions": [session_payload(sess) for sess in manager.sessions.values()]}

    @app.get("/api/sessions/{session_id}")
    async def get_session(session_id: str, rec: AdminSession = Depends(admin_session)):
        return session_payload(manager.get(session_id))

    @app.post("/api/sessions", status_code=201)
    async def create_session(body: SessionBody, rec: AdminSession = Depends(csrf_guard)):
        if not body.id:
            raise ToolFailure("INVALID_ARGUMENT", "session id is required")
        sess = manager.create_session(body.to_config(body.id))
        if body.auto_open:
            await asyncio.to_thread(sess.open)
        await asyncio.to_thread(ensure_ttyd, sess.id)
        return session_payload(sess)

    @app.put("/api/sessions/{session_id}")
    async def update_session(session_id: str, body: SessionBody, rec: AdminSession = Depends(csrf_guard)):
        existing = manager.get(session_id)
        new_cfg = body.to_config(session_id)
        reopen = existing.is_open
        await asyncio.to_thread(manager.update_session, new_cfg, reopen=reopen)
        return session_payload(manager.get(session_id))

    @app.delete("/api/sessions/{session_id}")
    async def delete_session(session_id: str, rec: AdminSession = Depends(csrf_guard)):
        await asyncio.to_thread(ttyd.stop, session_id)
        await asyncio.to_thread(manager.remove_session, session_id)
        return {"ok": True}

    @app.post("/api/sessions/{session_id}/open")
    async def open_session(session_id: str, rec: AdminSession = Depends(csrf_guard)):
        sess = manager.get(session_id)
        await asyncio.to_thread(sess.open)
        await asyncio.to_thread(ensure_ttyd, session_id)
        return session_payload(sess)

    @app.post("/api/sessions/{session_id}/close")
    async def close_session(session_id: str, rec: AdminSession = Depends(csrf_guard)):
        sess = manager.get(session_id)
        await asyncio.to_thread(sess.close)
        return session_payload(sess)

    @app.post("/api/sessions/{session_id}/reset")
    async def reset_session(session_id: str, rec: AdminSession = Depends(csrf_guard)):
        sess = manager.get(session_id)
        if not sess.is_open:
            await asyncio.to_thread(sess.open)
        result = await asyncio.to_thread(sess.apply_reset_sequence)
        return {**result, "status": session_payload(sess)}

    @app.put("/api/sessions/{session_id}/control")
    async def set_control(session_id: str, body: ControlBody, rec: AdminSession = Depends(csrf_guard)):
        owner = manager.set_control_owner(session_id, body.owner)
        return {"control_owner": owner}

    @app.put("/api/sessions/{session_id}/permissions")
    async def set_permissions(session_id: str, body: PermissionsBody, rec: AdminSession = Depends(csrf_guard)):
        perms = manager.set_permissions(session_id, body.permissions)
        return {"agent_permissions": perms}

    @app.post("/api/sessions/{session_id}/lines")
    async def set_lines(session_id: str, body: LinesBody, rec: AdminSession = Depends(csrf_guard)):
        sess = manager.get(session_id)
        if body.dtr is None and body.rts is None:
            raise ToolFailure("INVALID_ARGUMENT", "provide dtr and/or rts")
        lines = await asyncio.to_thread(sess.set_lines, body.dtr, body.rts)
        manager.audit.write("session.lines", session=session_id, dtr=body.dtr, rts=body.rts)
        return lines

    @app.post("/api/sessions/{session_id}/break")
    async def break_now(session_id: str, body: BreakBody, rec: AdminSession = Depends(csrf_guard)):
        sess = manager.get(session_id)
        return await asyncio.to_thread(sess.send_break, body.duration_ms, source="human")

    @app.post("/api/sessions/{session_id}/write")
    async def write_now(session_id: str, body: WriteBody, rec: AdminSession = Depends(csrf_guard)):
        sess = manager.get(session_id)
        payload = _body_bytes(body)
        limit = config.security.max_write_bytes_per_call
        if len(payload) > limit:
            raise ToolFailure(
                "INVALID_ARGUMENT",
                f"payload larger than {limit} bytes",
                {"bytes": len(payload), "limit": limit},
            )
        written = await asyncio.to_thread(sess.write_bytes, payload, source="human")
        return {"bytes_written": written, "tx_cursor": sess.ring.head, "control_owner": sess.control_owner}

    @app.post("/api/sessions/{session_id}/command")
    async def command_now(session_id: str, body: CommandBody, rec: AdminSession = Depends(csrf_guard)):
        sess = manager.get(session_id)
        result = await asyncio.to_thread(
            sess.command,
            body.command,
            newline="cr",
            expect=body.expect,
            expect_mode=body.expect_mode,
            timeout_ms=max(1, min(body.timeout_ms, 60000)),
            settle_ms=max(0, min(body.settle_ms, 5000)),
            ignore_case=body.ignore_case,
            source="human",
        )
        return {
            "session_id": sess.id,
            "tx_bytes": result.tx_bytes,
            "rx_text": result.rx_data.decode("utf-8", "replace"),
            "matched": result.matched,
            "match": result.match,
            "groups": result.groups,
            "next_cursor": result.next_cursor,
            "timed_out": result.timed_out,
            "elapsed_ms": result.elapsed_ms,
        }

    @app.get("/api/sessions/{session_id}/transcript")
    async def transcript(session_id: str, limit: int = 200, rec: AdminSession = Depends(admin_session)):
        sess = manager.get(session_id)
        return {"events": sess.transcript.tail(max(1, min(limit, 2000)))}

    @app.get("/api/sessions/{session_id}/export")
    async def export_session(
        session_id: str,
        format: str = "txt",
        limit: int = 5000,
        rec: AdminSession = Depends(admin_session),
    ):
        """Raw byte log with per-chunk timestamps, like a native terminal capture."""
        from collections import deque

        sess = manager.get(session_id)
        if format not in ("txt", "hex"):
            raise ToolFailure("INVALID_ARGUMENT", "format must be txt or hex")
        keep: deque[str] = deque(maxlen=max(1, min(int(limit), 200_000)))
        path = sess.transcript.path
        if path.exists():
            with path.open("r", encoding="utf-8") as fh:
                for line in fh:
                    try:
                        event = json.loads(line)
                    except ValueError:
                        continue
                    if event.get("dir") not in ("rx", "tx"):
                        continue
                    data = base64.b64decode(event.get("data_b64") or "")
                    if format == "hex":
                        payload = data.hex(" ")
                    else:
                        payload = (
                            data.decode("utf-8", "backslashreplace")
                            .replace("\\", "\\\\")
                            .replace("\r", "\\r")
                            .replace("\n", "\\n")
                            .replace("\t", "\\t")
                        )
                    keep.append(
                        f"{event.get('ts', '')}\t{event['dir'].upper()}\t"
                        f"{event.get('source', '')}\t{event.get('offset', '')}\t{payload}"
                    )
        body = "\n".join(keep) + ("\n" if keep else "")
        return Response(
            content=body,
            media_type="text/plain; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{session_id}-raw-{format}.log"'},
        )

    @app.get("/api/audit")
    async def audit(limit: int = 200, rec: AdminSession = Depends(admin_session)):
        return {"events": manager.audit.tail(max(1, min(limit, 2000)))}

    # -------------------------------------------------------------------- system
    @app.get("/api/system")
    async def system(rec: AdminSession = Depends(admin_session)):
        return {
            "version": __version__,
            "uptime_seconds": int(time.time() - started_at),
            "platform": sys.platform,
            "python": platform_mod.python_version(),
            "config_path": str(config.path) if config.path else None,
            "data_dir": str(config.data_dir),
            "log_dir": str(config.log_dir),
            "bind": config.server.bind,
            "port": config.server.port,
            "ttyd": ttyd.status(),
            "sessions": [
                {"session_id": s.id, "state": s.state.value, "port": s.cfg.port} for s in manager.sessions.values()
            ],
            "health": {"sessions_open": sum(1 for s in manager.sessions.values() if s.is_open)},
        }

    @app.get("/api/mcp")
    async def mcp_status(rec: AdminSession = Depends(admin_session)):
        tools = await mcp_server.list_tools()
        host = config.server.bind if config.server.bind not in ("0.0.0.0", "::") else "127.0.0.1"
        base = (
            config.server.public_url.rstrip("/")
            if config.server.public_url
            else f"http://{host}:{config.server.port}"
        )
        return {
            "status": "running",
            "transport": "streamable-http",
            "url": f"{base}/mcp",
            "auth": "bearer",
            "api_token_file": str(config.api_token_file.resolve()),
            "api_token_present": config.api_token_file.exists(),
            "shim": _mcp_shim_path(),
            "server": {
                "name": getattr(mcp_server, "name", "tio-server"),
                "version": getattr(mcp_server, "version", __version__),
            },
            "tools": [
                {
                    "name": tool.name,
                    "description": tool.description or "",
                    "read_only": bool(tool.annotations and tool.annotations.read_only_hint),
                    "destructive": bool(tool.annotations and tool.annotations.destructive_hint),
                }
                for tool in tools
            ],
        }

    @app.post("/api/ttyd/{session_id}/{mode}/start")
    async def ttyd_start(session_id: str, mode: str, rec: AdminSession = Depends(csrf_guard)):
        manager.get(session_id)
        info = await asyncio.to_thread(ttyd.start_for, session_id)
        return {"terminal": info}

    @app.post("/api/ttyd/{session_id}/{mode}/stop")
    async def ttyd_stop(session_id: str, mode: str, rec: AdminSession = Depends(csrf_guard)):
        ttyd.stop(session_id, "rw" if mode == "control" else "ro")
        return {"ok": True}

    # --------------------------------------------------------------- websockets
    def _ws_auth(ws: WebSocket) -> AdminSession | None:
        sid = auth.read_cookie(ws.cookies.get(COOKIE))
        rec = auth.get_session(sid)
        origin = ws.headers.get("origin")
        if origin and not auth.origin_allowed(origin):
            return None
        return rec

    @app.websocket("/ws/console/{session_id}")
    async def ws_console(ws: WebSocket, session_id: str):
        rec = _ws_auth(ws)
        if rec is None:
            await ws.close(code=4401)
            return
        try:
            sess = manager.get(session_id)
        except ToolFailure:
            await ws.close(code=4404)
            return
        await ws.accept()
        replay = int(ws.query_params.get("replay") or config.ttyd.replay_bytes)
        cursor_raw = ws.query_params.get("cursor")
        try:
            cursor = int(cursor_raw) if cursor_raw not in (None, "") else None
        except ValueError:
            cursor = None
        sub = sess.subscribe(
            replay_bytes=max(0, min(replay, 1024 * 1024)),
            cursor=max(0, cursor) if cursor is not None else None,
        )
        send_lock = asyncio.Lock()

        async def send_json(payload: dict) -> None:
            async with send_lock:
                await ws.send_json(payload)

        async def pump() -> None:
            try:
                while True:
                    item = await asyncio.to_thread(sub.get, 0.5)
                    if item is None:
                        continue
                    if item["type"] == "rx":
                        await send_json(
                            {"type": "rx", "offset": item["offset"], "data_b64": base64.b64encode(item["data"]).decode()}
                        )
                    elif item["type"] == "replay":
                        await send_json(
                            {"type": "replay", "offset": item["offset"], "data_b64": base64.b64encode(item["data"]).decode()}
                        )
                    elif item["type"] == "status":
                        await send_json({"type": "status", "status": item["status"]})
                    elif item["type"] == "tx":
                        await send_json(
                            {"type": "tx", "data_b64": base64.b64encode(item["data"]).decode(), "source": item["source"]}
                        )
                    elif item["type"] == "overflow":
                        await send_json({"type": "overflow", "dropped": item["dropped"]})
            except (WebSocketDisconnect, RuntimeError, asyncio.CancelledError):
                return

        task = asyncio.create_task(pump())
        await send_json({"type": "hello", "session_id": sess.id, "mode": "console", "replay_bytes": replay})
        try:
            while True:
                msg = await ws.receive_json()
                kind = msg.get("type")
                req_id = msg.get("id")
                try:
                    if kind == "write":
                        data = base64.b64decode(msg.get("data_b64", ""))
                        written = await asyncio.to_thread(sess.write_bytes, data, source="human")
                        await send_json({"type": "ack", "id": req_id, "bytes_written": written})
                    elif kind == "command":
                        result = await asyncio.to_thread(
                            sess.command,
                            msg.get("command", ""),
                            newline=msg.get("newline", "cr"),
                            expect=msg.get("expect"),
                            timeout_ms=max(1, min(int(msg.get("timeout_ms", 5000)), 60000)),
                            source="human",
                        )
                        await send_json(
                            {
                                "type": "result",
                                "id": req_id,
                                "rx_text": result.rx_data.decode("utf-8", "replace"),
                                "matched": result.matched,
                                "next_cursor": result.next_cursor,
                                "timed_out": result.timed_out,
                                "elapsed_ms": result.elapsed_ms,
                            }
                        )
                    elif kind == "set_lines":
                        await asyncio.to_thread(sess.set_lines, msg.get("dtr"), msg.get("rts"))
                        await send_json({"type": "ack", "id": req_id})
                    elif kind == "ping":
                        await send_json({"type": "pong", "id": req_id})
                    else:
                        await send_json({"type": "error", "id": req_id, "error": {"code": "INVALID_ARGUMENT", "message": "unknown message type"}})
                except ToolFailure as failure:
                    await send_json({"type": "error", "id": req_id, "error": failure.to_dict()["error"]})
        except WebSocketDisconnect:
            pass
        finally:
            task.cancel()
            sess.unsubscribe(sub)

    @app.websocket("/ws/ssh/{session_id}")
    async def ws_ssh(ws: WebSocket, session_id: str):
        rec = _ws_auth(ws)
        if rec is None:
            await ws.close(code=4401)
            return
        try:
            sess = ssh_manager.get(session_id)
        except ToolFailure:
            await ws.close(code=4404)
            return
        await ws.accept()
        replay = int(ws.query_params.get("replay") or config.ttyd.replay_bytes)
        cursor_raw = ws.query_params.get("cursor")
        try:
            cursor = int(cursor_raw) if cursor_raw not in (None, "") else None
        except ValueError:
            cursor = None
        sub = sess.subscribe(
            replay_bytes=max(0, min(replay, 1024 * 1024)),
            cursor=max(0, cursor) if cursor is not None else None,
        )
        send_lock = asyncio.Lock()

        async def send_json(payload: dict) -> None:
            async with send_lock:
                await ws.send_json(payload)

        async def pump() -> None:
            try:
                while True:
                    item = await asyncio.to_thread(sub.get, 0.5)
                    if item is None:
                        continue
                    if item["type"] in ("rx", "replay"):
                        await send_json(
                            {
                                "type": item["type"],
                                "offset": item["offset"],
                                "data_b64": base64.b64encode(item["data"]).decode(),
                            }
                        )
                    elif item["type"] == "status":
                        await send_json({"type": "status", "status": item["status"]})
                    elif item["type"] == "tx":
                        await send_json(
                            {"type": "tx", "data_b64": base64.b64encode(item["data"]).decode(), "source": item["source"]}
                        )
                    elif item["type"] == "overflow":
                        await send_json({"type": "overflow", "dropped": item["dropped"]})
            except (WebSocketDisconnect, RuntimeError, asyncio.CancelledError):
                return

        task = asyncio.create_task(pump())
        await send_json({"type": "hello", "session_id": sess.id, "mode": "ssh", "replay_bytes": replay})
        try:
            while True:
                msg = await ws.receive_json()
                kind = msg.get("type")
                req_id = msg.get("id")
                try:
                    if kind == "input":
                        data = base64.b64decode(msg.get("data_b64", ""), validate=True)
                        written = await asyncio.to_thread(sess.write_bytes, data, source="human")
                        await send_json({"type": "ack", "id": req_id, "bytes_written": written})
                    elif kind == "resize":
                        await asyncio.to_thread(sess.resize, int(msg.get("cols", 120)), int(msg.get("rows", 30)))
                        await send_json({"type": "ack", "id": req_id})
                    elif kind == "ping":
                        await send_json({"type": "pong", "id": req_id})
                    else:
                        await send_json(
                            {
                                "type": "error",
                                "id": req_id,
                                "error": {"code": "INVALID_ARGUMENT", "message": "unknown message type"},
                            }
                        )
                except ToolFailure as failure:
                    await send_json({"type": "error", "id": req_id, "error": failure.to_dict()["error"]})
        except WebSocketDisconnect:
            pass
        finally:
            task.cancel()
            sess.unsubscribe(sub)

    @app.websocket("/ws/bridge/{session_id}")
    async def ws_bridge(ws: WebSocket, session_id: str):
        token = ws.query_params.get("token") or ws.headers.get("x-bridge-token")
        if not auth.check_bridge_token(token):
            manager.audit.write("bridge.unauthorized", session=session_id, remote=ws.client.host if ws.client else "")
            await ws.close(code=4401)
            return
        mode = ws.query_params.get("mode", "ro")
        if mode not in ("ro", "rw"):
            await ws.close(code=4400)
            return
        try:
            sess = manager.get(session_id)
        except ToolFailure:
            await ws.close(code=4404)
            return
        replay = int(ws.query_params.get("replay") or config.ttyd.replay_bytes)
        await ws.accept()
        sub = sess.subscribe(replay_bytes=max(0, min(replay, 1024 * 1024)))
        manager.audit.write("bridge.connect", session=session_id, mode=mode, remote=ws.client.host if ws.client else "")

        async def pump() -> None:
            try:
                while True:
                    item = await asyncio.to_thread(sub.get, 0.5)
                    if item is None:
                        continue
                    if item["type"] in ("rx", "replay"):
                        await ws.send_bytes(item["data"])
                    elif item["type"] == "status":
                        await ws.send_text(json.dumps({"type": "status", "state": item["status"]["state"]}))
                    elif item["type"] == "overflow":
                        await ws.send_text(json.dumps({"type": "overflow", "dropped": item["dropped"]}))
            except (WebSocketDisconnect, RuntimeError, asyncio.CancelledError):
                return

        task = asyncio.create_task(pump())
        await ws.send_text(json.dumps({"type": "hello", "session_id": sess.id, "mode": mode}))
        try:
            while True:
                message = await ws.receive()
                if message["type"] == "websocket.disconnect":
                    break
                data = message.get("bytes")
                text = message.get("text")
                if data is not None:
                    if mode == "rw":
                        try:
                            await asyncio.to_thread(sess.write_bytes, data, source="ttyd")
                        except ToolFailure as failure:
                            await ws.send_text(json.dumps({"type": "error", "error": failure.to_dict()["error"]}))
                    continue
                if text:
                    try:
                        msg = json.loads(text)
                    except json.JSONDecodeError:
                        continue
                    if msg.get("type") == "ping":
                        await ws.send_text(json.dumps({"type": "pong"}))
                    elif msg.get("type") == "set_lines" and mode == "rw":
                        try:
                            await asyncio.to_thread(sess.set_lines, msg.get("dtr"), msg.get("rts"))
                        except ToolFailure as failure:
                            await ws.send_text(json.dumps({"type": "error", "error": failure.to_dict()["error"]}))
        except WebSocketDisconnect:
            pass
        finally:
            task.cancel()
            sess.unsubscribe(sub)

    # ------------------------------------------------------------------- MCP
    app.mount("/mcp", _RootPath(_BearerAuth(mcp_asgi, auth)))

    # --------------------------------------------------------------------- SPA
    assets = STATIC_DIR / "assets"
    if assets.is_dir():
        app.mount("/assets", StaticFiles(directory=str(assets)), name="assets")

    @app.get("/", include_in_schema=False)
    async def index():
        file = STATIC_DIR / "index.html"
        if file.exists():
            return FileResponse(file, headers={"Cache-Control": "no-cache"})
        return HTMLResponse(
            "<html><body style='font-family:system-ui;padding:2rem'>"
            "<h1>tio-server is running</h1><p>The admin UI has not been built yet. "
            "Run <code>npm --prefix frontend ci &amp;&amp; npm --prefix frontend run build</code>.</p>"
            "<p>MCP endpoint: <code>/mcp</code> · health: <code>/healthz</code></p>"
            "</body></html>"
        )

    return app


def _save_config(config: Config) -> None:
    try:
        config.save()
    except OSError:
        pass


def _body_bytes(body: WriteBody) -> bytes:
    if body.text is not None and body.hex is not None:
        raise ToolFailure("INVALID_ARGUMENT", "provide either text or hex")
    if body.hex is not None:
        import re

        cleaned = re.sub(r"[\s,:;_]", "", body.hex)
        if len(cleaned) % 2 or not re.fullmatch(r"[0-9a-fA-F]*", cleaned):
            raise ToolFailure("INVALID_ARGUMENT", "hex must be an even number of hex digits")
        payload = bytes.fromhex(cleaned)
    elif body.text is not None:
        payload = body.text.encode("utf-8")
    else:
        raise ToolFailure("INVALID_ARGUMENT", "provide text or hex")
    extra = {"none": b"", "lf": b"\n", "cr": b"\r", "crlf": b"\r\n"}.get(body.newline)
    if extra is None:
        raise ToolFailure("INVALID_ARGUMENT", "newline must be none|lf|cr|crlf")
    return payload + extra
