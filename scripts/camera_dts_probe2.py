"""Second, deeper camera probe: overlay application, CSI status, I2C, drivers."""

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
    ("20_chosen_overlays", "ls /proc/device-tree/chosen/overlays 2>/dev/null || echo none"),
    (
        "21_chosen_overlay_params",
        "for f in /proc/device-tree/chosen/overlays/*; do [ -f \"$f\" ] || continue; "
        "printf '%s = ' \"$(basename \"$f\")\"; tr -d '\\0' < \"$f\"; echo; done 2>/dev/null | head -n 40",
    ),
    ("22_vcgencmd_camera", "vcgencmd get_camera 2>&1 || echo no-vcgencmd"),
    ("23_vcgencmd_version", "vcgencmd version 2>&1 | head -n 2"),
    ("24_csi0_status", f"tr -d '\\0' < {RP1}/csi@110000/status 2>/dev/null; echo"),
    ("25_csi1_status", f"tr -d '\\0' < {RP1}/csi@128000/status 2>/dev/null; echo"),
    ("26_i2c_csi_status", f"tr -d '\\0' < {RP1}/i2c@80000/status 2>/dev/null; echo"),
    ("27_i2c_csi0_status", f"tr -d '\\0' < {RP1}/i2c@88000/status 2>/dev/null; echo"),
    ("28_csi0_children", f"ls {RP1}/csi@110000 2>/dev/null; echo ---; ls {RP1}/csi@128000 2>/dev/null"),
    ("29_reg_names", "for n in cam0_reg cam1_reg cam_dummy_reg cam0_clk cam1_clk; do printf '%s: ' $n; tr -d '\\0' < /proc/device-tree/$n/regulator-name 2>/dev/null || tr -d '\\0' < /proc/device-tree/$n/clock-output-names 2>/dev/null; echo; done"),
    ("30_i2c_devices", "for d in /sys/bus/i2c/devices/*; do printf '%s ' \"$(basename $d)\"; cat \"$d/name\" 2>/dev/null; done | head -n 40"),
    ("31_dmesg_rp1", "dmesg 2>/dev/null | grep -iE 'rp1.*(i2c|csi|cfe|pio)|cfe|unicam|imx|ov5647|ov9281|i2c-designware' | head -n 50"),
    ("32_libcamera_version", "rpicam-hello --version 2>&1 | head -n 3"),
    ("33_packages", "dpkg -l 2>/dev/null | grep -iE 'libcamera|rpicam|v4l2|i2c-tools' | awk '{print $2, $3}' | head -n 20"),
    ("34_media_ctl", "if command -v media-ctl >/dev/null; then media-ctl -p -d /dev/media0 2>&1 | head -n 40; else echo no-media-ctl; fi"),
    ("35_i2cdetect", "if command -v i2cdetect >/dev/null; then for b in 13 14; do echo \"== i2c-$b\"; i2cdetect -y $b 2>&1 | tail -n 9; done; else echo no-i2cdetect; fi"),
    (
        "36_boot_config_extra",
        "ls /boot/firmware/ 2>/dev/null | head -n 30; echo ---; "
        "for f in /boot/firmware/config.txt /boot/firmware/firmware_config.txt; do [ -f $f ] && echo \"== $f\" && wc -l $f; done",
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

    (out / "report2.json").write_text(
        json.dumps({"results": results, "failures": failures}, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    print(f"\n{len(COMMANDS) - len(failures)}/{len(COMMANDS)} probes captured")
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
