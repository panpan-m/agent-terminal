"""Live hardware debug run against a real port on a running tio-server.

The attached board is a Raspberry Pi serial console (getty).  The run never
types a username or password: writes are bare Enter presses, and the tests match
the real ``login:`` prompt.  It exercises:

  open/close, status, control lines, writes (text/hex/chunked), cursor reads,
  command + expect against real prompt output, permission and control-owner
  arbitration, all six MCP tools through the packaged stdio shim, ttyd entries
  (HTTP + raw WebSocket), config reopen, transcript/audit, and finally the
  DTR/RTS reset sequence.

    python scripts/live_debug.py --session board [--password ...]
"""

from __future__ import annotations

import argparse
import base64
import json
import re
import subprocess
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
ANSI = re.compile(rb"\x1b\[[0-9;?]*[A-Za-z]")


class Runner:
    def __init__(self, base: str, username: str, password: str, session_id: str, out: Path) -> None:
        self.base = base.rstrip("/")
        self.session_id = session_id
        self.out = out
        self.checks: list[dict] = []
        self.notes: list[str] = []
        self.client = httpx.Client(base_url=self.base, timeout=40)
        login = self.client.post("/api/auth/login", json={"username": username, "password": password})
        login.raise_for_status()
        self.csrf = login.json()["csrf"]
        self.headers = {"X-CSRF-Token": self.csrf}
        self.mcp: subprocess.Popen | None = None
        self.mcp_id = 0

    # ------------------------------------------------------------------ helpers
    def check(self, name: str, ok: bool, detail="") -> bool:
        self.checks.append({"name": name, "ok": bool(ok), "detail": str(detail)[:600]})
        print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  — {str(detail)[:180]}" if detail else ""))
        return bool(ok)

    def note(self, text: str) -> None:
        self.notes.append(text)
        print(f"INFO  {text}")

    def status(self) -> dict:
        return self.client.get(f"/api/sessions/{self.session_id}").json()

    def post(self, path: str, **kwargs):
        return self.client.post(path, headers=self.headers, **kwargs)

    def put(self, path: str, **kwargs):
        return self.client.put(path, headers=self.headers, **kwargs)

    def transcript(self, limit: int = 400) -> list[dict]:
        return self.client.get(f"/api/sessions/{self.session_id}/transcript?limit={limit}").json()["events"]

    def rx_text(self) -> str:
        events = [e for e in self.transcript(1000) if e.get("dir") == "rx"]
        raw = b"".join(base64.b64decode(e["data_b64"]) for e in events)
        return ANSI.sub(b"", raw).decode("utf-8", "replace")

    # --------------------------------------------------------------------- MCP
    def mcp_start(self) -> None:
        self.mcp = subprocess.Popen(
            [
                str(ROOT / "dist" / "tio-mcp.exe"),
                "--url",
                f"{self.base}/mcp",
                "--token-file",
                str(ROOT / "run" / "api-token"),
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        init = self.mcp_call(
            "initialize",
            {
                "protocolVersion": "2026-07-28",
                "capabilities": {},
                "clientInfo": {"name": "live-debug", "version": "0"},
            },
        )
        self.mcp_notify("notifications/initialized")
        self.check(
            "MCP initialize through packaged tio-mcp.exe",
            init.get("result", {}).get("serverInfo", {}).get("name") == "tio-server",
            json.dumps(init)[:160],
        )

    def mcp_send(self, message: dict) -> None:
        assert self.mcp and self.mcp.stdin
        self.mcp.stdin.write(json.dumps(message) + "\n")
        self.mcp.stdin.flush()

    def mcp_recv(self) -> dict:
        assert self.mcp and self.mcp.stdout
        line = self.mcp.stdout.readline()
        if not line:
            raise RuntimeError("tio-mcp closed unexpectedly")
        return json.loads(line)

    def mcp_notify(self, method: str) -> None:
        self.mcp_send({"jsonrpc": "2.0", "method": method})

    def mcp_call(self, method: str, params: dict | None = None) -> dict:
        self.mcp_id += 1
        message = {"jsonrpc": "2.0", "id": self.mcp_id, "method": method}
        if params is not None:
            message["params"] = params
        self.mcp_send(message)
        return self.mcp_recv()

    def tool(self, name: str, arguments: dict) -> dict:
        return self.mcp_call("tools/call", {"name": name, "arguments": arguments}).get("result", {})

    # -------------------------------------------------------------------- run
    def run(self) -> None:
        sid = self.session_id
        status = self.status()
        if status["state"] != "open":
            status = self.post(f"/api/sessions/{sid}/open").json()
        self.check("real session is open", status["state"] == "open", status["state"])
        self.check(
            "real port reported",
            status["port"].upper().startswith("COM") or status["port"].startswith("/dev/"),
            status["port"],
        )
        self.check(
            "serial parameters applied",
            status["config"]["baudrate"] > 0 and status["config"]["bytesize"] == 8,
            json.dumps(status["config"]),
        )
        ports = self.client.get("/api/ports").json()["ports"]
        device = next((p for p in ports if p["port"] == status["port"]), None)
        self.check(
            "device enumerated with USB metadata",
            device is not None and bool(device.get("vid")),
            json.dumps(device, ensure_ascii=False)[:260] if device else "missing",
        )

        # --- real device output --------------------------------------------
        history = self.rx_text()
        self.note(f"device output so far ({len(history)} chars): {history[-160:]!r}")
        is_login = "login:" in history
        self.check(
            "board is a live Linux serial console",
            is_login,
            "login: prompt found" if is_login else "no prompt yet",
        )

        # --- control lines -------------------------------------------------
        lines = status.get("lines") or {}
        self.check("control lines readable", len(lines) == 6, json.dumps(lines))
        asserted = self.post(f"/api/sessions/{sid}/lines", json={"dtr": True, "rts": True})
        self.check(
            "DTR/RTS can be asserted",
            asserted.status_code == 200 and asserted.json().get("dtr") is True,
            asserted.text[:160],
        )
        released = self.post(f"/api/sessions/{sid}/lines", json={"dtr": False, "rts": False})
        self.check(
            "DTR/RTS can be released",
            released.status_code == 200 and released.json().get("dtr") is False,
            released.text[:160],
        )
        self.note(
            "this Debug Probe stops draining TX while DTR is low; re-asserting DTR "
            "is required before writing again"
        )
        reasserted = self.post(f"/api/sessions/{sid}/lines", json={"dtr": True, "rts": False})
        self.check(
            "DTR can be re-asserted",
            reasserted.status_code == 200 and reasserted.json().get("dtr") is True,
            reasserted.text[:160],
        )
        ping_write = self.post(f"/api/sessions/{sid}/write", json={"text": "", "newline": "cr"})
        self.check(
            "write works with DTR asserted",
            ping_write.status_code == 200 and ping_write.json()["bytes_written"] == 1,
            ping_write.text[:160],
        )

        # --- writes (bare Enter only: never type a username) ---------------
        tx0 = self.status()["tx_bytes"]
        write = self.post(f"/api/sessions/{sid}/write", json={"text": "", "newline": "cr"})
        self.check("text write (Enter)", write.status_code == 200 and write.json()["bytes_written"] == 1, write.text[:160])
        hexwrite = self.post(f"/api/sessions/{sid}/write", json={"hex": "0d"})
        self.check("hex write (CR)", hexwrite.status_code == 200 and hexwrite.json()["bytes_written"] == 1, hexwrite.text[:160])
        chunked = self.post(f"/api/sessions/{sid}/write", json={"text": "\r\r", "chunk_size": 1, "delay_ms": 30})
        self.check("chunked write", chunked.status_code == 200 and chunked.json()["bytes_written"] == 2, chunked.text[:160])
        tx1 = self.status()["tx_bytes"]
        self.check("TX counters advance by 4", tx1 - tx0 == 4, f"{tx0} -> {tx1}")

        # --- reads ---------------------------------------------------------
        events = self.transcript(20)
        self.check("transcript records TX", any(e.get("dir") == "tx" for e in events), f"{len(events)} events")
        now = self.status()
        self.check(
            "absolute cursors exposed",
            now["rx_head"] >= now["rx_start"] >= 0,
            f"start={now['rx_start']} head={now['rx_head']}",
        )

        # --- command + expect against the real prompt ----------------------
        command = self.post(
            f"/api/sessions/{sid}/command",
            json={"command": "", "expect": "login:", "timeout_ms": 3000},
        ).json()
        self.check(
            "command with expect matches the real login prompt",
            command.get("matched") is True and command.get("match") == "login:" and command.get("tx_bytes") == 1,
            f"matched={command.get('matched')} elapsed={command.get('elapsed_ms')}ms",
        )

        # --- MCP full surface ----------------------------------------------
        self.mcp_start()
        tools = self.mcp_call("tools/list").get("result", {}).get("tools", [])
        names = [tool["name"] for tool in tools]
        self.check("MCP exposes six tools", len(names) == 6, ",".join(names))

        sessions = self.tool("serial_sessions", {}).get("structuredContent", {}).get("sessions", [])
        self.check(
            "MCP serial_sessions sees the real port",
            any(s["session_id"] == sid and s["port"] == now["port"] for s in sessions),
            json.dumps(sessions)[:240],
        )
        mcp_status = self.tool("serial_status", {"session_id": sid}).get("structuredContent", {})
        self.check(
            "MCP serial_status matches the real session",
            mcp_status.get("port") == now["port"] and mcp_status.get("state") == "open",
            f"{mcp_status.get('port')} {mcp_status.get('state')}",
        )
        before = mcp_status.get("rx_head", 0)
        read = self.tool("serial_read", {"session_id": sid, "cursor": before, "timeout_ms": 250, "format": "hex"}).get(
            "structuredContent", {}
        )
        self.check(
            "MCP serial_read cursor semantics",
            read.get("gap") is False and read.get("head_cursor", 0) >= before,
            f"next={read.get('next_cursor')} head={read.get('head_cursor')}",
        )
        tail_read = self.tool("serial_read", {"session_id": sid, "tail_bytes": 64}).get("structuredContent", {})
        self.check(
            "MCP serial_read returns the real console text",
            "login:" in (tail_read.get("text") or ""),
            repr((tail_read.get("text") or "")[-80:]),
        )
        matched = self.tool(
            "serial_expect", {"session_id": sid, "pattern": "login:", "cursor": 0, "timeout_ms": 1000}
        ).get("structuredContent", {})
        self.check(
            "MCP serial_expect matches history",
            matched.get("matched") is True,
            f"next={matched.get('next_cursor')}",
        )

        locked = self.tool("serial_write", {"session_id": sid, "data": "\r"})
        code = locked.get("structuredContent", {}).get("error", {}).get("code")
        self.check("MCP write refused while human owns control", locked.get("isError") is True and code == "WRITE_LOCKED", code)

        self.put(f"/api/sessions/{sid}/control", json={"owner": "agent"})
        human_locked = self.post(f"/api/sessions/{sid}/write", json={"text": "", "newline": "cr"})
        self.check(
            "human write refuses while the agent owns control",
            human_locked.status_code == 409 and human_locked.json().get("error", {}).get("code") == "WRITE_LOCKED",
            human_locked.text[:160],
        )
        agent_write = self.tool("serial_write", {"session_id": sid, "data": "\r"})
        self.check(
            "MCP write allowed after handing control to the agent",
            agent_write.get("isError") is False and agent_write.get("structuredContent", {}).get("bytes_written") == 1,
            json.dumps(agent_write.get("structuredContent", {}))[:200],
        )
        agent_command = self.tool(
            "serial_command", {"session_id": sid, "command": "", "expect": "login:", "timeout_ms": 3000}
        ).get("structuredContent", {})
        self.check(
            "MCP serial_command matches the real prompt",
            agent_command.get("matched") is True and agent_command.get("tx_bytes") == 1,
            f"matched={agent_command.get('matched')} elapsed={agent_command.get('elapsed_ms')}ms",
        )

        self.put(f"/api/sessions/{sid}/permissions", json={"permissions": ["read"]})
        disabled = self.tool("serial_write", {"session_id": sid, "data": "\r"})
        code = disabled.get("structuredContent", {}).get("error", {}).get("code")
        self.check("MCP WRITE_DISABLED enforced", code == "WRITE_DISABLED", code)
        read_allowed = self.tool("serial_read", {"session_id": sid, "tail_bytes": 8})
        self.check("MCP read still allowed", read_allowed.get("isError") is False, "")
        self.put(f"/api/sessions/{sid}/permissions", json={"permissions": ["read", "write", "command"]})
        self.put(f"/api/sessions/{sid}/control", json={"owner": "human"})
        human = self.post(f"/api/sessions/{sid}/write", json={"text": "", "newline": "cr"})
        self.check("human write restored after taking control back", human.status_code == 200, human.text[:120])

        # --- close / reopen -------------------------------------------------
        closed = self.post(f"/api/sessions/{sid}/close")
        self.check("session closes", closed.status_code == 200 and closed.json()["state"] == "closed", closed.json().get("state"))
        reopened = self.post(f"/api/sessions/{sid}/open")
        self.check("session reopens", reopened.status_code == 200 and reopened.json()["state"] == "open", reopened.json().get("state"))

        # --- ttyd ----------------------------------------------------------
        terminal = self.status().get("terminal") or {}
        self.check("ttyd entries exist for the real session", bool(terminal.get("view_url")), json.dumps(terminal))
        if terminal.get("view_url"):
            view = httpx.get(terminal["view_url"], timeout=5)
            self.check("ttyd view entry reachable", view.status_code == 200, str(view.status_code))
        if terminal.get("control_url"):
            control = httpx.get(terminal["control_url"], timeout=5)
            self.check("ttyd control entry requires auth", control.status_code == 401, str(control.status_code))
            try:
                password = (ROOT / "run" / "ttyd-control.pass").read_text(encoding="utf-8").strip()
            except OSError:
                password = ""
            auth = base64.b64encode(f"operator:{password}".encode()).decode()
            authed = httpx.get(terminal["control_url"], headers={"Authorization": f"Basic {auth}"}, timeout=5)
            self.check("ttyd control entry accepts operator", authed.status_code == 200, str(authed.status_code))
            self._ttyd_raw(terminal["control_url"], auth)

        # --- config reopen --------------------------------------------------
        original = dict(self.status()["config"])
        body = {
            "name": self.status()["name"],
            "port": self.status()["port"],
            "baudrate": 9600 if original["baudrate"] != 9600 else 115200,
            "bytesize": original["bytesize"],
            "parity": original["parity"],
            "stopbits": original["stopbits"],
            "flow": original["flow"],
            "open_mode": original["open_mode"],
            "auto_open": True,
            "auto_reconnect": True,
        }
        changed = self.put(f"/api/sessions/{sid}", json=body)
        self.check(
            "config change reopens the session",
            changed.status_code == 200
            and changed.json()["state"] == "open"
            and changed.json()["config"]["baudrate"] != original["baudrate"],
            json.dumps(changed.json().get("config", {}))[:200],
        )
        restored = self.put(f"/api/sessions/{sid}", json=dict(body, baudrate=original["baudrate"]))
        self.check(
            "baud rate restored",
            restored.status_code == 200 and restored.json()["config"]["baudrate"] == original["baudrate"],
            str(restored.json().get("config")),
        )

        # --- audit / transcript --------------------------------------------
        tx = [e for e in self.transcript(400) if e.get("dir") == "tx"]
        self.check("transcript captured every TX", len(tx) >= 6, f"{len(tx)} tx records")
        audit = self.client.get("/api/audit?limit=400").json()["events"]
        names = {e.get("event") for e in audit}
        self.check(
            "audit covers open/control/ttyd/lines",
            {"session.open", "session.control_owner", "session.lines", "ttyd.start"} <= names,
            ",".join(sorted(n for n in names if n)),
        )

        # --- reset sequence last (DTR/RTS may disturb the CDC briefly) ------
        reset = self.post(f"/api/sessions/{sid}/reset")
        self.check(
            "DTR/RTS reset sequence applied",
            reset.status_code == 200 and reset.json().get("steps", 0) >= 1,
            reset.text[:160],
        )
        restored = (reset.json().get("restored") or {}) if reset.status_code == 200 else {}
        self.check(
            "line state restored after reset",
            restored.get("dtr") is True,
            json.dumps(restored),
        )
        after_reset_write = self.post(f"/api/sessions/{sid}/write", json={"text": "", "newline": "cr"})
        self.check(
            "writes still work after reset",
            after_reset_write.status_code == 200 and after_reset_write.json()["bytes_written"] == 1,
            after_reset_write.text[:160],
        )
        deadline = time.time() + 8
        final = self.status()
        while time.time() < deadline and final["state"] != "open":
            time.sleep(0.4)
            final = self.status()
        self.check(
            "session healthy after reset (open, human control)",
            final["state"] == "open" and final["control_owner"] == "human",
            f"{final['state']}/{final['control_owner']} reconnects={final['reconnect_count']}",
        )
        self.note(
            f"final counters: rx={final['rx_bytes']}B tx={final['tx_bytes']}B "
            f"reconnects={final['reconnect_count']} last_rx={final['last_rx_at']}"
        )
        self.note(f"final console tail: {self.rx_text()[-160:]!r}")

    def _ttyd_raw(self, url: str, auth: str) -> None:
        from websockets.sync.client import connect

        port = url.rstrip("/").rsplit(":", 1)[1]
        token_response = httpx.get(
            f"http://127.0.0.1:{port}/token", headers={"Authorization": f"Basic {auth}"}, timeout=5
        )
        token = token_response.json().get("token", "") if token_response.status_code == 200 else ""
        received = b""
        try:
            with connect(
                f"ws://127.0.0.1:{port}/ws",
                subprotocols=["tty"],
                origin=f"http://127.0.0.1:{port}",
                additional_headers={"Authorization": f"Basic {auth}"},
                open_timeout=8,
                max_size=None,
            ) as ws:
                ws.send(json.dumps({"AuthToken": token, "columns": 100, "rows": 30}).encode())
                time.sleep(0.6)
                ws.send(b"0" + b"\r")
                deadline = time.time() + 3
                while time.time() < deadline:
                    try:
                        message = ws.recv(timeout=0.4)
                    except TimeoutError:
                        continue
                    except Exception:
                        break
                    if isinstance(message, str):
                        message = message.encode()
                    if message[:1] == b"0":
                        received += message[1:]
        except Exception as exc:  # noqa: BLE001 - report, keep going
            self.check("ttyd raw websocket accepts keystrokes", False, str(exc)[:200])
            return
        self.check(
            "ttyd raw websocket accepts keystrokes",
            b"login:" in ANSI.sub(b"", received) or len(received) > 0,
            f"terminal output {len(received)}B: {received[-100:]!r}",
        )

    def close(self) -> None:
        if self.mcp:
            self.mcp.terminate()
            try:
                self.mcp.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.mcp.kill()
        self.client.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:8765")
    parser.add_argument("--session", default="board")
    parser.add_argument("--user", default="admin")
    parser.add_argument("--password")
    parser.add_argument("--out", default=str(ROOT / "artifacts" / "live"))
    args = parser.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    password = args.password
    if not password:
        try:
            creds = json.loads((ROOT / "run" / "first-run-credentials.json").read_text(encoding="utf-8"))
            password = creds["admin_password"]
        except (OSError, KeyError, json.JSONDecodeError):
            parser.error("no --password and no run/first-run-credentials.json")

    runner = Runner(args.base, args.user, password, args.session, out)
    try:
        runner.run()
    finally:
        runner.close()

    failed = [c for c in runner.checks if not c["ok"]]
    report = {
        "base": args.base,
        "session": args.session,
        "checks": runner.checks,
        "notes": runner.notes,
        "passed": len(runner.checks) - len(failed),
        "failed": len(failed),
    }
    (out / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\n{report['passed']}/{len(runner.checks)} live checks passed — {out / 'report.json'}")
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
