# Live hardware debugging report

Date: 2026-10-21 · Host: Windows 10 19045 · Device: Raspberry Pi Debug Probe
(`USB\VID_2E8A&PID_000C`) with a Raspberry Pi target on its UART.

Result: **46 / 46 live checks passed** (`artifacts/live/report.json`),
screenshot: [`screenshots/08-live-console.png`](./screenshots/08-live-console.png).

## Hardware under test

| Item | Value |
|---|---|
| Probe | Raspberry Pi Debug Probe (CMSIS-DAP v2 + CDC-ACM UART), USB `2E8A:000C`, serial `E6633861A353172C` |
| Windows port | `COM5`, USBSER, no by-id path |
| Target | Raspberry Pi 5 Model B Rev 1.0, `Debian GNU/Linux 13 (trixie)`, kernel `6.18.39+rpt-rpi-2712` aarch64 |
| Target console | serial getty at 115200 8N1; later a logged-in `root@raspberry:~#` shell |
| Target resources | 8 GB RAM, 117 GB `/dev/mmcblk0p2`, `wlan0` `192.168.124.23` (eth0 down) |

COM5 is the probe's **UART bridge**, not the Pi's own USB-CDC. A "silent" port
therefore means the target is not printing on the probe's RX pin (or the target
is off), not a gateway failure.

## What was exercised on real hardware

| Area | Checks |
|---|---|
| Session | open, close, reopen, state, port, serial parameters, device metadata |
| Lines | read DTR/RTS/CTS/DSR/CD/RI, assert, release, re-assert |
| Writes | text+CR, hex `0d`, chunked (`chunk_size=1`), TX counters |
| Reads | absolute cursors, transcript RX/TX records |
| Command | `serial_command` with `expect="login:"` matched the **real prompt** in 15 ms |
| MCP | packaged `tio-mcp.exe`: initialize, six tools, sessions/status/read/expect/write/command on `COM5` |
| Arbitration | agent write refused for human (`WRITE_LOCKED`), human write refused while agent owns control, permission removal → `WRITE_DISABLED` |
| ttyd | both entries started, view 200, control 401/200 with basic auth, raw WebSocket keystroke delivered, target prompt returned |
| Config | baud 115200 → 9600 → 115200 reopened the session each time |
| Audit/logs | `session.open`, `session.control_owner`, `session.lines`, `ttyd.start`, transcript TX records |
| Reset | DTR/RTS sequence applied, line state restored, writes still work afterwards |

No username or password was typed by the test: writes were bare Enter presses
(`\r`) so the getty simply reprinted its prompt. The console history still
contains three failed login attempts from the first exploratory run (see below).
The operator later logged in at the console, which allowed the agent-path run
below.

## Agent path over MCP (same client DSH uses)

`scripts/live_shell_debug.py` speaks to the packaged `tio-mcp.exe` through the
official MCP SDK stdio client — exactly what `@deepseek-ai/dsh-mcp-client`
spawns — and ran **23/23** checks against the root shell:

| Check | Result |
|---|---|
| MCP initialize / six tools | `tio-server 0.1.0`, `2025-11-25`, six tools |
| prompt detection | regex `root@…:~# ` matched history |
| `uname -a` | `Linux raspberry 6.18.39+rpt-rpi-2712 #1 SMP PREEMPT … aarch64` |
| `/etc/os-release` | `Debian GNU/Linux 13 (trixie)` |
| `/proc/cpuinfo` | `Raspberry Pi 5 Model B Rev 1.0` |
| `uptime` / `free -m` | up 21 min, 3 users; 8062 MB RAM |
| `df -h /` | `/dev/mmcblk0p2 117G 9.7G 103G 9% /` |
| `ip -br addr` | `wlan0 UP 192.168.124.23/24`, `eth0 DOWN` |
| `systemctl --failed` | `0 loaded units listed` |
| `dmesg \| tail` | BCM54213PE PHY, brcmfmac `_send_action_frame` warning |
| cursor read after burst | `gap=false`, head advanced |
| `capture_exit` success / failure | exit `0`, exit `2` (real `ls` failure) |
| `capture_exit` slow command | `sleep 1` returned after 1031 ms, exit `0` |
| `capture_exit` heredoc | multi-line input intact, exit `0` |
| no-match command | `timed_out=true`, no error |
| permission removal | `WRITE_DISABLED` |
| control handover/return | agent wrote, then control returned to `human` |

Screenshot: [`screenshots/09-live-shell.png`](./screenshots/09-live-shell.png).

This is also the documented DSH integration path: see
[`dsh.md`](./dsh.md) for the `dsh-mcp-client` profile row. A new plugin row only
loads after the DSH app restarts, so the current session used the same stdio
client directly.

## Findings and product fixes

### 1. DTR low stalls the probe's TX pipe (driver/firmware behaviour)

Reproduced deterministically:

```
DTR=low  -> write "\r" -> bytes_written=0 after the 2 s write timeout (repeatable, >5 s)
DTR=high -> write "\r" -> bytes_written=1 immediately
```

The Debug Probe stops draining its USB OUT endpoint while DTR is deasserted, so
writes block until the timeout. RTS makes no difference.

Fixes made because of this:

* **A write timeout is no longer treated as a disconnect.** `WriteTimeout`
  carries the number of bytes actually written; the session stays open (plan §7.3
  behaviour). Previously one stalled write tore down the session and triggered
  a reconnect.
* **A 0-byte write is an explicit `TIMEOUT` error** instead of a `200` with
  `bytes_written: 0`, so operators and agents cannot mistake a stalled port for
  a successful write.
* **The reset sequence restores the pre-reset line state.** The default sequence
  ends with `dtr=false`, which on this probe leaves the port unable to transmit;
  after the change, Reset leaves DTR as it was and writes keep working.

### 2. Probe identity

The port is `2E8A:000C` (Raspberry Pi Debug Probe), not a Pico USB-CDC. The
target Pi's console appears at 115200; the probe's UART is fixed to that rate in
practice (changing `baudrate` on the host does not change the wire rate).

### 3. First exploratory run

Before the identity was known, three writes were interpreted by getty as
usernames (`agent-ping`, `ok`, and a ttyd keystroke), producing
`Login incorrect`. The session history shows this; it is harmless but explains
the `Last failed login`-style lines.

## Deliberately not done

The shell session was used for **read-only** commands. The run did not reboot or
reconfigure the Pi, did not write files on it, and did not run throughput/soak
tests (a shared console would disturb the operator). Flashing/debugging over
SWD (CMSIS-DAP) is outside the gateway's scope: tio-server only owns the UART.

The DSH plugin row needs an app restart to appear as `mcp__tio__*`; that is a
property of DSH's profile composition, not of this server.

## How to reproduce

```powershell
# live server (already running during the test)
.\.venv\Scripts\tio-server.exe run --config C:\serial_mcp\run\config.toml

# full live suite (46 checks)
.\.venv\Scripts\python scripts\live_debug.py --session board

# UI screenshot of the real session
node scripts\ui-shot.mjs --url http://127.0.0.1:8765 `
  --password <admin> --hash "#/console/board" --out artifacts\live\console.png
```
