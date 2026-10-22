import base64
import json
import time

import pytest
from fastapi.testclient import TestClient

from tio_server.config import init_config
from tio_server.web.app import create_app


@pytest.fixture()
def app_bundle(tmp_path):
    cfg, secrets = init_config(tmp_path / "data")
    cfg.security.allow_dev_ports = True
    cfg.sessions = []
    app = create_app(cfg)
    with TestClient(app, base_url="http://127.0.0.1:8765") as client:
        yield client, cfg, secrets
    app.state.manager.stop()


def login(client: TestClient, secrets: dict) -> str:
    r = client.post("/api/auth/login", json={"username": "admin", "password": secrets["admin_password"]})
    assert r.status_code == 200, r.text
    return r.json()["csrf"]


def create_session(client: TestClient, csrf: str, **overrides) -> dict:
    body = {
        "id": "board-a",
        "name": "Board A",
        "port": "sim://board-a",
        "baudrate": 115200,
        "auto_open": True,
        "agent_permissions": ["read", "write", "command"],
    }
    body.update(overrides)
    r = client.post("/api/sessions", json=body, headers={"X-CSRF-Token": csrf})
    assert r.status_code == 201, r.text
    return r.json()


def sse_json(text: str) -> list[dict]:
    out = []
    for line in text.splitlines():
        if line.startswith("data: "):
            out.append(json.loads(line[6:]))
    return out


def test_health_and_auth_gate(app_bundle):
    client, _, secrets = app_bundle
    assert client.get("/healthz").json() == {"status": "ok"}
    assert client.get("/readyz").status_code == 200
    assert client.get("/api/sessions").status_code == 401
    bad = client.post("/api/auth/login", json={"username": "admin", "password": "nope"})
    assert bad.status_code == 401
    login(client, secrets)
    me = client.get("/api/auth/me")
    assert me.status_code == 200
    assert me.json()["username"] == "admin"


def test_csrf_required_and_origin_checked(app_bundle):
    client, _, secrets = app_bundle
    csrf = login(client, secrets)
    r = client.post("/api/sessions", json={"id": "x", "port": "sim://x"})
    assert r.status_code == 403
    r = client.post(
        "/api/sessions",
        json={"id": "x", "port": "sim://x"},
        headers={"X-CSRF-Token": csrf, "Origin": "http://evil.example"},
    )
    assert r.status_code == 403
    r = client.post("/api/sessions", json={"id": "x", "port": "sim://x"}, headers={"X-CSRF-Token": "wrong"})
    assert r.status_code == 403


def test_session_lifecycle(app_bundle):
    client, cfg, secrets = app_bundle
    csrf = login(client, secrets)
    created = create_session(client, csrf)
    assert created["state"] == "open"
    sessions = client.get("/api/sessions").json()["sessions"]
    assert sessions[0]["session_id"] == "board-a"

    r = client.post("/api/sessions/board-a/close", headers={"X-CSRF-Token": csrf})
    assert r.json()["state"] == "closed"
    r = client.post("/api/sessions/board-a/open", headers={"X-CSRF-Token": csrf})
    assert r.json()["state"] == "open"

    r = client.put(
        "/api/sessions/board-a/permissions", json={"permissions": ["read"]}, headers={"X-CSRF-Token": csrf}
    )
    assert r.json()["agent_permissions"] == ["read"]
    r = client.put("/api/sessions/board-a/control", json={"owner": "agent"}, headers={"X-CSRF-Token": csrf})
    assert r.json()["control_owner"] == "agent"

    r = client.post("/api/sessions/board-a/write", json={"text": "ping", "newline": "cr"}, headers={"X-CSRF-Token": csrf})
    assert r.status_code == 409  # agent owns control, humans are locked out

    client.put("/api/sessions/board-a/control", json={"owner": "human"}, headers={"X-CSRF-Token": csrf})
    r = client.post("/api/sessions/board-a/write", json={"text": "ping", "newline": "cr"}, headers={"X-CSRF-Token": csrf})
    assert r.status_code == 200
    assert r.json()["bytes_written"] == 5

    r = client.post(
        "/api/sessions/board-a/command",
        json={"command": "echo hi", "expect": "hi", "timeout_ms": 2000},
        headers={"X-CSRF-Token": csrf},
    )
    assert r.json()["matched"] is True

    events = client.get("/api/sessions/board-a/transcript").json()["events"]
    assert any(e.get("event") == "open" for e in events)
    assert any(e.get("dir") == "rx" for e in events)
    audit = client.get("/api/audit").json()["events"]
    assert any(e.get("event") == "session.open" for e in audit)


def test_invalid_session_rejected(app_bundle):
    client, _, secrets = app_bundle
    csrf = login(client, secrets)
    r = client.post(
        "/api/sessions",
        json={"id": "bad id!", "port": "COM3"},
        headers={"X-CSRF-Token": csrf},
    )
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "CONFIG_INVALID"
    r = client.post(
        "/api/sessions",
        json={"id": "ok", "port": "/dev/zero"},
        headers={"X-CSRF-Token": csrf},
    )
    assert r.status_code == 400


def test_mcp_status_endpoint(app_bundle):
    client, _, secrets = app_bundle
    assert client.get("/api/mcp").status_code == 401
    login(client, secrets)
    r = client.get("/api/mcp")
    assert r.status_code == 200
    data = r.json()
    assert data["status"] == "running"
    assert data["transport"] == "streamable-http"
    assert data["url"].endswith("/mcp")
    assert data["auth"] == "bearer"
    assert data["api_token_file"].endswith("api-token")
    assert data["shim"]
    names = [tool["name"] for tool in data["tools"]]
    assert names == [
        "serial_sessions",
        "serial_status",
        "serial_read",
        "serial_write",
        "serial_break",
        "serial_command",
        "serial_expect",
    ]
    assert any(tool["read_only"] for tool in data["tools"])
    assert any(tool["destructive"] for tool in data["tools"])


def test_ports_endpoint(app_bundle):
    client, _, secrets = app_bundle
    login(client, secrets)
    r = client.get("/api/ports")
    assert r.status_code == 200
    assert isinstance(r.json()["ports"], list)


def test_mcp_requires_bearer(app_bundle):
    client, _, secrets = app_bundle
    r = client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
    assert r.status_code == 401
    r = client.post(
        "/mcp",
        json={"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
        headers={"Authorization": "Bearer wrong"},
    )
    assert r.status_code == 401


def test_mcp_end_to_end(app_bundle):
    client, _, secrets = app_bundle
    csrf = login(client, secrets)
    create_session(client, csrf)
    headers = {
        "Authorization": f"Bearer {secrets['api_token']}",
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json",
    }
    init = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2026-07-28",
            "capabilities": {},
            "clientInfo": {"name": "pytest", "version": "0"},
        },
    }
    r = client.post("/mcp", json=init, headers=headers)
    assert r.status_code == 200, r.text
    messages = sse_json(r.text)
    assert messages[0]["result"]["serverInfo"]["name"] == "tio-server"
    sid = r.headers.get("mcp-session-id")
    if sid:
        headers["Mcp-Session-Id"] = sid
    r = client.post("/mcp", json={"jsonrpc": "2.0", "method": "notifications/initialized"}, headers=headers)
    assert r.status_code in (200, 202)

    r = client.post("/mcp", json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, headers=headers)
    tools = sse_json(r.text)[0]["result"]["tools"]
    assert [t["name"] for t in tools][:3] == ["serial_sessions", "serial_status", "serial_read"]

    call = {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "serial_read", "arguments": {"tail_bytes": 64}}}
    r = client.post("/mcp", json=call, headers=headers)
    result = sse_json(r.text)[0]["result"]
    assert result.get("isError") is False
    assert "board=board-a" in result["structuredContent"]["text"]


def ws_cookie(client: TestClient) -> dict[str, str]:
    jar = "; ".join(f"{c.name}={c.value}" for c in client.cookies.jar)
    return {"cookie": jar}


def test_console_websocket(app_bundle):
    client, _, secrets = app_bundle
    csrf = login(client, secrets)
    create_session(client, csrf)
    with client.websocket_connect("/ws/console/board-a", headers=ws_cookie(client)) as ws:
        hello = ws.receive_json()
        assert hello["type"] in ("hello", "status")
        # drain until we can send
        ws.send_json({"type": "command", "id": 7, "command": "ping", "newline": "cr", "timeout_ms": 3000})
        frames = 0
        while frames < 30:
            frame = ws.receive_json()
            frames += 1
            if frame.get("type") == "result" and frame.get("id") == 7:
                assert "pong" in frame["rx_text"]
                break
            if frame.get("type") == "error":
                pytest.fail(f"console error: {frame}")
        else:
            pytest.fail("no result frame")


def test_console_websocket_requires_login(app_bundle):
    client, _, secrets = app_bundle
    csrf = login(client, secrets)
    create_session(client, csrf)
    client.cookies.clear()
    with pytest.raises(Exception):
        with client.websocket_connect("/ws/console/board-a", headers={"cookie": ""}) as ws:
            ws.receive_json()


def test_bridge_websocket_token_and_bytes(app_bundle):
    client, cfg, secrets = app_bundle
    csrf = login(client, secrets)
    create_session(client, csrf)
    token = cfg.bridge_token_file.read_text(encoding="utf-8").strip()
    # Without a token the socket is refused.
    with pytest.raises(Exception):
        with client.websocket_connect("/ws/bridge/board-a?mode=rw") as ws:
            ws.receive()
    with client.websocket_connect(f"/ws/bridge/board-a?mode=rw&token={token}") as ws:
        hello = ws.receive_json()
        assert hello["session_id"] == "board-a"
        ws.send_bytes(b"ping\r")
        got = b""
        for _ in range(20):
            message = ws.receive()
            if message.get("bytes"):
                got += message["bytes"]
                if b"pong" in got:
                    break
        assert b"pong" in got


def test_runtime_state_resets_on_restart(tmp_path):
    cfg, secrets = init_config(tmp_path / "data")
    cfg.security.allow_dev_ports = True
    cfg.sessions = []
    app = create_app(cfg)
    with TestClient(app, base_url="http://127.0.0.1:8765") as client:
        csrf = login(client, secrets)
        create_session(client, csrf)
        client.put("/api/sessions/board-a/control", json={"owner": "agent"}, headers={"X-CSRF-Token": csrf})
        saved = client.get("/api/sessions").json()["sessions"][0]
        assert saved["control_owner"] == "agent"
    app.state.manager.stop()
    # A fresh process loads the config: control ownership is human again.
    from tio_server.config import Config

    cfg2 = Config.load(cfg.path)
    from tio_server.sessions import SessionManager

    mgr = SessionManager(cfg2)
    try:
        assert mgr.get("board-a").control_owner == "human"
    finally:
        mgr.stop()


def test_break_and_raw_export(app_bundle):
    client, cfg, secrets = app_bundle
    csrf = login(client, secrets)
    create_session(client, csrf)
    client.post(
        "/api/sessions/board-a/write",
        json={"text": "ping", "newline": "cr"},
        headers={"X-CSRF-Token": csrf},
    )
    r = client.post(
        "/api/sessions/board-a/break",
        json={"duration_ms": 120},
        headers={"X-CSRF-Token": csrf},
    )
    assert r.status_code == 200, r.text
    assert r.json()["duration_ms"] == 120

    txt = client.get("/api/sessions/board-a/export?format=txt")
    assert txt.status_code == 200
    assert "attachment" in txt.headers["content-disposition"]
    assert "\tTX\t" in txt.text and "pong" in txt.text

    hexed = client.get("/api/sessions/board-a/export?format=hex")
    assert hexed.status_code == 200
    assert "70 69 6e 67" in hexed.text  # "ping"
    assert client.get("/api/sessions/board-a/export?format=nope").status_code == 400


def test_console_ws_resumes_from_cursor_without_replaying(app_bundle):
    client, cfg, secrets = app_bundle
    csrf = login(client, secrets)
    create_session(client, csrf)
    cookie = "; ".join(f"{item.name}={item.value}" for item in client.cookies.jar)

    with client.websocket_connect("/ws/console/board-a?replay=65536", headers={"cookie": cookie}) as ws:
        hello = ws.receive_json()
        assert hello["type"] == "hello"
        replay = ws.receive_json()
        assert replay["type"] == "replay"
        head = replay["offset"] + len(base64.b64decode(replay["data_b64"]))
        ws.receive_json()  # status

    # New subscriber at head, before any new data: no replay of the old buffer.
    with client.websocket_connect(f"/ws/console/board-a?cursor={head}", headers={"cookie": cookie}) as ws:
        assert ws.receive_json()["type"] == "hello"
        first = ws.receive_json()
        assert first["type"] != "replay", first

    client.post(
        "/api/sessions/board-a/write",
        json={"text": "ping", "newline": "cr"},
        headers={"X-CSRF-Token": csrf},
    )
    # Catching up from the old cursor returns only what came after it: the new
    # reply, not the boot banner that was already on screen.
    with client.websocket_connect(f"/ws/console/board-a?cursor={head}", headers={"cookie": cookie}) as ws:
        ws.receive_json()  # hello
        received = b""
        for _ in range(20):
            message = ws.receive_json()
            if message["type"] in ("rx", "replay"):
                received += base64.b64decode(message["data_b64"])
                break
        assert b"pong" in received
        assert b"TioSim" not in received
