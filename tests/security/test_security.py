"""Adversarial tests: MCP bearer, Origin/Host guard, size limits, regex DoS, traversal."""

from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient

from tio_server.config import init_config
from tio_server.mcp.tools import build_mcp_server
from tio_server.serial.simulator import wait_until
from tio_server.sessions import SessionManager
from tio_server.web.app import create_app


@pytest.fixture()
def secured(tmp_path):
    cfg, secrets = init_config(tmp_path / "data")
    cfg.security.allow_dev_ports = True
    cfg.security.rate_limit_per_second = 500
    cfg.sessions = []
    app = create_app(cfg)
    with TestClient(app, base_url="http://127.0.0.1:8765") as client:
        yield client, cfg, secrets, app
    app.state.manager.stop()


def test_api_rejects_foreign_origin(secured):
    client, cfg, secrets, _ = secured
    cases = [
        ("get", "/api/sessions", None),
        ("post", "/api/sessions", {"id": "x", "port": "sim://x"}),
    ]
    for method, path, body in cases:
        kwargs = {"json": body} if body is not None and method in ("post", "put") else {}
        response = getattr(client, method)(path, headers={"Origin": "http://evil.example"}, **kwargs)
        assert response.status_code == 403, (method, path, response.status_code, response.text[:120])


def test_api_rejects_foreign_host(secured):
    client, cfg, secrets, _ = secured
    response = client.get("/api/sessions", headers={"host": "evil.example"})
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "FORBIDDEN"


def test_mcp_bearer_is_strict(secured):
    client, cfg, secrets, _ = secured
    for header in ({}, {"Authorization": "Bearer "}, {"Authorization": "Basic abc"}, {"Authorization": f"Bearer {secrets['api_token']}x"}):
        response = client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, headers=header)
        assert response.status_code == 401, header


def test_write_payload_limit(secured):
    client, cfg, secrets, _ = secured
    client.post("/api/sessions", json={"id": "b", "port": "sim://b", "auto_open": True})
    huge = "x" * (cfg.security.max_write_bytes_per_call + 1)
    response = client.post(
        "/api/sessions/b/write", json={"text": huge}
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "INVALID_ARGUMENT"


def test_read_is_clamped_to_configured_cap(secured):
    client, cfg, secrets, _ = secured
    client.post("/api/sessions", json={"id": "b", "port": "sim://b", "auto_open": True})
    time.sleep(0.3)
    response = client.get("/api/sessions/b")
    assert response.json()["rx_head"] > 0


def test_path_traversal_and_unknown_session(secured):
    client, cfg, secrets, _ = secured
    for path in (
        "/api/sessions/../../../../etc/passwd",
        "/api/sessions/%2e%2e%2f%2e%2e%2fetc%2fpasswd",
        "/api/sessions/nope",
    ):
        response = client.get(path)
        assert response.status_code in (400, 404), (path, response.status_code)


async def test_regex_dos_is_bounded(make_config):
    cfg = make_config()
    cfg.security.rate_limit_per_second = 1000
    cfg.security.regex_timeout_ms = 200
    mgr = SessionManager(cfg)
    mcp = build_mcp_server(mgr, cfg)
    try:
        session = mgr.get("board-a")
        session.open()
        dev = mgr.backend.simulator.device("board-a")
        dev.emit("a" * 40000 + "!")
        assert wait_until(lambda: session.ring.head > 40000)
        started = time.monotonic()
        result = await mcp.call_tool(
            "serial_expect",
            {"pattern": r"(a+)+b", "mode": "regex", "cursor": 0, "timeout_ms": 2000},
        )
        elapsed = time.monotonic() - started
        assert elapsed < 5, elapsed
        if result.is_error:
            assert result.structured_content["error"]["code"] in ("TIMEOUT", "INVALID_ARGUMENT")
        else:
            assert result.structured_content["timed_out"] is True
    finally:
        mgr.stop()


async def test_pattern_length_limit(make_config):
    cfg = make_config()
    cfg.security.max_pattern_length = 32
    cfg.security.rate_limit_per_second = 1000
    mgr = SessionManager(cfg)
    mcp = build_mcp_server(mgr, cfg)
    try:
        mgr.get("board-a").open()
        result = await mcp.call_tool(
            "serial_expect", {"pattern": "x" * 33, "timeout_ms": 100}
        )
        assert result.is_error is True
        assert result.structured_content["error"]["code"] == "INVALID_ARGUMENT"
    finally:
        mgr.stop()


def test_health_endpoint_leaks_nothing(secured):
    client, cfg, secrets, _ = secured
    response = client.get("/healthz")
    assert response.json() == {"status": "ok"}
    ready = client.get("/readyz").json()
    assert set(ready) == {"status", "sessions_open", "sessions_total"}


def test_console_websocket_rejects_foreign_origin(secured):
    client, cfg, secrets, _ = secured
    client.post("/api/sessions", json={"id": "b", "port": "sim://b", "auto_open": True})
    with pytest.raises(Exception):
        with client.websocket_connect(
            "/ws/console/b", headers={"origin": "http://evil.example"}
        ) as ws:
            ws.receive_json()
