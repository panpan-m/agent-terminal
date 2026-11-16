"""Logs and audit must be readable one MCP client at a time.

Two places carry the attribution:

* the transcript — a ``tx`` record names the client that wrote the bytes, so a
  byte-level log can be narrowed to one agent;
* the audit file — tool calls carry ``agent``, lease events ``owner``/``by``.

The filters live in the stores and are exposed through the HTTP API, so the web
Logs page can show "only this client" without scanning everything client-side.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from tio_server.config import SessionConfig, init_config
from tio_server.transcript import AuditLog, Redactor, TranscriptWriter
from tio_server.web.app import create_app


# ------------------------------------------------------------------- stores
def test_audit_tail_filters_by_client(tmp_path):
    log = AuditLog(tmp_path, redactor=Redactor())
    log.write("mcp.tool_call", tool="serial_write", agent="agent-a", ok=True)
    log.write("mcp.tool_call", tool="serial_write", agent="agent-b", ok=True)
    log.write("lease.acquire", owner="agent-a", ttl_ms=1000)
    log.write("session.open", session="board")

    only_a = log.tail(50, client="agent-a")
    assert [e["event"] for e in only_a] == ["mcp.tool_call", "lease.acquire"]

    only_b = log.tail(50, client="agent-b")
    assert len(only_b) == 1
    assert only_b[0]["event"] == "mcp.tool_call"

    assert log.tail(50, client="nobody") == []
    # unfiltered still returns everything, including records with no client
    assert len(log.tail(50)) == 4


def test_audit_filter_searches_the_whole_file_not_just_the_tail(tmp_path):
    log = AuditLog(tmp_path, redactor=Redactor())
    log.write("mcp.tool_call", tool="serial_write", agent="agent-a", ok=True)
    for index in range(50):
        log.write("session.lines", dtr=bool(index % 2))
    # the matching record is far older than the last few lines
    assert len(log.tail(5, client="agent-a")) == 1


def test_audit_lists_the_clients_it_has_seen(tmp_path):
    log = AuditLog(tmp_path, redactor=Redactor())
    log.write("mcp.tool_call", tool="serial_read", agent="agent-b", ok=True)
    log.write("mcp.tool_call", tool="serial_read", agent="agent-a", ok=True)
    log.write("lease.acquire", owner="agent-a", ttl_ms=1000)
    log.write("session.open", session="board")
    assert log.clients() == ["agent-a", "agent-b"]


def test_transcript_records_and_filters_the_writing_client(tmp_path):
    writer = TranscriptWriter(tmp_path, "board-a", redactor=Redactor())
    writer.data("rx", 0, b"boot", "device")
    writer.data("tx", 4, b"ping\r", "agent", owner="agent-a")
    writer.data("tx", 10, b"ls\r", "agent", owner="agent-b")
    writer.close()

    everything = writer.tail(50)
    assert len(everything) == 3
    assert everything[1]["owner"] == "agent-a"
    assert "owner" not in everything[0]  # device RX has no client

    mine = writer.tail(50, client="agent-a")
    assert [r["data_b64"] for r in mine] == [everything[1]["data_b64"]]
    assert writer.tail(50, client="nobody") == []


# ---------------------------------------------------------------------- API
def _app(tmp_path):
    cfg, _ = init_config(tmp_path / "data")
    cfg.security.allow_dev_ports = True
    cfg.sessions = [
        SessionConfig(id="board-a", port="sim://board-a", auto_open=True, control="agent")
    ]
    return cfg, create_app(cfg)


def test_api_exposes_the_client_list_and_filter(tmp_path):
    cfg, app = _app(tmp_path)
    with TestClient(app, base_url="http://127.0.0.1:8765") as client:
        manager = app.state.manager
        manager.audit.write("mcp.tool_call", tool="serial_write", agent="agent-a", ok=True)
        manager.audit.write("mcp.tool_call", tool="serial_read", agent="agent-b", ok=True)
        manager.audit.write("lease.acquire", owner="agent-a", ttl_ms=1000)

        assert client.get("/api/audit/clients").json()["clients"] == ["agent-a", "agent-b"]

        filtered = client.get("/api/audit?client=agent-a").json()["events"]
        assert [e["event"] for e in filtered] == ["mcp.tool_call", "lease.acquire"]

        # unfiltered includes the session lifecycle events, which have no client
        everything = client.get("/api/audit").json()["events"]
        assert len(everything) > len(filtered)
        assert any("agent" not in e and "owner" not in e for e in everything)
    app.state.manager.stop()


def test_api_transcript_filter(tmp_path):
    cfg, app = _app(tmp_path)
    with TestClient(app, base_url="http://127.0.0.1:8765") as client:
        sess = app.state.manager.get("board-a")
        sess.transcript.data("tx", 0, b"from-a\r", "agent", owner="agent-a")
        sess.transcript.data("tx", 8, b"from-b\r", "agent", owner="agent-b")

        mine = client.get("/api/sessions/board-a/transcript?client=agent-a").json()["events"]
        assert len(mine) == 1
        assert mine[0]["owner"] == "agent-a"

        everything = client.get("/api/sessions/board-a/transcript").json()["events"]
        assert len(everything) >= 2
    app.state.manager.stop()
