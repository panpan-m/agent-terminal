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
| Target | Raspberry Pi, `Debian GNU/Linux 13 raspberry ttyAMA10` |
| Target console | serial getty at 115200 8N1, prompt `raspberry login:` |
| Target IP | `192.168.124.23`, `fe80::2ecf:67ff:fe2a:93b7` |

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

No username or password was typed: writes were bare Enter presses (`\r`) so the
getty simply reprinted its prompt. The console history still contains three
failed login attempts from the first exploratory run (see below).

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

## What is still blocked

Logging in to the target needs its **username and password**. Once provided, the
following can run over the same serial session (no code changes needed):

```bash
# operator console (assistant-ui) or MCP serial_command
login: <user>
Password: <pass>
uname -a; ip addr; systemctl --failed; dmesg | tail
```

After login the same session can demo `serial_command` with `expect="$ "` and
`serial_read` cursors on real shell output. Until then the login prompt itself
is already a real, matched end-to-end signal.

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
