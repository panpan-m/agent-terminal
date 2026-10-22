"""End-to-end verification driver.

Starts a real tio-server process against a simulated board, exercises the admin
API, the MCP endpoint (raw Streamable HTTP), reconnection and transcripts, then
drives the built SPA in headless Chrome (scripts/ui_probe.mjs).

Writes artifacts/e2e/report.json and prints a summary.  Exit code 0 only when
every check passed.
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from tio_server.config import Config, SessionConfig, init_config  # noqa: E402

PY = sys.executable
NODE = "node"


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class Report:
    def __init__(self) -> None:
        self.checks: list[dict] = []
        self.started = datetime.now().astimezone().isoformat(timespec="seconds")

    def check(self, name: str, ok: bool, detail: str = "") -> bool:
        self.checks.append({"name": name, "ok": bool(ok), "detail": str(detail)[:800]})
        print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""))
        return ok

    @property
    def failed(self) -> list[dict]:
        return [c for c in self.checks if not c["ok"]]


def sse_messages(text: str) -> list[dict]:
    messages, data = [], []
    for line in text.splitlines():
        if line.startswith("data:"):
            data.append(line[5:].lstrip())
        elif not line.strip() and data:
            try:
                messages.append(json.loads("\n".join(data)))
            except json.JSONDecodeError:
                pass
            data = []
    if data:
        try:
            messages.append(json.loads("\n".join(data)))
        except json.JSONDecodeError:
            pass
    return messages


class McpClient:
    def __init__(self, base: str, token: str) -> None:
        self.base = base.rstrip("/") + "/mcp"
        self.client = httpx.Client(timeout=60, follow_redirects=True)
        self.headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        self.session_id: str | None = None
        self.next_id = 1

    def rpc(self, method: str, params: dict | None = None, notify: bool = False) -> dict:
        payload: dict = {"jsonrpc": "2.0", "method": method}
        if not notify:
            payload["id"] = self.next_id
            self.next_id += 1
        if params is not None:
            payload["params"] = params
        response = self.client.post(self.base, json=payload, headers=self.headers)
        self.session_id = response.headers.get("mcp-session-id", self.session_id)
        if self.session_id:
            self.headers["Mcp-Session-Id"] = self.session_id
        if response.status_code >= 400:
            return {"http_status": response.status_code, "text": response.text[:400]}
        messages = sse_messages(response.text)
        if not messages and response.text.strip():
            try:
                parsed = response.json()
                messages = parsed if isinstance(parsed, list) else [parsed]
            except json.JSONDecodeError:
                messages = []
        if notify:
            return {"ok": response.status_code in (200, 202, 204)}
        return messages[0] if messages else {"error": {"message": "empty response"}}

    def initialize(self) -> dict:
        return self.rpc(
            "initialize",
            {
                "protocolVersion": "2026-07-28",
                "capabilities": {},
                "clientInfo": {"name": "verify-e2e", "version": "0"},
            },
        )

    def call(self, name: str, arguments: dict) -> dict:
        return self.rpc("tools/call", {"name": name, "arguments": arguments})

    def close(self) -> None:
        try:
            self.client.delete(self.base, headers=self.headers)
        except httpx.HTTPError:
            pass
        self.client.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=str(ROOT / "artifacts" / "e2e"))
    parser.add_argument("--skip-ui", action="store_true")
    parser.add_argument("--keep", action="store_true", help="keep the server running")
    args = parser.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    report = Report()

    data_dir = out / "data"
    if data_dir.exists():
        import shutil

        shutil.rmtree(data_dir)
    cfg, secrets = init_config(data_dir)
    cfg.security.allow_dev_ports = True
    cfg.security.rate_limit_per_second = 200
    cfg.sessions = [
        SessionConfig(
            id="board-a",
            name="Board A",
            port="sim://board-a",
            baudrate=115200,
            auto_open=True,
            agent_permissions=["read", "write", "command"],
        )
    ]
    cfg.server.port = free_port()
    cfg.save()
    base = f"http://127.0.0.1:{cfg.server.port}"

    server_log = (out / "server.log").open("wb")
    server = subprocess.Popen(
        [PY, "-m", "tio_server", "run", "--config", str(cfg.path)],
        cwd=str(ROOT),
        stdout=server_log,
        stderr=server_log,
    )

    try:
        deadline = time.time() + 30
        healthy = False
        while time.time() < deadline:
            if server.poll() is not None:
                break
            try:
                if httpx.get(base + "/healthz", timeout=0.5).status_code == 200:
                    healthy = True
                    break
            except httpx.HTTPError:
                time.sleep(0.2)
        report.check("server starts and answers /healthz", healthy)
        if not healthy:
            server_log.close()
            print((out / "server.log").read_text(errors="replace")[-4000:])
            return 2

        client = httpx.Client(base_url=base, timeout=30)
        login = client.post(
            "/api/auth/login", json={"username": "admin", "password": secrets["admin_password"]}
        )
        report.check("admin login", login.status_code == 200)
        csrf = login.json()["csrf"]
        headers = {"X-CSRF-Token": csrf}

        status = client.get("/api/sessions").json()["sessions"]
        report.check(
            "auto_open session is open",
            len(status) == 1 and status[0]["state"] == "open",
            status[0]["state"] if status else "no session",
        )
        session_id = status[0]["session_id"]

        # --- human path through the admin API --------------------------------
        time.sleep(0.4)
        read = client.get(f"/api/sessions/{session_id}").json()
        report.check("banner captured in ring buffer", read["rx_head"] > 0, f"rx_head={read['rx_head']}")
        command = client.post(
            f"/api/sessions/{session_id}/command",
            json={"command": "help", "expect": "commands:", "timeout_ms": 4000},
            headers=headers,
        ).json()
        report.check(
            "human command + expect over simulated UART",
            command.get("matched") is True and "dump" in command.get("rx_text", ""),
            f"matched={command.get('matched')} elapsed={command.get('elapsed_ms')}ms",
        )

        # --- MCP path --------------------------------------------------------
        mcp = McpClient(base, secrets["api_token"])
        init = mcp.initialize()
        report.check(
            "MCP initialize over Streamable HTTP",
            init.get("result", {}).get("serverInfo", {}).get("name") == "tio-server",
            json.dumps(init)[:200],
        )
        mcp.rpc("notifications/initialized", notify=True)
        tools = mcp.rpc("tools/list")
        names = [tool["name"] for tool in tools.get("result", {}).get("tools", [])]
        report.check(
            "MCP tools/list exposes exactly the sixteen tools",
            names == [
                "serial_sessions",
                "serial_status",
                "serial_read",
                "serial_tail",
                "serial_write",
                "serial_break",
                "serial_command",
                "serial_expect",
                "ssh_sessions",
                "ssh_host_info",
                "ssh_status",
                "ssh_read",
                "ssh_tail",
                "ssh_write",
                "ssh_exec",
                "ssh_expect",
            ],
            ",".join(names),
        )
        tools_payload = tools.get("result", {}).get("tools", [])
        report.check(
            "every tool publishes outputSchema + annotations",
            all(tool.get("outputSchema") and tool.get("annotations") for tool in tools_payload),
        )

        sessions_call = mcp.call("serial_sessions", {})
        report.check(
            "MCP serial_sessions",
            sessions_call.get("result", {}).get("structuredContent", {}).get("sessions", [{}])[0].get("session_id")
            == session_id,
        )

        blocked = mcp.call("serial_write", {"data": "ping", "newline": "cr"})
        error = blocked.get("result", {}).get("structuredContent", {}).get("error", {})
        report.check(
            "agent write refused while human owns control",
            blocked.get("result", {}).get("isError") is True and error.get("code") == "WRITE_LOCKED",
            error.get("code", ""),
        )

        client.put(f"/api/sessions/{session_id}/control", json={"owner": "agent"}, headers=headers)
        ping = mcp.call("serial_command", {"command": "ping", "newline": "cr", "expect": "pong", "timeout_ms": 4000})
        structured = ping.get("result", {}).get("structuredContent", {})
        report.check(
            "agent command after handover matches pong",
            ping.get("result", {}).get("isError") is False and structured.get("matched") is True,
            f"match={structured.get('match')} elapsed={structured.get('elapsed_ms')}ms",
        )

        cursor = structured.get("next_cursor", 0)
        read_call = mcp.call("serial_read", {"cursor": cursor, "timeout_ms": 300})
        read_payload = read_call.get("result", {}).get("structuredContent", {})
        report.check(
            "cursor read is incremental and reports gap=false",
            read_payload.get("gap") is False and read_payload.get("head_cursor", 0) >= cursor,
            f"next={read_payload.get('next_cursor')} head={read_payload.get('head_cursor')}",
        )

        client.put(f"/api/sessions/{session_id}/permissions", json={"permissions": ["read"]}, headers=headers)
        disabled = mcp.call("serial_write", {"data": "x"})
        code = disabled.get("result", {}).get("structuredContent", {}).get("error", {}).get("code", "")
        report.check("WRITE_DISABLED when permission removed", code == "WRITE_DISABLED", code)
        client.put(
            f"/api/sessions/{session_id}/permissions",
            json={"permissions": ["read", "write", "command"]},
            headers=headers,
        )

        # --- reconnection ----------------------------------------------------
        client.put(f"/api/sessions/{session_id}/control", json={"owner": "agent"}, headers=headers)
        mcp.call("serial_command", {"command": "reboot", "newline": "cr", "settle_ms": 50, "timeout_ms": 500})
        reconnected = False
        reconnect_status: dict = {}
        deadline = time.time() + 15
        while time.time() < deadline:
            time.sleep(0.3)
            reconnect_status = client.get(f"/api/sessions/{session_id}").json()
            if reconnect_status["reconnect_count"] >= 1 and reconnect_status["state"] == "open":
                reconnected = True
                break
        report.check(
            "device unplug/replug reconnects and keeps the session",
            reconnected,
            f"state={reconnect_status.get('state')} reconnects={reconnect_status.get('reconnect_count')}",
        )
        cursor_after = reconnect_status.get("rx_head", 0)
        report.check("ring buffer survives reconnect", cursor_after > 0, f"rx_head={cursor_after}")

        # --- security --------------------------------------------------------
        unauth = httpx.post(base + "/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        report.check("MCP rejects missing bearer token", unauth.status_code == 401, str(unauth.status_code))
        bad_origin = client.post(
            f"/api/sessions/{session_id}/close", headers={"X-CSRF-Token": csrf, "Origin": "http://evil.example"}
        )
        report.check("admin API rejects foreign origin", bad_origin.status_code == 403, str(bad_origin.status_code))
        traversal = client.get("/api/sessions/../../etc/passwd")
        report.check("path traversal does not leak files", traversal.status_code in (404, 400), str(traversal.status_code))

        # --- transcripts -----------------------------------------------------
        transcript = client.get(f"/api/sessions/{session_id}/transcript?limit=500").json()["events"]
        rx_events = [event for event in transcript if event.get("dir") == "rx"]
        rx_logged = sum(int(event.get("len") or 0) for event in rx_events)
        report.check(
            "transcript contains RX bytes",
            rx_logged > 200,
            f"{len(rx_events)} rx records, {rx_logged} bytes, {len(transcript)} total",
        )
        audit = client.get("/api/audit?limit=500").json()["events"]
        audit_names = {event.get("event") for event in audit}
        report.check(
            "audit records open/control/reset events",
            {"session.open", "session.control_owner"} <= audit_names,
            ",".join(sorted(name for name in audit_names if name)),
        )

        # --- frontend --------------------------------------------------------
        index = client.get("/")
        report.check("SPA index is served", index.status_code == 200 and "<div id=\"root\">" in index.text)
        asset_path = None
        for line in index.text.splitlines():
            if "/assets/" in line and ".js" in line:
                start = line.find("/assets/")
                asset_path = line[start : line.find('"', start)]
        if asset_path:
            asset = client.get(asset_path)
            report.check("SPA bundle is served", asset.status_code == 200 and len(asset.content) > 100_000, asset_path)

        if not args.skip_ui:
            probe_out = out / "ui"
            probe = subprocess.run(
                [
                    NODE,
                    str(ROOT / "scripts" / "ui-probe.mjs"),
                    "--url",
                    base,
                    "--password",
                    secrets["admin_password"],
                    "--out",
                    str(probe_out),
                ],
                capture_output=True,
                text=True,
                timeout=240,
            )
            print(probe.stdout[-4000:])
            if probe.stderr:
                print(probe.stderr[-2000:], file=sys.stderr)
            ui_checks = []
            checks_file = probe_out / "ui-checks.json"
            if checks_file.exists():
                ui_checks = json.loads(checks_file.read_text(encoding="utf-8")).get("checks", [])
            for item in ui_checks:
                report.check(f"ui: {item['name']}", item["ok"], item.get("detail", ""))
            report.check("ui probe exited cleanly", probe.returncode == 0, f"exit={probe.returncode}")

        mcp.close()
        client.close()

    finally:
        if not args.keep:
            server.terminate()
            try:
                server.wait(timeout=15)
            except subprocess.TimeoutExpired:
                server.kill()
            server_log.close()

    summary = {
        "started": report.started,
        "finished": datetime.now().astimezone().isoformat(timespec="seconds"),
        "base_url": base,
        "checks": report.checks,
        "passed": len(report.checks) - len(report.failed),
        "failed": len(report.failed),
    }
    (out / "report.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(f"\n{summary['passed']}/{len(report.checks)} checks passed — report: {out / 'report.json'}")
    return 0 if summary["failed"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
