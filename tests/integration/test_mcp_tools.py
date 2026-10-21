import json

import pytest

from tio_server.errors import ToolFailure
from tio_server.mcp.tools import build_mcp_server
from tio_server.serial.simulator import wait_until
from tio_server.sessions import SessionManager


@pytest.fixture()
def mcp_setup(make_config):
    cfg = make_config()
    cfg.security.rate_limit_per_second = 1000
    mgr = SessionManager(cfg)
    mcp = build_mcp_server(mgr, cfg)
    yield mgr, mcp, cfg
    mgr.stop()


async def _call(mcp, name, args=None):
    return await mcp.call_tool(name, args or {})


def _structured(result):
    assert result.structured_content is not None
    return result.structured_content


async def test_tools_list_contract(mcp_setup):
    _, mcp, _ = mcp_setup
    tools = await mcp.list_tools()
    names = [t.name for t in tools]
    assert names == [
        "serial_sessions",
        "serial_status",
        "serial_read",
        "serial_write",
        "serial_break",
        "serial_command",
        "serial_expect",
    ]
    for tool in tools:
        assert tool.output_schema is not None, tool.name
        assert tool.annotations is not None, tool.name
    by_name = {t.name: t for t in tools}
    assert by_name["serial_read"].annotations.read_only_hint is True
    assert by_name["serial_write"].annotations.destructive_hint is True
    assert by_name["serial_write"].annotations.read_only_hint is False
    # no port-management tools are exposed
    assert not any(n in names for n in ("serial_open", "serial_close", "serial_configure"))


async def test_sessions_and_status(mcp_setup):
    mgr, mcp, _ = mcp_setup
    mgr.get("board-a").open()
    res = await _call(mcp, "serial_sessions")
    assert res.is_error is False
    data = _structured(res)
    assert data["sessions"][0]["session_id"] == "board-a"

    res = await _call(mcp, "serial_status", {})
    data = _structured(res)
    assert data["state"] == "open"
    assert data["control_owner"] == "human"
    assert data["platform"] in ("windows", "posix")


async def test_read_banner_and_cursor(mcp_setup):
    mgr, mcp, _ = mcp_setup
    sess = mgr.get("board-a")
    sess.open()
    assert wait_until(lambda: sess.ring.head > 0)
    res = await _call(mcp, "serial_read", {"cursor": 0, "timeout_ms": 500})
    data = _structured(res)
    assert "TioSim" in data["text"]
    assert data["next_cursor"] == data["head_cursor"] or data["next_cursor"] <= data["head_cursor"]
    # second read at the cursor returns only new data
    res2 = await _call(mcp, "serial_read", {"cursor": data["next_cursor"], "timeout_ms": 50})
    assert _structured(res2)["text"] == ""


async def test_read_tail_and_hex(mcp_setup):
    mgr, mcp, _ = mcp_setup
    sess = mgr.get("board-a")
    sess.open()
    assert wait_until(lambda: sess.ring.head > 0)
    res = await _call(mcp, "serial_read", {"tail_bytes": 5, "format": "hex", "timeout_ms": 100})
    data = _structured(res)
    assert data["hex"] is not None and data["text"] is None
    assert len(data["hex"].splitlines()) >= 1


async def test_write_locked_error_shape(mcp_setup):
    mgr, mcp, _ = mcp_setup
    mgr.get("board-a").open()
    res = await _call(mcp, "serial_write", {"data": "ping"})
    assert res.is_error is True
    payload = _structured(res)
    assert payload["error"]["code"] == "WRITE_LOCKED"
    assert payload["error"]["retryable"] is True
    # the text channel carries the same JSON
    assert json.loads(res.content[0].text)["error"]["code"] == "WRITE_LOCKED"


async def test_write_and_command_after_handover(mcp_setup):
    mgr, mcp, _ = mcp_setup
    mgr.get("board-a").open()
    mgr.set_control_owner("board-a", "agent")
    res = await _call(mcp, "serial_write", {"data": "echo hi", "newline": "cr"})
    data = _structured(res)
    assert data["bytes_written"] == 8
    assert data["control_owner"] == "agent"

    assert wait_until(lambda: b"hi" in mgr.get("board-a").ring.read(0, 4096).data)
    res = await _call(
        mcp,
        "serial_command",
        {"command": "version", "newline": "cr", "expect": r"tiosim (\S+)", "expect_mode": "regex"},
    )
    data = _structured(res)
    assert data["matched"] is True
    assert data["groups"] == ["1.0.0"]
    assert data["tx_bytes"] == 8  # len("version") + CR


async def test_break_requires_control_and_reports_duration(mcp_setup):
    mgr, mcp, _ = mcp_setup
    mgr.get("board-a").open()
    res = await _call(mcp, "serial_break", {})
    assert res.is_error is True
    assert _structured(res)["error"]["code"] == "WRITE_LOCKED"

    mgr.set_control_owner("board-a", "agent")
    res = await _call(mcp, "serial_break", {"duration_ms": 120})
    assert res.is_error is False
    data = _structured(res)
    assert data["duration_ms"] == 120
    assert data["session_id"] == "board-a"


async def test_command_timeout_is_not_an_error(mcp_setup):
    mgr, mcp, _ = mcp_setup
    mgr.get("board-a").open()
    mgr.set_control_owner("board-a", "agent")
    res = await _call(
        mcp, "serial_command", {"command": "ping", "newline": "cr", "expect": "nope", "timeout_ms": 120}
    )
    assert res.is_error is False
    data = _structured(res)
    assert data["timed_out"] is True
    assert data["matched"] is False


async def test_expect_tool(mcp_setup):
    mgr, mcp, _ = mcp_setup
    sess = mgr.get("board-a")
    sess.open()
    assert wait_until(lambda: b"tiosim>" in sess.ring.read(0, 4096).data)
    res = await _call(mcp, "serial_expect", {"pattern": "help", "timeout_ms": 100})
    assert _structured(res)["matched"] is False
    start = sess.ring.head
    sess.write_bytes(b"help\r", source="human")
    res2 = await _call(
        mcp, "serial_expect", {"pattern": "commands:", "cursor": start, "timeout_ms": 2000}
    )
    data = _structured(res2)
    assert data["matched"] is True
    assert data["next_cursor"] > 0


async def test_invalid_arguments(mcp_setup):
    _, mcp, _ = mcp_setup
    res = await _call(mcp, "serial_write", {"data": "x", "hex": "00"})
    assert res.is_error is True
    assert _structured(res)["error"]["code"] == "INVALID_ARGUMENT"
    res = await _call(mcp, "serial_read", {"cursor": 0, "tail_bytes": 10})
    assert _structured(res)["error"]["code"] == "INVALID_ARGUMENT"
    res = await _call(mcp, "serial_read", {"format": "yaml"})
    assert _structured(res)["error"]["code"] == "INVALID_ARGUMENT"


async def test_unknown_session(mcp_setup):
    _, mcp, _ = mcp_setup
    res = await _call(mcp, "serial_status", {"session_id": "nope"})
    assert res.is_error is True
    assert _structured(res)["error"]["code"] == "SESSION_NOT_FOUND"


async def test_agent_permission_switch(mcp_setup):
    mgr, mcp, _ = mcp_setup
    mgr.get("board-a").open()
    mgr.set_control_owner("board-a", "agent")
    mgr.set_permissions("board-a", ["read"])
    res = await _call(mcp, "serial_write", {"data": "ping"})
    assert _structured(res)["error"]["code"] == "WRITE_DISABLED"
    mgr.set_permissions("board-a", ["write"])
    res = await _call(mcp, "serial_read", {"tail_bytes": 10})
    assert _structured(res)["error"]["code"] == "READ_DISABLED"


async def test_rate_limit(make_config):
    cfg = make_config()
    cfg.security.rate_limit_per_second = 3
    mgr = SessionManager(cfg)
    mcp = build_mcp_server(mgr, cfg)
    try:
        codes = []
        for _ in range(5):
            res = await _call(mcp, "serial_sessions")
            codes.append("RATE_LIMITED" if res.is_error else "ok")
        assert codes[-1] == "RATE_LIMITED"
    finally:
        mgr.stop()


async def test_gap_reporting(make_config):
    cfg = make_config()
    cfg.security.rate_limit_per_second = 1000
    cfg.sessions[0].buffer_bytes = 1024 * 1024
    mgr = SessionManager(cfg)
    mcp = build_mcp_server(mgr, cfg)
    try:
        mgr.get("board-a").open()
        dev = mgr.backend.simulator.device("board-a")
        dev.emit("y" * (1024 * 1024 + 10))
        assert wait_until(lambda: mgr.get("board-a").ring.head > 1024 * 1024)
        res = await _call(mcp, "serial_read", {"cursor": 0, "tail_bytes": None})
        data = _structured(res)
        assert data["gap"] is True
        assert data["lost_bytes"] > 0
    finally:
        mgr.stop()
