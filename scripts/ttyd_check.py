"""ttyd end-to-end check (Windows ConPTY): browser terminal -> bridge -> server.

The server is configured with ``ttyd.enabled = true``; its supervisor starts the
read-only and control entries for every session, creates the bridge command and
passes the basic-auth credential.  This script then speaks ttyd's WebSocket
protocol directly to prove raw bytes flow, and checks auto-start for sessions
created through the API.

Writes artifacts/ttyd/report.json and exits non-zero on failure.
"""

from __future__ import annotations

import base64
import json
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
        print(f"{'PASS' if ok else 'FAIL'}  {name}  {str(detail)[:160]}")
        return ok

    if not TTYD.exists():
        print(f"ttyd binary missing: {TTYD} (download 1.7.7 to tools/ttyd/ttyd.exe)")
        return 2

    data = out / "data"
    if data.exists():
        import shutil

        shutil.rmtree(data)
    cfg, secrets = init_config(data)
    cfg.security.allow_dev_ports = True
    cfg.sessions = [SessionConfig(id="board-a", name="Board A", port="sim://board-a", auto_open=True)]
    server_port = free_port()
    cfg.server.port = server_port
    cfg.ttyd.enabled = True
    cfg.ttyd.binary = str(TTYD)
    cfg.ttyd.view_port_base = free_port()
    cfg.ttyd.control_port_base = cfg.ttyd.view_port_base + 1
    cfg.save()
    control_password = (data / "ttyd-control.pass").read_text(encoding="utf-8").strip()

    server_log = (out / "server.log").open("wb")
    server = subprocess.Popen(
        [PY, "-m", "tio_server", "run", "--config", str(cfg.path)],
        cwd=str(ROOT),
        stdout=server_log,
        stderr=server_log,
    )
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

        client = httpx.Client(base_url=f"http://127.0.0.1:{server_port}", timeout=30)
        login = client.post(
            "/api/auth/login", json={"username": "admin", "password": secrets["admin_password"]}
        ).json()
        headers = {"X-CSRF-Token": login["csrf"]}
        client.put("/api/sessions/board-a/control", json={"owner": "human"}, headers=headers)

        def instances() -> list[dict]:
            return client.get("/api/system").json()["ttyd"]["instances"]

        def wait_instance(session_id: str, mode: str, present: bool = True, timeout: float = 15) -> dict | None:
            deadline_ = time.time() + timeout
            found = None
            while time.time() < deadline_:
                found = next(
                    (
                        instance
                        for instance in instances()
                        if instance["session_id"] == session_id and instance["mode"] == mode and instance["alive"]
                    ),
                    None,
                )
                if (found is not None) == present:
                    return found
                time.sleep(0.25)
            return found

        view = wait_instance("board-a", "ro")
        control = wait_instance("board-a", "rw")
        check("supervisor starts both entries for a configured session", bool(view and control), str(instances()))
        if not view or not control:
            return 2
        view_port, control_port = view["port"], control["port"]

        session_status = client.get("/api/sessions/board-a").json()
        check(
            "session status exposes terminal URLs",
            session_status.get("terminal", {}).get("view_url") == f"http://127.0.0.1:{view_port}/",
            json.dumps(session_status.get("terminal")),
        )

        page = httpx.get(f"http://127.0.0.1:{view_port}/", timeout=5)
        check("ttyd serves the terminal page", page.status_code == 200 and "ttyd" in page.text.lower())

        auth = base64.b64encode(f"operator:{control_password}".encode()).decode()
        unauth = httpx.get(f"http://127.0.0.1:{control_port}/", timeout=5)
        authed = httpx.get(
            f"http://127.0.0.1:{control_port}/",
            headers={"Authorization": f"Basic {auth}"},
            timeout=5,
        )
        check("control entry requires basic auth", unauth.status_code == 401, str(unauth.status_code))
        check("control entry accepts the operator credential", authed.status_code == 200, str(authed.status_code))

        token_response = httpx.get(
            f"http://127.0.0.1:{control_port}/token",
            headers={"Authorization": f"Basic {auth}"},
            timeout=5,
        )
        token = token_response.json().get("token", "") if token_response.status_code == 200 else ""
        received = b""
        with connect(
            f"ws://127.0.0.1:{control_port}/ws",
            subprotocols=["tty"],
            origin=f"http://127.0.0.1:{control_port}",
            additional_headers={"Authorization": f"Basic {auth}"},
            open_timeout=10,
            max_size=None,
        ) as ws:
            ws.send(json.dumps({"AuthToken": token, "columns": 120, "rows": 30}).encode())
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
                if message[:1] == b"0":
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
                if message[:1] == b"0":
                    received += message[1:]
                if b"commands:" in received:
                    break
            check(
                "raw keystrokes reach the UART and output returns",
                b"commands:" in received,
                received[-300:].decode(errors="replace"),
            )

            ws.send(b"0" + b"\x03")
            time.sleep(0.4)
            check("Ctrl-C is forwarded as a byte", control["pid"] and control["alive"], "ttyd still running")

        # Creating a session through the API must bring up its entries...
        created = client.post(
            "/api/sessions",
            json={"id": "board-b", "port": "sim://board-b", "auto_open": True},
            headers=headers,
        )
        check("session created through the API", created.status_code == 201, str(created.status_code))
        new_control = wait_instance("board-b", "rw")
        check("supervisor auto-starts entries for a new session", bool(new_control), str(instances()))
        if new_control:
            page_b = httpx.get(f"http://127.0.0.1:{new_control['port']}/", timeout=5)
            check("new session terminal is reachable", page_b.status_code == 200, str(page_b.status_code))

        # ...and deleting it must stop them again.
        client.delete("/api/sessions/board-b", headers=headers)
        gone = wait_instance("board-b", "rw", present=False, timeout=10)
        check("deleting a session stops its ttyd entries", gone is None, str(instances()))

        client.close()
    finally:
        if server.poll() is None:
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(server.pid)], capture_output=True)
        server_log.close()

    failed = [c for c in checks if not c["ok"]]
    (out / "report.json").write_text(
        json.dumps({"checks": checks, "passed": len(checks) - len(failed), "failed": len(failed)}, indent=2),
        encoding="utf-8",
    )
    print(f"\n{len(checks) - len(failed)}/{len(checks)} ttyd checks passed")
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())


