"""Read-only camera / device-tree probe over the serial console.

Uses the same MCP stdio client path as DSH.  Runs read-only shell commands on
the board, stores each output under artifacts/camera/, then hands control back.

    python scripts/camera_dts_probe.py [--session board]
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

COMMANDS: list[tuple[str, str]] = [
    ("01_model", "cat /proc/device-tree/model; echo"),
    ("02_config_txt", "cat /boot/firmware/config.txt"),
    ("03_config_camera", "grep -nE '^(dtoverlay|dtparam|camera|gpu_mem|start_x|libcamera)' /boot/firmware/config.txt || true"),
    ("04_cmdline", "cat /boot/firmware/cmdline.txt"),
    ("05_overlays_camera", "ls /boot/firmware/overlays 2>/dev/null | grep -iE 'cam|ov[0-9]|imx|sensor|unicam|arducam' | sort | head -n 100"),
    ("06_dtoverlay_list", "command -v dtoverlay >/dev/null && dtoverlay -l 2>&1 || echo no-dtoverlay"),
    ("07_dtc", "command -v dtc || echo no-dtc"),
    ("08_devtree_entries", "ls /proc/device-tree | grep -iE 'cam|csi|i2c|rp1|unicam|pisp|video' | sort"),
    ("09_devtree_cam_nodes", "ls -d /proc/device-tree/*csi* /proc/device-tree/*cam* 2>/dev/null || echo none"),
    ("10_dev_nodes", "ls -l /dev/video* /dev/media* /dev/i2c-* 2>/dev/null || echo none"),
    ("11_v4l2", "if command -v v4l2-ctl >/dev/null; then v4l2-ctl --list-devices 2>&1 | head -n 60; else echo no-v4l2-ctl; fi"),
    (
        "12_libcamera",
        "if command -v rpicam-hello >/dev/null; then rpicam-hello --list-cameras 2>&1 | head -n 60; "
        "elif command -v libcamera-hello >/dev/null; then libcamera-hello --list-cameras 2>&1 | head -n 60; "
        "else echo no-libcamera; fi",
    ),
    ("13_modules", "lsmod | grep -iE 'i2c|v4l|rp1|unicam|pisp|cam|ov5647|imx' || true"),
    (
        "14_dmesg",
        "dmesg 2>/dev/null | grep -iE 'camera|csi|unicam|pisp|ov5647|ov9281|imx219|imx477|imx708|i2c|rp1|cfe' | tail -n 80",
    ),
    (
        "15_dt_camera_grep",
        "if command -v dtc >/dev/null; then dtc -I fs -O dts /proc/device-tree 2>/dev/null | "
        "grep -n -iE 'camera|csi|ov5647|ov9281|imx219|imx477|imx708|unicam|pisp' | head -n 80; "
        "else echo no-dtc; fi",
    ),
    (
        "16_i2c_debug",
        "for d in /proc/device-tree/i2c* /proc/device-tree/*/i2c*; do [ -d \"$d\" ] || continue; "
        "echo \"== $d\"; ls \"$d\" 2>/dev/null; done | head -n 80",
    ),
]


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--session", default="board")
    parser.add_argument("--password")
    parser.add_argument("--out", default=str(ROOT / "artifacts" / "camera"))
    args = parser.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    admin = httpx.Client(base_url="http://127.0.0.1:8765", timeout=30)

    params = StdioServerParameters(
        command=str(ROOT / "dist" / "tio-mcp.exe"),
        args=["--url", "http://127.0.0.1:8765/mcp", "--token-file", str(ROOT / "run" / "api-token")],
    )
    results: dict[str, str] = {}
    failures: list[str] = []

    admin.put(f"/api/sessions/{args.session}/control", json={"owner": "agent"})
    try:
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                for label, command in COMMANDS:
                    result = await session.call_tool(
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
                    data = result.structured_content or {}
                    text = data.get("rx_text", "")
                    results[label] = text
                    ok = data.get("matched") is True
                    if not ok:
                        failures.append(f"{label}: {data.get('timed_out')}")
                    print(f"{'PASS' if ok else 'FAIL'}  {label}  ({len(text)} chars)")
                    (out / f"{label}.txt").write_text(text, encoding="utf-8")
    finally:
        admin.put(f"/api/sessions/{args.session}/control", json={"owner": "human"})
        admin.close()

    (out / "report.json").write_text(
        json.dumps({"results": results, "failures": failures}, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    print(f"\n{len(COMMANDS) - len(failures)}/{len(COMMANDS)} probes captured — {out}")
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
