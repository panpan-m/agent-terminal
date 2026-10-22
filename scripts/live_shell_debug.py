"""Agent-path live debug: MCP stdio (same client DSH uses) against the Pi shell.

Requires the board to be logged in at a shell prompt on the serial console.
Runs read-only commands, exercises expect/cursor/permission paths, then hands
control back to the operator.

    python scripts/live_shell_debug.py [--session board]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
from pathlib import Path

import httpx
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

ROOT = Path(__file__).resolve().parents[1]
PROMPT = r"root@[^\s]+:[^\n]*# "
COMMANDS = [
    ("hostname", "cat /etc/hostname"),
    ("kernel", "uname -a"),
    ("os", "head -n 2 /etc/os-release"),
    ("model", "grep -m1 'Model' /proc/cpuinfo"),
    ("uptime", "uptime"),
    ("memory", "free -m"),
    ("disk", "df -h /"),
    ("addresses", "ip -br addr"),
    ("services", "systemctl --failed --no-pager"),
    ("kernel_tail", "dmesg --ctime 2>/dev/null | tail -n 5"),
]


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--session", default="board")
    parser.add_argument("--password")
    parser.add_argument("--out", default=str(ROOT / "artifacts" / "live-shell"))
    args = parser.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    admin = httpx.Client(base_url="http://127.0.0.1:8765", timeout=30)

    checks: list[dict] = []
    outputs: dict[str, str] = {}

    def check(name: str, ok: bool, detail: str = "") -> None:
        checks.append({"name": name, "ok": bool(ok), "detail": str(detail)[:600]})
        print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  — {str(detail)[:170]}" if detail else ""))

    params = StdioServerParameters(
        command=str(ROOT / "dist" / "agent-mcp.exe"),
        args=["--url", "http://127.0.0.1:8765/mcp", "--token-file", str(ROOT / "run" / "api-token")],
    )

    def structured(result) -> dict:
        return result.structured_content or {}

    try:
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                init = await session.initialize()
                check(
                    "MCP stdio server initializes (DSH client path)",
                    init.server_info.name == "agent-terminal",
                    f"{init.server_info.name} {init.server_info.version} / {init.protocol_version}",
                )
                tools = await session.list_tools()
                check(
                    "sixteen tools advertised",
                    [tool.name for tool in tools.tools]
                    == [
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
                    ",".join(tool.name for tool in tools.tools),
                )

                status = structured(await session.call_tool("serial_status", {"session_id": args.session}))
                check("session is open", status.get("state") == "open", f"{status.get('port')} {status.get('state')}")

                # A fresh server has an empty ring; press Enter once as the
                # operator so the prompt is guaranteed to be in the history.
                admin.post(
                    f"/api/sessions/{args.session}/write",
                    json={"text": "", "newline": "cr"},
                        )
                await asyncio.sleep(0.5)
                history = structured(
                    await session.call_tool(
                        "serial_read", {"session_id": args.session, "tail_bytes": 2000, "timeout_ms": 300}
                    )
                )
                ring_text = history.get("text") or ""
                check(
                    "board is at a root shell prompt",
                    bool(re.search(PROMPT, ring_text)),
                    repr(ring_text[-80:]),
                )

                tail = structured(
                    await session.call_tool(
                        "serial_tail", {"session_id": args.session, "lines": 5}
                    )
                )
                check(
                    "serial_tail returns the newest lines",
                    tail.get("count", 0) >= 1 and "root@" in (tail.get("text") or ""),
                    repr((tail.get("text") or "")[-120:]),
                )

                # hand write control to the agent
                admin.put(f"/api/sessions/{args.session}/control", json={"owner": "agent"})
                locked = structured(await session.call_tool("serial_write", {"session_id": args.session, "data": "\n"}))
                # a bare newline is allowed and should be written; control is ours now
                check("agent can write after handover", "bytes_written" in locked, json.dumps(locked)[:120])

                for label, command in COMMANDS:
                    result = structured(
                        await session.call_tool(
                            "serial_command",
                            {
                                "session_id": args.session,
                                "command": command,
                                "expect": PROMPT,
                                "expect_mode": "regex",
                                "timeout_ms": 8000,
                                "max_bytes": 16384,
                            },
                        )
                    )
                    text = result.get("rx_text", "")
                    outputs[label] = text[-4000:]
                    first_line = next((line for line in text.splitlines() if line.strip()), "")
                    check(
                        f"shell: {command}",
                        result.get("matched") is True and result.get("tx_bytes", 0) == len(command) + 1,
                        f"matched={result.get('matched')} elapsed={result.get('elapsed_ms')}ms first={first_line[:90]!r}",
                    )

                # cursor continuity after real shell output
                cursor = result.get("next_cursor", 0)
                after = structured(
                    await session.call_tool(
                        "serial_read",
                        {"session_id": args.session, "cursor": cursor, "timeout_ms": 200, "format": "hex"},
                    )
                )
                check(
                    "cursor read continues after the shell burst",
                    after.get("gap") is False and after.get("head_cursor", 0) >= cursor,
                    f"next={after.get('next_cursor')} head={after.get('head_cursor')}",
                )

                # expected timeout is a normal result, not an error
                timeout = structured(
                    await session.call_tool(
                        "serial_command",
                        {
                            "session_id": args.session,
                            "command": "true",
                            "expect": "ZZZ_NEVER_MATCH",
                            "timeout_ms": 600,
                        },
                    )
                )
                check(
                    "no-match command times out cleanly",
                    timeout.get("timed_out") is True and timeout.get("matched") is False,
                    f"elapsed={timeout.get('elapsed_ms')}ms",
                )

                # generic POSIX end marker: no prompt knowledge, works on any
                # bash/dash/ash/busybox shell, returns the remote exit code
                marker_cases = [
                    ("success", "echo marker-ok", 0, 0),
                    ("failure", "ls /no-such-path-tio", 2, 0),
                    ("slow", "sleep 1; echo done", 0, 900),
                ]
                for label, command, expected_code, min_ms in marker_cases:
                    result = structured(
                        await session.call_tool(
                            "serial_command",
                            {
                                "session_id": args.session,
                                "command": command,
                                "capture_exit": True,
                                "timeout_ms": 10000,
                            },
                        )
                    )
                    check(
                        f"capture_exit {label}: exit={expected_code}",
                        result.get("matched") is True
                        and result.get("exit_code") == expected_code
                        and result.get("completion") == "marker"
                        and result.get("elapsed_ms", 0) >= min_ms,
                        f"exit={result.get('exit_code')} elapsed={result.get('elapsed_ms')}ms",
                    )

                heredoc = structured(
                    await session.call_tool(
                        "serial_command",
                        {
                            "session_id": args.session,
                            "command": "cat <<'EOF'\nhello-heredoc\nEOF",
                            "capture_exit": True,
                            "timeout_ms": 5000,
                        },
                    )
                )
                check(
                    "capture_exit keeps a heredoc intact",
                    heredoc.get("exit_code") == 0 and "hello-heredoc" in (heredoc.get("rx_text") or ""),
                    f"exit={heredoc.get('exit_code')}",
                )

                serial_break = structured(
                    await session.call_tool(
                        "serial_break", {"session_id": args.session, "duration_ms": 100}
                    )
                )
                check(
                    "serial_break sends a framing break",
                    serial_break.get("duration_ms") == 100,
                    f"{serial_break}",
                )

                # permission arbitration on the real shell
                admin.put(
                    f"/api/sessions/{args.session}/permissions",
                    json={"permissions": ["read"]},
                        )
                denied = await session.call_tool(
                    "serial_write", {"session_id": args.session, "data": "\n"}
                )
                code = structured(denied).get("error", {}).get("code")
                check("write denied after removing the permission", denied.is_error is True and code == "WRITE_DISABLED", code)
                admin.put(
                    f"/api/sessions/{args.session}/permissions",
                    json={"permissions": ["read", "write", "command"]},
                        )

        # hand control back to the operator
        admin.put(f"/api/sessions/{args.session}/control", json={"owner": "human"})
        final = admin.get(f"/api/sessions/{args.session}").json()
        check(
            "control returned to the operator",
            final.get("control_owner") == "human" and final.get("state") == "open",
            f"{final.get('control_owner')}/{final.get('state')}",
        )
        admin.close()
    finally:
        admin.close()

    failed = [c for c in checks if not c["ok"]]
    report = {"checks": checks, "outputs": outputs, "passed": len(checks) - len(failed), "failed": len(failed)}
    (out / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    for label, text in outputs.items():
        print(f"\n----- {label} -----")
        print(text.strip()[:500])
    print(f"\n{report['passed']}/{len(checks)} agent-path checks passed — {out / 'report.json'}")
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
