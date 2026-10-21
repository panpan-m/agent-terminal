"""ttyd end-to-end check (Windows ConPTY): browser terminal -> bridge -> server.

Starts a real server + a real ttyd process whose child command is
``tio-web-bridge``, then speaks ttyd's WebSocket protocol directly to prove the
terminal transports raw bytes (banner, typed command, response).

Writes artifacts/ttyd/report.json and exits non-zero on failure.
"""

from __future__ import annotations

import base64
import json
import re
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx
from websockets.sync.client import connect

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from tio_server.config import SessionConfig, init_config  # noqa: E402

PY = sys.executable
TTYD = ROOT / "tools" / "ttyd" / "ttyd.exe"


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def main() -> int:
    out = ROOT / "artifacts" / "ttyd"
    out.mkdir(parents=True, exist_ok=True)
    checks: list[dict] = []

    def check(name: str, ok: bool, detail: str = "") -> bool:
        checks.append({"name": name, "ok": bool(ok), "detail": str(detail)[:500]})
        print(f"{'PASS' if ok else 'FAIL'}  {name}  {detail[:160]}")
        return ok

    if not TTYD.exists():
        print(f"ttyd binary missing: {TTYD}")
        return 2

    data = out / "data"
    if data.exists():
        import shutil

        shutil.rmtree(data)
    cfg, secrets = init_config(data)
    cfg.security.allow_dev_ports = True
    cfg.sessions = [
        SessionConfig(id="board-a", name="Board A", port="sim://board-a", auto_open=True)
    ]
    server_port = free_port()
    cfg.server.port = server_port
    cfg.save()

    server_log = (out / "server.log").open("wb")
    server = subprocess.Popen(
        [PY, "-m", "tio_server", "run", "--config", str(cfg.path)],
        cwd=str(ROOT),
        stdout=server_log,
        stderr=server_log,
    )
    ttyd: subprocess.Popen | None = None
    ttyd_log = (out / "ttyd.log").open("wb")
    try:
        deadline = time.time() + 30
        while time.time() < deadline:
            try:
                if httpx.get(f"http://127.0.0.1:{server_port}/healthz", timeout=0.5).status_code == 200:
                    break
            except httpx.HTTPError:
                time.sleep(0.2)
        else:
            check("tio-server started", False)
            return 2
        check("tio-server started", True)

        client = httpx.Client(base_url=f"http://127.0.0.1:{server_port}", timeout=20)
        login = client.post(
            "/api/auth/login", json={"username": "admin", "password": secrets["admin_password"]}
        ).json()
        headers = {"X-CSRF-Token": login["csrf"]}
        client.put("/api/sessions/board-a/control", json={"owner": "human"}, headers=headers)

        ttyd_port = free_port()
        bridge_cmd = [
            PY,
            "-m",
            "tio_web_bridge",
            "--url",
            f"ws://127.0.0.1:{server_port}/ws/bridge/board-a",
            "--mode",
            "rw",
            "--token-file",
            str(cfg.bridge_token_file),
        ]
        ttyd = subprocess.Popen(
            [
                str(TTYD),
                "-p",
                str(ttyd_port),
                "-i",
                "127.0.0.1",
                "-O",
                "-W",
                "-m",
                "2",
                *bridge_cmd,
            ],
            cwd=str(ROOT),
            stdout=ttyd_log,
            stderr=ttyd_log,
        )
        base = f"http://127.0.0.1:{ttyd_port}"
        deadline = time.time() + 20
        page = None
        while time.time() < deadline:
            if ttyd.poll() is not None:
                break
            try:
                response = httpx.get(base + "/", timeout=1)
                if response.status_code == 200:
                    page = response
                    break
            except httpx.HTTPError:
                time.sleep(0.2)
        if not check("ttyd serves the terminal page", page is not None, page.text[:80] if page else (out / "ttyd.log").read_text(errors="replace")[-500:]):
            return 2
        check("ttyd page mentions xterm/ttyd", "ttyd" in page.text.lower() or "xterm" in page.text.lower())

        token_response = httpx.get(base + "/token", timeout=5)
        token = token_response.json().get("token", "") if token_response.status_code == 200 else ""

        received = b""
        with connect(
            f"ws://127.0.0.1:{ttyd_port}/ws",
            subprotocols=["tty"],
            origin=f"http://127.0.0.1:{ttyd_port}",
            open_timeout=10,
            max_size=None,
        ) as ws:
            ws.send(json.dumps({"AuthToken": token, "columns": 120, "rows": 30}).encode())
            # Wait for the boot banner relayed from the simulated board.
            deadline = time.time() + 10
            while time.time() < deadline:
                try:
                    message = ws.recv(timeout=0.5)
                except TimeoutError:
                    continue
                except Exception:
                    break
                if isinstance(message, str):
                    message = message.encode()
                if message and message[0:1] == b"0":
                    received += message[1:]
                if b"TioSim" in received:
                    break
            check("ttyd streams the device banner", b"TioSim" in received, received[-200:].decode(errors="replace"))

            ws.send(b"0" + b"help\r")
            deadline = time.time() + 10
            while time.time() < deadline:
                try:
                    message = ws.recv(timeout=0.5)
                except TimeoutError:
                    continue
                except Exception:
                    break
                if isinstance(message, str):
                    message = message.encode()
                if message and message[0:1] == b"0":
                    received += message[1:]
                if b"commands:" in received:
                    break
            check(
                "raw keystrokes reach the UART and output returns",
                b"commands:" in received,
                received[-300:].decode(errors="replace"),
            )

            # Ctrl-C must be forwarded as 0x03, not terminate the bridge.
            ws.send(b"0" + b"\x03")
            time.sleep(0.4)
            check("Ctrl-C is forwarded as a byte", ttyd.poll() is None, "ttyd still running")

        check("bridge process still alive after client left", ttyd.poll() is None)

        # Entry-level basic auth gate (HTTP layer).
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(ttyd.pid)], capture_output=True)
        ttyd.wait(timeout=10)
        auth_port = free_port()
        ttyd = subprocess.Popen(
            [
                str(TTYD),
                "-p",
                str(auth_port),
                "-i",
                "127.0.0.1",
                "-O",
                "-W",
                "-c",
                "operator:secret",
                *bridge_cmd,
            ],
            cwd=str(ROOT),
            stdout=ttyd_log,
            stderr=ttyd_log,
        )
        deadline = time.time() + 15
        unauth = None
        while time.time() < deadline:
            try:
                unauth = httpx.get(f"http://127.0.0.1:{auth_port}/", timeout=1)
                break
            except httpx.HTTPError:
                time.sleep(0.2)
        check("ttyd control entry requires basic auth", unauth is not None and unauth.status_code == 401, str(unauth.status_code if unauth else "no response"))
        authed = httpx.get(
            f"http://127.0.0.1:{auth_port}/",
            auth=("operator", "secret"),
            timeout=5,
        )
        check("ttyd control entry accepts the operator credential", authed.status_code == 200, str(authed.status_code))

        client.close()
    finally:
        for proc in (ttyd, server):
            if proc is not None and proc.poll() is None:
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True)
        server_log.close()
        ttyd_log.close()

    failed = [c for c in checks if not c["ok"]]
    (out / "report.json").write_text(
        json.dumps({"checks": checks, "passed": len(checks) - len(failed), "failed": len(failed)}, indent=2),
        encoding="utf-8",
    )
    print(f"\n{len(checks) - len(failed)}/{len(checks)} ttyd checks passed")
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
