"""Probe: does a waiting MCP serial call block the ASGI event loop?

The MCP surface is mounted into the same FastAPI app, so a synchronous wait in a
tool handler runs on the event loop that also serves ``/api``, ``/ws`` and
``/healthz``.  This script measures a request-free baseline, then issues a
``serial_read`` that waits on the UART and times ``/healthz`` while it is in
flight.

Usage::

    python scripts/probe_event_loop_blocking.py --wait-ms 8000
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from tio_server.config import SessionConfig, init_config  # noqa: E402


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class Mcp:
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

    def post(self, payload: dict, timeout: float = 120) -> dict:
        response = httpx.post(self.url, headers=self._headers(), content=json.dumps(payload), timeout=timeout)
        if response.headers.get("Mcp-Session-Id"):
            self.session = response.headers["Mcp-Session-Id"]
        return self._parse(response.text)

    def initialize(self) -> None:
        self.post(
            {
                "jsonrpc": "2.0",
                "id": self.next_id,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2026-07-28",
                    "capabilities": {},
                    "clientInfo": {"name": "probe-loop", "version": "1"},
                },
            }
        )
        httpx.post(
            self.url,
            headers=self._headers(),
            content=json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}),
            timeout=30,
        )

    def call(self, name: str, arguments: dict) -> dict:
        self.next_id += 1
        return self.post(
            {
                "jsonrpc": "2.0",
                "id": self.next_id,
                "method": "tools/call",
                "params": {"name": name, "arguments": arguments},
            }
        ).get("result", {})


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--wait-ms", type=int, default=8000, help="how long serial_read waits")
    args = parser.parse_args()

    work = Path(tempfile.mkdtemp(prefix="probe-loop-"))
    cfg, _ = init_config(work / "data")
    cfg.security.allow_dev_ports = True
    cfg.sessions = [SessionConfig(id="board", port="sim://board-a", auto_open=True)]
    port = free_port()
    cfg.server.port = port
    cfg.save()
    token = cfg.api_token_file.read_text(encoding="utf-8").strip()
    base = f"http://127.0.0.1:{port}"

    log = (work / "server.log").open("wb")
    proc = subprocess.Popen(
        [sys.executable, "-m", "tio_server", "run", "--config", str(cfg.path), "--port", str(port)],
        cwd=str(ROOT),
        stdout=log,
        stderr=log,
        env=dict(os.environ, PYTHONIOENCODING="utf-8"),
    )
    try:
        deadline = time.time() + 30
        while time.time() < deadline:
            if proc.poll() is not None:
                print((work / "server.log").read_text(encoding="utf-8", errors="replace")[-2000:])
                return 1
            try:
                if httpx.get(base + "/healthz", timeout=0.5).status_code == 200:
                    break
            except httpx.HTTPError:
                time.sleep(0.2)
        else:
            print("server did not become healthy")
            return 1

        mcp = Mcp(base, token)
        mcp.initialize()

        # Baseline: an idle server answers immediately.
        samples = []
        for _ in range(5):
            started = time.monotonic()
            httpx.get(base + "/healthz", timeout=30)
            samples.append((time.monotonic() - started) * 1000)
        baseline = max(samples)
        print(f"baseline   /healthz latency: max {baseline:.0f} ms over 5 calls")

        status = mcp.call("serial_status", {})
        head = (status.get("structuredContent") or {}).get("rx_head", 0)
        print(f"rx_head before wait: {head}")

        result: dict = {}

        def wait_on_uart() -> None:
            started = time.monotonic()
            result["body"] = mcp.call(
                "serial_read",
                {"cursor": head, "timeout_ms": args.wait_ms, "max_bytes": 4096},
            )
            result["elapsed_ms"] = (time.monotonic() - started) * 1000

        thread = threading.Thread(target=wait_on_uart)
        thread.start()
        time.sleep(1.0)  # let the tool get into its wait

        started = time.monotonic()
        health = httpx.get(base + "/healthz", timeout=120)
        during = (time.monotonic() - started) * 1000

        started = time.monotonic()
        sessions = httpx.get(base + "/api/sessions", timeout=120)
        during_api = (time.monotonic() - started) * 1000

        thread.join()

        print(f"while waiting  /healthz latency: {during:.0f} ms  (status {health.status_code})")
        print(f"while waiting  /api/sessions   : {during_api:.0f} ms  (status {sessions.status_code})")
        print(f"serial_read returned after     : {result.get('elapsed_ms', 0):.0f} ms")

        blocked = during > max(1000.0, args.wait_ms * 0.5)
        print()
        if blocked:
            print(
                "VERDICT: the event loop is BLOCKED. A waiting serial_read held /healthz "
                f"for {during:.0f} ms while the tool waited {args.wait_ms} ms on the UART."
            )
            print("Consequence: the operator's status, audit stream and terminal freeze")
            print("for exactly as long as the agent is waiting on the port.")
            return 1
        print(f"VERDICT: event loop stayed responsive ({during:.0f} ms).")
        return 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        log.close()


if __name__ == "__main__":
    raise SystemExit(main())
