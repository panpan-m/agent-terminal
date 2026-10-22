"""End-to-end: real HTTP server process + MCP stdio shim."""

from __future__ import annotations

import json
import os
import queue
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

import httpx
import pytest

from tio_server.config import init_config

ROOT = Path(__file__).resolve().parents[2]
PY = sys.executable


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class LineReader:
    def __init__(self, proc: subprocess.Popen) -> None:
        self.proc = proc
        self.q: queue.Queue[str] = queue.Queue()
        self.thread = threading.Thread(target=self._pump, daemon=True)
        self.thread.start()

    def _pump(self) -> None:
        assert self.proc.stdout is not None
        for line in self.proc.stdout:
            self.q.put(line)

    def readline(self, timeout: float = 10.0) -> str:
        try:
            return self.q.get(timeout=timeout)
        except queue.Empty as exc:
            raise TimeoutError("no output from subprocess") from exc


@pytest.fixture(scope="module")
def server(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("e2e")
    cfg, secrets = init_config(tmp / "data")
    cfg.security.allow_dev_ports = True
    cfg.sessions = []
    port = free_port()
    cfg.server.port = port
    cfg.save()
    log = (tmp / "server.out").open("wb")
    proc = subprocess.Popen(
        [PY, "-m", "tio_server", "run", "--config", str(cfg.path), "--port", str(port)],
        cwd=str(ROOT),
        stdout=log,
        stderr=log,
    )
    base = f"http://127.0.0.1:{port}"
    deadline = time.time() + 30
    while time.time() < deadline:
        if proc.poll() is not None:
            log.close()
            raise RuntimeError(f"server exited: {(tmp / 'server.out').read_text(errors='replace')[-3000:]}")
        try:
            if httpx.get(base + "/healthz", timeout=0.5).status_code == 200:
                break
        except httpx.HTTPError:
            time.sleep(0.2)
    else:
        proc.kill()
        raise RuntimeError("server did not become healthy")
    yield {"base": base, "cfg": cfg, "secrets": secrets, "tmp": tmp, "proc": proc}
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
    log.close()


def admin_client(server) -> httpx.Client:
    return httpx.Client(base_url=server["base"], timeout=10)


def create_session(client: httpx.Client, **overrides) -> dict:
    body = {"id": "board-a", "port": "sim://board-a", "auto_open": True}
    body.update(overrides)
    r = client.post("/api/sessions", json=body)
    assert r.status_code == 201, r.text
    return r.json()


def ensure_session(client: httpx.Client) -> dict:
    existing = client.get("/api/sessions").json()["sessions"]
    for sess in existing:
        if sess["session_id"] == "board-a":
            return sess
    return create_session(client)


def test_server_health_and_admin_api(server):
    client = admin_client(server)
    ensure_session(client)
    r = client.get("/api/sessions")
    assert r.json()["sessions"][0]["state"] == "open"
    r = client.post("/api/sessions/board-a/command", json={"command": "ping", "expect": "pong", "timeout_ms": 3000})
    assert r.json()["matched"] is True
    r = client.get("/api/system")
    assert r.json()["version"] == "0.1.0"
    client.close()


def test_mcp_over_stdio_shim(server):
    client = admin_client(server)
    ensure_session(client)
    control = client.put("/api/sessions/board-a/control", json={"owner": "agent"})
    assert control.status_code == 200, control.text
    assert control.json()["control_owner"] == "agent"
    client.close()
    shim = subprocess.Popen(
        [
            PY,
            "-m",
            "tio_mcp_shim",
            "--url",
            server["base"] + "/mcp",
            "--token-file",
            str(server["cfg"].api_token_file),
        ],
        cwd=str(ROOT),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    reader = LineReader(shim)
    try:
        assert shim.stdin is not None
        init = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2026-07-28",
                "capabilities": {},
                "clientInfo": {"name": "e2e", "version": "0"},
            },
        }
        shim.stdin.write(json.dumps(init) + "\n")
        shim.stdin.flush()
        response = json.loads(reader.readline())
        assert response["result"]["serverInfo"]["name"] == "tio-server"

        shim.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
        shim.stdin.flush()

        shim.stdin.write(json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}) + "\n")
        shim.stdin.flush()
        tools = json.loads(reader.readline())["result"]["tools"]
        assert [t["name"] for t in tools][0] == "serial_sessions"

        call = {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {"name": "serial_command", "arguments": {"command": "echo e2e", "expect": "e2e"}},
        }
        shim.stdin.write(json.dumps(call) + "\n")
        shim.stdin.flush()
        result = json.loads(reader.readline())["result"]
        assert result["isError"] is False, result
        assert result["structuredContent"]["matched"] is True
    finally:
        shim.terminate()
        try:
            shim.wait(timeout=5)
        except subprocess.TimeoutExpired:
            shim.kill()


def test_mcp_shim_reports_server_down(tmp_path):
    missing = subprocess.run(
        [PY, "-m", "tio_mcp_shim", "--token-file", str(tmp_path / "missing")],
        capture_output=True,
        text=True,
        cwd=str(ROOT),
    )
    assert missing.returncode == 2
    assert "token" in missing.stderr.lower()

    token_file = tmp_path / "token"
    token_file.write_text("dummy", encoding="utf-8")
    proc = subprocess.Popen(
        [PY, "-m", "tio_mcp_shim", "--url", f"http://127.0.0.1:{free_port()}/mcp", "--token-file", str(token_file)],
        cwd=str(ROOT),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    reader = LineReader(proc)
    try:
        assert proc.stdin is not None
        proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": 9, "method": "initialize", "params": {}}) + "\n")
        proc.stdin.flush()
        line = json.loads(reader.readline())
        assert line["error"]["code"] == -32000
        assert "tio-server is not running" in line["error"]["message"]
    finally:
        proc.terminate()
        proc.wait(timeout=5)


class ByteReader:
    def __init__(self, proc: subprocess.Popen) -> None:
        self.buf = bytearray()
        self.q: queue.Queue[bytes] = queue.Queue()
        self.proc = proc
        threading.Thread(target=self._pump, daemon=True).start()

    def _pump(self) -> None:
        assert self.proc.stdout is not None
        while True:
            chunk = self.proc.stdout.read(1)
            if not chunk:
                return
            self.q.put(chunk)

    def wait_for(self, needle: bytes, timeout: float = 10.0) -> bytes:
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                self.buf.extend(self.q.get(timeout=0.2))
            except queue.Empty:
                continue
            if needle in self.buf:
                return bytes(self.buf)
        return bytes(self.buf)

