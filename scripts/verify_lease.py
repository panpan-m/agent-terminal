"""Two real MCP clients race for one serial session: the lease must arbitrate.

Run against a live server::

    python scripts/verify_lease.py --url http://127.0.0.1:8765 --session board-a
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]


class Client:
    """One MCP streamable-HTTP client with its own declared identity."""

    def __init__(self, base: str, token: str, name: str) -> None:
        self.url = base.rstrip("/") + "/mcp"
        self.token = token
        self.name = name
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
        response = httpx.post(self.url, headers=self._headers(), content=json.dumps(payload), timeout=60)
        if response.headers.get("Mcp-Session-Id"):
            self.session = response.headers["Mcp-Session-Id"]
        response.raise_for_status()
        return self._parse(response.text)

    def open(self) -> None:
        self.post(
            {
                "jsonrpc": "2.0",
                "id": self.next_id,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2026-07-28",
                    "capabilities": {},
                    "clientInfo": {"name": self.name, "version": "1"},
                },
            }
        )
        httpx.post(
            self.url,
            headers=self._headers(),
            content=json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}),
            timeout=30,
        )

    def call(self, tool: str, arguments: dict | None = None) -> dict:
        self.next_id += 1
        body = self.post(
            {
                "jsonrpc": "2.0",
                "id": self.next_id,
                "method": "tools/call",
                "params": {"name": tool, "arguments": arguments or {}},
            }
        )
        return body.get("result", {})


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:8765")
    parser.add_argument("--session", default="board-a", help="serial session to arbitrate")
    parser.add_argument("--token-file", default=str(ROOT / "run" / "api-token"))
    args = parser.parse_args()

    token = Path(args.token_file).read_text(encoding="utf-8").strip()
    base = args.url.rstrip("/")

    # bind the session so the agent-facing tools are published
    listed = httpx.get(f"{base}/api/sessions", timeout=10).json()["sessions"]
    if args.session not in {s["session_id"] for s in listed}:
        print(f"no such session: {args.session}; available: {[s['session_id'] for s in listed]}")
        return 1
    httpx.put(
        f"{base}/api/mcp/bindings",
        json={"serial_session_id": args.session},
        timeout=10,
    ).raise_for_status()

    a = Client(base, token, "agent-a")
    b = Client(base, token, "agent-b")
    a.open()
    b.open()

    checks: list[tuple[str, bool, str]] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        checks.append((name, ok, detail))
        print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f"  — {detail}" if detail else ""))

    print(f"\n== session {args.session} ==")

    claimed = a.call("serial_claim", {"ttl_ms": 120000})
    sc = claimed.get("structuredContent") or {}
    check("agent-a claims the wire", claimed.get("isError") is False, str(sc.get("owner")))
    check("claim is attributed to agent-a", sc.get("owner") == "agent-a", str(sc.get("owner")))

    mine = a.call("serial_write", {"data": "ping", "newline": "lf"})
    check("holder writes", mine.get("isError") is False, json.dumps(mine.get("structuredContent"))[:80])

    blocked = b.call("serial_write", {"data": "ls", "newline": "lf"})
    err = (blocked.get("structuredContent") or {}).get("error") or {}
    check("other agent is refused", blocked.get("isError") is True, err.get("code", ""))
    check("refusal names the holder", (err.get("details") or {}).get("holder", {}).get("owner") == "agent-a", str(err.get("details")))

    blocked_cmd = b.call("serial_command", {"command": "help"})
    check(
        "serial_command is refused too",
        (blocked_cmd.get("structuredContent") or {}).get("error", {}).get("code") == "LEASE_HELD",
        "",
    )

    observed = b.call("serial_read", {"cursor": 0})
    check("the observer can still read", observed.get("isError") is False, "")

    released = a.call("serial_release", {})
    check("agent-a releases", (released.get("structuredContent") or {}).get("released") is True, "")

    handed = b.call("serial_write", {"data": "ping", "newline": "lf"})
    check("agent-b may write after release", handed.get("isError") is False, "")

    # the operator lever: B claims, the admin API breaks it
    b.call("serial_claim", {"ttl_ms": 120000})
    broken = httpx.delete(f"{base}/api/sessions/{args.session}/lease", timeout=10)
    check("operator force-release works", broken.status_code == 200 and broken.json()["released"] is True, broken.text[:80])
    after = a.call("serial_write", {"data": "ping", "newline": "lf"})
    check("agent-a may write afterwards", after.get("isError") is False, "")

    failed = [name for name, ok, _ in checks if not ok]
    print(f"\n== {len(checks) - len(failed)}/{len(checks)} checks passed ==")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
