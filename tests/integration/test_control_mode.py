"""The production control model: the agent owns the wire, the operator observes.

``control = "agent"`` is the default for every session: the agent writes without
a hand-off, the operator's console is an audit view, and the write paths that
the web UI offers must say ``READ_ONLY`` instead of silently doing nothing.
``control = "shared"`` keeps the older ``control_owner`` hand-off; those paths
are covered by ``test_session.py`` and ``test_http_api.py``.

Also covered here: with exactly one serial session the MCP surface binds it
automatically, so an agent never connects to a server that publishes no tools.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from tio_server.config import Config, SessionConfig, init_config
from tio_server.errors import ToolFailure
from tio_server.mcp.bindings import McpBindings
from tio_server.mcp.tools import build_mcp_server
from tio_server.serial.simulator import wait_until
from tio_server.sessions import SessionManager
from tio_server.web.app import create_app


def _agent_session(port: str = "sim://board-a", session_id: str = "board-a") -> SessionConfig:
    return SessionConfig(id=session_id, name="Board A", port=port, auto_open=False)


# --------------------------------------------------------------------- engine
def test_default_session_is_agent_controlled():
    cfg = SessionConfig(id="x", port="sim://x")
    assert cfg.control == "agent"


def test_config_rejects_unknown_control(tmp_path):
    cfg = Config()
    cfg.sessions = [SessionConfig(id="x", port="sim://x", control="owner")]
    with pytest.raises(ToolFailure) as exc:
        cfg.validate_session(cfg.sessions[0])
    assert exc.value.code == "CONFIG_INVALID"


def test_agent_writes_without_a_handoff(make_config):
    cfg = make_config(sessions=[_agent_session()])
    mgr = SessionManager(cfg, backend=None)
    try:
        sess = mgr.get("board-a")
        sess.open()
        assert wait_until(lambda: b"tiosim>" in sess.ring.read(0, 4096).data)
        # No set_control_owner() call anywhere: the agent is the owner already.
        assert sess.write_bytes(b"ping\r", source="agent") == 5
        assert wait_until(lambda: b"pong" in sess.ring.read(0, 4096).data)
    finally:
        mgr.stop()


def test_operator_write_is_read_only(make_config):
    cfg = make_config(sessions=[_agent_session()])
    mgr = SessionManager(cfg, backend=None)
    try:
        sess = mgr.get("board-a")
        sess.open()
        for need in ("write", "command"):
            with pytest.raises(ToolFailure) as exc:
                sess.write_bytes(b"x", source="human", need=need)
            assert exc.value.code == "READ_ONLY"
        with pytest.raises(ToolFailure) as exc:
            sess.send_break(100, source="human")
        assert exc.value.code == "READ_ONLY"
    finally:
        mgr.stop()


def test_control_handoff_is_refused(make_config):
    cfg = make_config(sessions=[_agent_session()])
    mgr = SessionManager(cfg, backend=None)
    try:
        with pytest.raises(ToolFailure) as exc:
            mgr.set_control_owner("board-a", "human")
        assert exc.value.code == "READ_ONLY"
    finally:
        mgr.stop()


def test_status_reports_observe_only(make_config):
    cfg = make_config(sessions=[_agent_session()])
    mgr = SessionManager(cfg, backend=None)
    try:
        status = mgr.get("board-a").status()
        assert status["control"] == "agent"
        assert status["control_owner"] == "agent"
        assert status["human_writable"] is False
    finally:
        mgr.stop()


def test_shared_mode_keeps_the_handoff(make_config):
    cfg = make_config(
        sessions=[SessionConfig(id="board-a", port="sim://board-a", auto_open=False, control="shared")]
    )
    mgr = SessionManager(cfg, backend=None)
    try:
        sess = mgr.get("board-a")
        assert sess.status()["human_writable"] is True
        with pytest.raises(ToolFailure) as exc:
            sess.open()
            sess.write_bytes(b"x", source="agent")
        assert exc.value.code == "WRITE_LOCKED"
    finally:
        mgr.stop()


# ------------------------------------------------------------------------ MCP
def _bound_names(mcp) -> list[str]:
    import asyncio

    tools = asyncio.run(mcp.list_tools())
    return sorted(tool.name for tool in tools)


def test_single_serial_session_autobinds(tmp_path):
    """One session -> the agent gets the serial tools without operator action."""
    cfg, _ = init_config(tmp_path / "data")
    cfg.security.allow_dev_ports = True
    cfg.sessions = [_agent_session()]
    app = create_app(cfg)
    with TestClient(app, base_url="http://127.0.0.1:8765") as client:
        bindings = client.get("/api/mcp/bindings").json()
        assert bindings["serial_session_id"] == "board-a"
        assert client.get("/api/sessions").json()["sessions"][0]["control"] == "agent"
    app.state.manager.stop()


def test_two_sessions_do_not_autobind(tmp_path):
    """Two sessions is a real choice, so the operator still picks in the MCP tab."""
    cfg, _ = init_config(tmp_path / "data")
    cfg.security.allow_dev_ports = True
    cfg.sessions = [_agent_session(), _agent_session(port="sim://board-b", session_id="board-b")]
    app = create_app(cfg)
    with TestClient(app, base_url="http://127.0.0.1:8765") as client:
        assert client.get("/api/mcp/bindings").json()["serial_session_id"] is None
    app.state.manager.stop()


def test_autobind_publishes_serial_tools(tmp_path):
    cfg, _ = init_config(tmp_path / "data")
    cfg.security.allow_dev_ports = True
    cfg.sessions = [_agent_session()]
    app = create_app(cfg)
    with TestClient(app, base_url="http://127.0.0.1:8765") as client:
        mcp = app.state.mcp_server
        names = _bound_names(mcp)
        assert "serial_status" in names and "serial_command" in names
    app.state.manager.stop()


def test_unbound_server_publishes_nothing(make_config):
    """Without a binding the surface stays empty (the pre-autobind behaviour)."""
    cfg = make_config()
    mgr = SessionManager(cfg, backend=None)
    try:
        mcp = build_mcp_server(mgr, cfg, bindings=McpBindings())
        assert _bound_names(mcp) == []
    finally:
        mgr.stop()


# ------------------------------------------------------------------------ HTTP
@pytest.fixture()
def agent_app(tmp_path):
    cfg, secrets = init_config(tmp_path / "data")
    cfg.security.allow_dev_ports = True
    cfg.sessions = []
    app = create_app(cfg)
    with TestClient(app, base_url="http://127.0.0.1:8765") as client:
        yield client, cfg, secrets, app
    app.state.manager.stop()


def test_operator_write_endpoints_are_read_only(agent_app):
    client, _, _, _ = agent_app
    created = client.post(
        "/api/sessions",
        json={"id": "board-a", "port": "sim://board-a", "auto_open": True},
    )
    assert created.status_code == 201, created.text
    assert created.json()["control"] == "agent"
    assert created.json()["human_writable"] is False

    for path, body in (
        ("/api/sessions/board-a/write", {"text": "x"}),
        ("/api/sessions/board-a/command", {"command": "ping"}),
        ("/api/sessions/board-a/break", {"duration_ms": 50}),
    ):
        response = client.post(path, json=body)
        assert response.status_code == 403, (path, response.status_code, response.text)
        assert response.json()["error"]["code"] == "READ_ONLY", path

    control = client.put("/api/sessions/board-a/control", json={"owner": "human"})
    assert control.status_code == 403
    assert control.json()["error"]["code"] == "READ_ONLY"


def test_console_websocket_is_observe_only(agent_app):
    client, _, _, _ = agent_app
    client.post("/api/sessions", json={"id": "board-a", "port": "sim://board-a", "auto_open": True})
    with client.websocket_connect("/ws/console/board-a") as ws:
        assert ws.receive_json()["type"] in ("hello", "status")
        ws.send_json({"type": "command", "id": 1, "command": "ping", "newline": "cr"})
        for _ in range(30):
            frame = ws.receive_json()
            if frame.get("id") == 1 and frame.get("type") == "error":
                assert frame["error"]["code"] == "READ_ONLY"
                break
        else:
            pytest.fail("no READ_ONLY error frame")
        # RX still streams to the observer.
        ws.send_json({"type": "ping", "id": 2})
