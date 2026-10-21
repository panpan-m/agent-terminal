"""Fourth camera probe: overlay parameters and bootloader/firmware versions."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

import httpx
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

ROOT = Path(__file__).resolve().parents[1]
PROMPT = r"root@[^\s]+:[^\n]*# "

COMMANDS: list[tuple[str, str]] = [
    ("60_bootloader", "vcgencmd bootloader_version 2>&1 | head -n 6"),
    ("61_bootloader_node", "ls /proc/device-tree/chosen/bootloader 2>/dev/null; for f in /proc/device-tree/chosen/bootloader/*; do [ -f \"$f\" ] || continue; printf '%s=' \"$(basename $f)\"; tr -d '\\0' < \"$f\"; echo; done 2>/dev/null | head -n 20"),
    ("62_imx708_help", "dtoverlay -h imx708 2>&1 | head -n 30"),
    ("63_imx219_help", "dtoverlay -h imx219 2>&1 | head -n 24"),
    ("64_ov5647_help", "dtoverlay -h ov5647 2>&1 | head -n 20"),
    ("65_readme_auto", "grep -n -i 'camera_auto_detect' /boot/firmware/overlays/README | head -n 5"),
    ("66_readme_imx708", "grep -n -A22 '^Name:.*imx708' /boot/firmware/overlays/README | head -n 30"),
    ("67_firmware_files", "ls -la /boot/firmware/*.dat /boot/firmware/*.elf 2>/dev/null | head -n 12"),
    ("68_dt_params", "grep -nE 'dtparam|dtoverlay|camera' /boot/firmware/config.txt"),
]


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--session", default="board")
    parser.add_argument("--password")
    parser.add_argument("--out", default=str(ROOT / "artifacts" / "camera"))
    args = parser.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    password = args.password
    if not password:
        creds = json.loads((ROOT / "run" / "first-run-credentials.json").read_text(encoding="utf-8"))
        password = creds["admin_password"]

    admin = httpx.Client(base_url="http://127.0.0.1:8765", timeout=30)
    csrf = admin.post("/api/auth/login", json={"username": "admin", "password": password}).json()["csrf"]
    headers = {"X-CSRF-Token": csrf}
    params = StdioServerParameters(
        command=str(ROOT / "dist" / "tio-mcp.exe"),
        args=["--url", "http://127.0.0.1:8765/mcp", "--token-file", str(ROOT / "run" / "api-token")],
    )
    results: dict[str, str] = {}
    failures: list[str] = []

    admin.put(f"/api/sessions/{args.session}/control", json={"owner": "agent"}, headers=headers)
    try:
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                for label, command in COMMANDS:
                    data = (
                        await session.call_tool(
                            "serial_command",
                            {
                                "session_id": args.session,
                                "command": command,
                                "expect": PROMPT,
                                "expect_mode": "regex",
                                "timeout_ms": 20000,
                                "max_bytes": 16384,
                            },
                        )
                    ).structured_content or {}
                    text = data.get("rx_text", "")
                    results[label] = text
                    if data.get("matched") is not True:
                        failures.append(label)
                    print(f"{'PASS' if data.get('matched') else 'FAIL'}  {label}  ({len(text)} chars)")
                    (out / f"{label}.txt").write_text(text, encoding="utf-8")
    finally:
        admin.put(f"/api/sessions/{args.session}/control", json={"owner": "human"}, headers=headers)
        admin.close()

    (out / "report4.json").write_text(
        json.dumps({"results": results, "failures": failures}, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    print(f"\n{len(COMMANDS) - len(failures)}/{len(COMMANDS)} probes captured")
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
