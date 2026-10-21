"""Verify the PyInstaller artifacts (not the source tree).

    python scripts/verify_packaged.py [--dist dist]

Checks: exe init, service-style run, bundled SPA, admin API, MCP over HTTP, and
the packaged ``tio-mcp.exe`` stdio shim talking to the packaged server.
"""

from __future__ import annotations

import json
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from tio_server.config import Config, SessionConfig  # noqa: E402


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def sse_json(text: str) -> list[dict]:
    out, data = [], []
    for line in text.splitlines():
        if line.startswith("data:"):
            data.append(line[5:].lstrip())
        elif not line.strip() and data:
            try:
                out.append(json.loads("\n".join(data)))
            except json.JSONDecodeError:
                pass
            data = []
    return out


def main() -> int:
    dist = ROOT / "dist"
    server_exe = dist / "tio-server" / "tio-server.exe"
    shim_exe = dist / "tio-mcp.exe"
    out = ROOT / "artifacts" / "packaged"
    out.mkdir(parents=True, exist_ok=True)
    checks: list[dict] = []

    def check(name: str, ok: bool, detail: str = "") -> bool:
        checks.append({"name": name, "ok": bool(ok), "detail": str(detail)[:400]})
        print(f"{'PASS' if ok else 'FAIL'}  {name}  {str(detail)[:150]}")
        return ok

    for exe in (server_exe, shim_exe):
        if not exe.exists():
            print(f"missing artifact: {exe}")
            return 2

    data_dir = out / "data"
    if data_dir.exists():
        import shutil

        shutil.rmtree(data_dir)
    creds_file = out / "credentials.json"

    init = subprocess.run(
        [str(server_exe), "init", "--dir", str(data_dir), "--credentials-out", str(creds_file)],
        capture_output=True,
        text=True,
        timeout=120,
    )
    check("packaged init succeeds", init.returncode == 0, init.stderr[-300:])
    creds = json.loads(creds_file.read_text(encoding="utf-8"))
    cfg = Config.load(data_dir / "config.toml")
    cfg.security.allow_dev_ports = True
    cfg.security.rate_limit_per_second = 200
    cfg.sessions = [
        SessionConfig(id="board-a", name="Board A", port="sim://board-a", auto_open=True)
    ]
    cfg.server.port = free_port()
    cfg.save()
    check("config written by the packaged init", cfg.path.exists())

    log = (out / "server.log").open("wb")
    server = subprocess.Popen(
        [str(server_exe), "run", "--config", str(cfg.path)],
        cwd=str(ROOT),
        stdout=log,
        stderr=log,
    )
    shim = None
    try:
        base = f"http://127.0.0.1:{cfg.server.port}"
        deadline = time.time() + 60
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
        check("packaged server starts", healthy, (out / "server.log").read_text(errors="replace")[-300:])
        if not healthy:
            return 2

        client = httpx.Client(base_url=base, timeout=30)
        login = client.post("/api/auth/login", json={"username": "admin", "password": creds["admin_password"]})
        check("packaged server login", login.status_code == 200)
        headers = {"X-CSRF-Token": login.json()["csrf"]}
        sessions = client.get("/api/sessions").json()["sessions"]
        check("auto_open session is open", sessions and sessions[0]["state"] == "open", sessions[0]["state"] if sessions else "")
        command = client.post(
            "/api/sessions/board-a/command",
            json={"command": "version", "expect": "tiosim", "timeout_ms": 4000},
            headers=headers,
        )
        check("serial command through the packaged server", command.status_code == 200 and command.json().get("matched"))

        index = client.get("/")
        check("bundled SPA is served", index.status_code == 200 and '<div id="root">' in index.text)
        asset_path = None
        import re

        script_match = re.search(r'src="(/assets/[^"]+\.js)"', index.text) or re.search(
            r'src="([^"]+\.js)"', index.text
        )
        if script_match:
            asset_path = script_match.group(1)
        asset = client.get(asset_path) if asset_path else None
        check(
            "bundled SPA assets are served",
            asset is not None and asset.status_code == 200 and len(asset.content) > 100_000,
            f"{asset_path} status={getattr(asset, 'status_code', 'n/a')} bytes={len(asset.content) if asset else 0}",
        )

        # MCP over HTTP
        rpc = httpx.Client(timeout=60, follow_redirects=True)
        mcp_headers = {
            "Authorization": f"Bearer {creds['api_token']}",
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        init_msg = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {"protocolVersion": "2026-07-28", "capabilities": {}, "clientInfo": {"name": "pkg", "version": "0"}},
        }
        response = rpc.post(base + "/mcp", json=init_msg, headers=mcp_headers)
        session_id = response.headers.get("mcp-session-id")
        if session_id:
            mcp_headers["Mcp-Session-Id"] = session_id
        messages = sse_json(response.text)
        check(
            "MCP initialize on the packaged server",
            bool(messages) and messages[0].get("result", {}).get("serverInfo", {}).get("name") == "tio-server",
        )

        # Packaged stdio shim against the packaged server
        shim = subprocess.Popen(
            [str(shim_exe), "--url", base + "/mcp", "--token-file", str(data_dir / "api-token")],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        assert shim.stdin is not None and shim.stdout is not None
        shim.stdin.write(json.dumps(init_msg) + "\n")
        shim.stdin.flush()
        first = json.loads(shim.stdout.readline())
        check("packaged tio-mcp.exe initializes", first.get("result", {}).get("serverInfo", {}).get("name") == "tio-server", first)
        shim.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
        shim.stdin.flush()
        shim.stdin.write(
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": 2,
                    "method": "tools/call",
                    "params": {"name": "serial_status", "arguments": {}},
                }
            )
            + "\n"
        )
        shim.stdin.flush()
        status = json.loads(shim.stdout.readline())["result"]
        check(
            "packaged tio-mcp.exe calls a tool",
            status.get("isError") is False and status.get("structuredContent", {}).get("state") == "open",
            status.get("structuredContent", {}).get("state"),
        )

        client.close()
        rpc.close()
    finally:
        if shim is not None:
            shim.terminate()
            try:
                shim.wait(timeout=5)
            except subprocess.TimeoutExpired:
                shim.kill()
        if server.poll() is None:
            server.terminate()
            try:
                server.wait(timeout=15)
            except subprocess.TimeoutExpired:
                server.kill()
        log.close()

    failed = [c for c in checks if not c["ok"]]
    (out / "report.json").write_text(
        json.dumps({"checks": checks, "passed": len(checks) - len(failed), "failed": len(failed)}, indent=2),
        encoding="utf-8",
    )
    print(f"\n{len(checks) - len(failed)}/{len(checks)} packaged checks passed")
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
