"""Third camera probe: overlay application evidence, CHOSEN, CSI identity."""

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
RP1 = "/proc/device-tree/axi/pcie@1000120000/rp1"

COMMANDS: list[tuple[str, str]] = [
    ("40_chosen", "ls /proc/device-tree/chosen 2>/dev/null; echo ---; ls /sys/firmware/devicetree/base/chosen 2>/dev/null"),
    ("41_bootargs", "tr -d '\\0' < /proc/device-tree/chosen/bootargs 2>/dev/null; echo"),
    ("42_vc4_drm", "dmesg 2>/dev/null | grep -iE 'vc4|v3d|drm|hdmi' | head -n 30"),
    ("43_drm_nodes", "ls /sys/class/drm 2>/dev/null | head -n 20; echo ---; ls /dev/dri 2>/dev/null || echo no-dri"),
    ("44_overlay_errors", "dmesg 2>/dev/null | grep -iE 'overlay|OF:.*(error|failed)|dtb|firmware' | head -n 40"),
    ("45_csi_compat", f"for n in csi@110000 csi@128000 i2c@80000 i2c@88000; do printf '%s: ' $n; tr -d '\\0' < {RP1}/$n/compatible 2>/dev/null; echo; done"),
    ("46_csi_reg", f"for n in csi@110000 csi@128000; do printf '%s reg=' $n; od -An -tx4 {RP1}/$n/reg 2>/dev/null | tr -s ' '; done"),
    ("47_aliases", "for a in csi0 csi1 i2c_csi_dsi i2c_csi_dsi0 i2c_csi_dsi1; do printf '%s: ' $a; tr -d '\\0' < /proc/device-tree/aliases/$a 2>/dev/null; echo; done"),
    ("48_cfe_module", "ls /sys/module | grep -iE 'cfe|unicam|pisp|rp1' ; echo ---; modinfo rp1_cfe 2>&1 | head -n 5"),
    ("49_camera_pkgs", "ls /usr/bin | grep -iE 'rpicam|libcamera' | head -n 20"),
    ("50_dt_csi_context", f"dtc -I fs -O dts /proc/device-tree 2>/dev/null | sed -n '2380,2420p'"),
    ("51_i2c_csi_nodes", f"ls {RP1}/i2c@80000 {RP1}/i2c@88000 2>/dev/null"),
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
        admin.put(f"/api/sessions/{args.session}/control", json={"owner": "human"})
        admin.close()

    (out / "report3.json").write_text(
        json.dumps({"results": results, "failures": failures}, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    print(f"\n{len(COMMANDS) - len(failures)}/{len(COMMANDS)} probes captured")
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
