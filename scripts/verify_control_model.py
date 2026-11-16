"""End-to-end check of the agent-first control model against a live server.

Proves, on one real serial port:

1. one configured session is bound automatically, so ``tools/list`` is not empty;
2. the agent writes without any hand-off;
3. the operator's HTTP/console write paths answer ``READ_ONLY``;
4. the operator still sees the agent's command in the MCP audit and the raw
   bytes in the transcript export.

Usage::

    python scripts/verify_control_model.py --port COM5 --baud 115200
    python scripts/verify_control_model.py --port sim://board-a   # no hardware
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from tio_server.config import SessionConfig, init_config  # noqa: E402

PASS, FAIL = "PASS", "FAIL"
results: list[tuple[str, str, str]] = []


def check(name: str, ok: bool, detail: str = "") -> bool:
    results.append((PASS if ok else FAIL, name, detail))
    print(f"  [{PASS if ok else FAIL}] {name}" + (f"  — {detail}" if detail else ""), flush=True)
    return ok


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class Mcp:
    """Minimal Streamable-HTTP MCP client: initialize, tools/list, tools/call."""

    def __init__(self, base: str, token: str) -> None:
        self.url = base + "/mcp"
        self.token = token
        self.session: str | None = None
        self.next_id = 1

    def _headers(self) -> dict[str, str]:
        headers = {
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        if self.session:
            headers["Mcp-Session-Id"] = self.session
        return headers

    @staticmethod
    def _parse(text: str) -> dict:
        for line in text.splitlines():
            if line.startswith("data: "):
                return json.loads(line[6:])
        return json.loads(text) if text.strip() else {}

    def post(self, payload: dict) -> dict:
        response = httpx.post(self.url, headers=self._headers(), content=json.dumps(payload), timeout=30)
        session = response.headers.get("Mcp-Session-Id")
        if session:
            self.session = session
        response.raise_for_status()
        return self._parse(response.text)

    def initialize(self) -> dict:
        return self.post(
            {
                "jsonrpc": "2.0",
                "id": self.next_id,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2026-07-28",
                    "capabilities": {},
                    "clientInfo": {"name": "verify-control-model", "version": "1"},
                },
            }
        )

    def initialized(self) -> None:
        httpx.post(
            self.url,
            headers=self._headers(),
            content=json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}),
            timeout=30,
        )

    def list_tools(self) -> list[dict]:
        self.next_id += 1
        return self.post({"jsonrpc": "2.0", "id": self.next_id, "method": "tools/list"}).get("result", {}).get("tools", [])

    def call(self, name: str, arguments: dict) -> dict:
        self.next_id += 1
        body = self.post(
            {
                "jsonrpc": "2.0",
                "id": self.next_id,
                "method": "tools/call",
                "params": {"name": name, "arguments": arguments},
            }
        )
        return body.get("result", {})


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", default="sim://board-a", help="serial port or sim://<name>")
    parser.add_argument("--baud", type=int, default=115200)
    parser.add_argument("--keep", action="store_true", help="leave the server running")
    args = parser.parse_args()

    work = Path(tempfile.mkdtemp(prefix="verify-control-"))
    cfg, _ = init_config(work / "data")
    cfg.security.allow_dev_ports = True
    cfg.sessions = [
        SessionConfig(
            id="board",
            name=f"verify {args.port}",
            port=args.port,
            baudrate=args.baud,
            auto_open=True,
            auto_reconnect=True,
            # control omitted on purpose: exercise the production default
        )
    ]
    port = free_port()
    cfg.server.port = port
    cfg.save()
    token = cfg.api_token_file.read_text(encoding="utf-8").strip()
    base = f"http://127.0.0.1:{port}"

    log = (work / "server.log").open("wb")
    env = dict(os.environ, PYTHONIOENCODING="utf-8")
    proc = subprocess.Popen(
        [sys.executable, "-m", "tio_server", "run", "--config", str(cfg.path), "--port", str(port)],
        cwd=str(ROOT),
        stdout=log,
        stderr=log,
        env=env,
    )

    try:
        deadline = time.time() + 30
        while time.time() < deadline:
            if proc.poll() is not None:
                print((work / "server.log").read_text(encoding="utf-8", errors="replace")[-3000:])
                return 1
            try:
                if httpx.get(base + "/healthz", timeout=0.5).status_code == 200:
                    break
            except httpx.HTTPError:
                time.sleep(0.2)
        else:
            print("server did not become healthy")
            return 1

        client = httpx.Client(base_url=base, timeout=30)
        print(f"\n== target: {args.port} @ {args.baud} ==", flush=True)

        # 1. auto-bind + tool surface
        bindings = client.get("/api/mcp/bindings").json()
        check("single session auto-bound", bindings["serial_session_id"] == "board", str(bindings))
        health = client.get(f"/api/sessions/board").json()
        check("session open", health["state"] == "open", health["state"])
        check("control mode is agent", health["control"] == "agent", health["control"])
        check("operator is observe-only", health["human_writable"] is False, str(health["human_writable"]))

        mcp = Mcp(base, token)
        mcp.initialize()
        mcp.initialized()
        tools = [tool["name"] for tool in mcp.list_tools()]
        check(
            "tools/list is not empty",
            len(tools) >= 8 and "serial_write" in tools and "serial_status" in tools,
            f"{len(tools)} tools: {tools}",
        )
        check("serial tools published", "serial_write" in tools and "serial_status" in tools, ",".join(tools))

        # 2. the agent writes with no hand-off and no WRITE_LOCKED
        status = mcp.call("serial_status", {})
        payload = status.get("structuredContent") or {}
        check("agent status ok", status.get("isError") is False, str(status.get("isError")))
        check("status reports agent owner", payload.get("control_owner") == "agent", str(payload.get("control_owner")))

        marker = f"mcp-probe-{int(time.time())}"
        written = mcp.call("serial_write", {"data": marker + "\n", "newline": "none"})
        check("agent write accepted", written.get("isError") is False, json.dumps(written.get("structuredContent"))[:160])
        tx = (written.get("structuredContent") or {}).get("bytes_written")
        check("agent wrote bytes", bool(tx), f"{tx} bytes")

        time.sleep(0.4)
        tail = mcp.call("serial_tail", {"lines": 20})
        text = (tail.get("structuredContent") or {}).get("text", "")
        check("agent can read the console back", tail.get("isError") is False, f"{len(text)} chars")

        # 3. the operator may not write
        for path, body in (
            ("/api/sessions/board/write", {"text": "x"}),
            ("/api/sessions/board/command", {"command": "ping"}),
            ("/api/sessions/board/break", {"duration_ms": 50}),
        ):
            response = client.post(path, json=body)
            code = response.json().get("error", {}).get("code") if response.content else None
            check(f"operator {path.rsplit('/', 1)[-1]} refused", response.status_code == 403 and code == "READ_ONLY", f"{response.status_code} {code}")

        control = client.put("/api/sessions/board/control", json={"owner": "human"})
        check(
            "control hand-over refused",
            control.status_code == 403 and control.json()["error"]["code"] == "READ_ONLY",
            f"{control.status_code}",
        )

        # 4. the operator still sees everything
        audit = client.get("/api/mcp/audit?limit=20").json()["events"]
        writes = [event for event in audit if event["tool"] == "serial_write"]
        check("MCP audit recorded the write", bool(writes), f"{len(audit)} events")
        if writes:
            check("audit shows the agent's command", marker in writes[0]["input"], writes[0]["input"][:120])
            check("audit names the tool and client", writes[0]["agent"] != "", writes[0]["agent"])

        exported = client.get("/api/sessions/board/export?format=txt").text
        check("transcript export contains the TX bytes", marker in exported or "\tTX\t" in exported, f"{len(exported)} chars")

        transcript = client.get("/api/sessions/board/transcript").json()["events"]
        check("transcript has records", len(transcript) > 0, f"{len(transcript)} events")

        persisting = client.get("/api/audit?limit=50").json()["events"]
        check("persistent audit log reachable", isinstance(persisting, list), f"{len(persisting)} events")

        client.close()
    finally:
        if args.keep:
            print(f"\nserver kept running: {base} (pid {proc.pid}), data {work}")
        else:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
            log.close()

    failed = [name for status, name, _ in results if status == FAIL]
    print(f"\n== {len(results) - len(failed)}/{len(results)} checks passed ==", flush=True)
    if failed:
        print("failed: " + ", ".join(failed))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
