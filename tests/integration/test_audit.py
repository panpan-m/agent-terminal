"""The durable half of the audit trail: tool calls must survive a restart.

The in-memory view the UI pages through is capped at 500 entries and dies with
the process, which is not an audit trail.  These tests pin the record to disk.
"""

from __future__ import annotations

import asyncio
import json

from fastapi.testclient import TestClient

from tio_server.config import SessionConfig, init_config
from tio_server.web.app import create_app


def _app(tmp_path, sessions=None):
    cfg, _ = init_config(tmp_path / "data")
    cfg.security.allow_dev_ports = True
    cfg.sessions = sessions or [SessionConfig(id="board", port="sim://board-a", auto_open=True)]
    return cfg, create_app(cfg)


def _call(app, name: str, arguments: dict | None = None):
    return asyncio.run(app.state.mcp_server.call_tool(name, arguments or {}))


def test_tool_call_is_appended_to_the_audit_file(tmp_path):
    cfg, app = _app(tmp_path)
    with TestClient(app, base_url="http://127.0.0.1:8765") as client:
        result = _call(app, "serial_status")
        assert result.is_error is False

        audit_file = cfg.log_dir / "audit" / "audit.log"
        assert audit_file.exists(), "no durable audit file was written"
        records = [json.loads(line) for line in audit_file.read_text(encoding="utf-8").splitlines() if line.strip()]
        calls = [record for record in records if record.get("event") == "mcp.tool_call"]
        assert calls, records
        assert calls[-1]["tool"] == "serial_status"
        assert calls[-1]["ok"] is True
        assert "ts" in calls[-1]

        # And the same record is served to the web UI from the durable file.
        served = client.get("/api/audit?limit=100").json()["events"]
        assert any(event.get("event") == "mcp.tool_call" for event in served)
    app.state.manager.stop()


def test_durable_record_keeps_the_agent_and_the_arguments(tmp_path):
    cfg, app = _app(tmp_path)
    with TestClient(app, base_url="http://127.0.0.1:8765"):
        _call(app, "serial_write", {"data": "hello-visible-in-audit", "newline": "lf"})
        audit_file = cfg.log_dir / "audit" / "audit.log"
        records = [json.loads(line) for line in audit_file.read_text(encoding="utf-8").splitlines() if line.strip()]
        writes = [record for record in records if record.get("tool") == "serial_write"]
        assert writes, records
        record = writes[-1]
        assert record["agent"]  # client identity is never dropped
        assert "hello-visible-in-audit" in record["input"]
        assert record["session"] == "board" or record["session"] is None
    app.state.manager.stop()


def test_failed_tool_call_is_also_persisted(tmp_path):
    cfg, app = _app(tmp_path)
    with TestClient(app, base_url="http://127.0.0.1:8765"):
        result = _call(app, "serial_read", {"format": "nope"})
        assert result.is_error is True
        records = [
            json.loads(line)
            for line in (cfg.log_dir / "audit" / "audit.log").read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        failed = [record for record in records if record.get("tool") == "serial_read" and record.get("ok") is False]
        assert failed, records
    app.state.manager.stop()


def test_in_memory_view_still_works_without_a_durable_log():
    from tio_server.mcp.audit import McpAuditLog

    log = McpAuditLog()
    log.record(
        tool="serial_status",
        agent="probe",
        agent_version="1",
        session="board",
        ok=True,
        duration_ms=3,
        arguments={},
        result=None,
    )
    assert log.recent(10)[0]["tool"] == "serial_status"
