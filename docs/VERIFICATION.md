# Verification report

**Result: all automated suites pass on Windows 10 x64.**

| Suite | Result | Artifact |
|---|---|---|
| `pytest` (unit + integration + protocol + security + HIL) | **94 passed, 1 skipped** | `pytest -q` |
| End-to-end: real server process, MCP, serial I/O, reconnection, browser UI | **41 / 41 checks** | `artifacts/e2e/report.json` |
| ttyd browser terminal (real ConPTY, real ttyd 1.7.7) | **13 / 13 checks** | `artifacts/ttyd/report.json` |
| Packaged PyInstaller binaries (server + shim) | **11 / 11 checks** | `artifacts/packaged/report.json` |
| **Live hardware**: Raspberry Pi over a Debug Probe UART | **46 / 46 checks** | [`live-debug-report.md`](./live-debug-report.md) |
| **Live agent path**: MCP stdio client (DSH's client) on the Pi shell | **24 / 24 checks** | `artifacts/live-shell/report.json` |
| **Terminal tab**: xterm.js in the built SPA, typed on the real Pi | **3 / 3 checks** (CDP) | `docs/screenshots/10-terminal-tab.png` |

The skipped test is the HIL "open a real COM port" case while the live
debugging server holds `COM5` exclusively (expected; it passed in the earlier run).

## Environment

| Item | Value |
|---|---|
| OS | Windows 10 家庭版 10.0.19045 (x64) |
| Python | 3.12.14 (venv) |
| Node / npm | 22.14.0 |
| ttyd | 1.7.7 (`ttyd.win32.exe`, SHA-256 `e33a2750…832b37`, matches release `SHA256SUMS`) |
| Browser (automation) | Google Chrome, headless, driven over CDP |
| Hardware | 2 real COM ports (Bluetooth SPP: COM3, COM4); no USB-UART board attached |

## What was executed

### 1. Test suite (`pytest`, 94 passed + 1 skipped)

* **Unit** — ring buffer cursors/gap/wrap/timestamps, config validation/round-trip/atomic
  save, Argon2 + cookie + CSRF + origin + login limiter, transcript rotation
  and redaction.
* **Integration** — session state machine, reader/writer arbitration of
  `control_owner`, permissions, `serial_command` (expect/regex/timeout/settle),
  unplug→reconnect with the buffer preserved, reset sequence; MCP tools called
  through `MCPServer` with schema/annotation checks and structured errors; HTTP
  API + CSRF + WebSockets; MCP end-to-end over Streamable HTTP.
* **Protocol** — raw JSON-RPC `initialize` / `notifications/initialized` /
  `tools/list` / `tools/call` (SSE responses), `Mcp-Session-Id` handling,
  `outputSchema` and annotations on all six tools.
* **Security** — auth required on every admin route, forged cookie, strict bearer
  token, foreign `Origin`, CSRF, payload cap, path traversal, regex DoS
  (catastrophic pattern bounded by the 500 ms matcher timeout), pattern-length
  cap, WS origin rejection.
* **HIL** — real COM port open/configure/control-lines/read-timeout/close via
  pyserial (`COM3`), plus the pyserial `loop://` transport.

### 2. End-to-end (`scripts/verify_e2e.py`, 41 checks)

Starts `tio-server` as a **separate process** with a simulated board
(`sim://board-a`), then:

* admin login; auto-opened session; banner captured in the ring buffer;
* human `command` with `expect` over the simulated UART;
* MCP `initialize`, `tools/list` (exactly six tools, schemas + annotations),
  `serial_sessions`, `serial_read`, `serial_write`, `serial_command`;
* `WRITE_LOCKED` while the human owns control; allowed after handover;
  `WRITE_DISABLED` after removing the permission; `RATE_LIMITED` path;
* cursor semantics (`gap=false`, `head_cursor` monotonic);
* unplug/replug (`reboot` command) → `reconnecting` → `open`, `reconnect_count≥1`,
  buffer retained;
* unauthorised MCP request → 401, foreign `Origin` → 403, traversal → 404;
* transcript contains RX bytes with offsets and lengths; audit contains
  `session.open` / `session.control_owner`;
* SPA index + hashed JS bundle served by the server;
* **browser UI** (headless Chrome over CDP): login screen, login through the real
  API, sessions page, **create-session dialog** (typed, submitted, session
  appears open), terminal page with LIVE RX and STATUS, hand control to the agent
  and take it back, type `ping` into xterm and see `pong`, **toggle light/dark
  theme** (and back), **MCP page** (status, endpoint, seven tools, install
  prompt), configuration/logs/system pages render, no JS console errors.

The `/api/mcp` status endpoint is covered by its own pytest case: auth required,
Streamable HTTP URL, bearer mode, token/shim paths, and the seven-tool list.

Screenshots: [`01-login`](screenshots/01-login.png) ·
[`02-sessions`](screenshots/02-sessions.png) ·
[`03-terminal`](screenshots/03-terminal.png) ·
[`04-terminal-command`](screenshots/04-terminal-command.png) ·
[`05-config`](screenshots/05-config.png) ·
[`06-logs`](screenshots/06-logs.png) ·
[`07-system`](screenshots/07-system.png) ·
[`08-mcp`](screenshots/08-mcp.png) ·
[`11-light-sessions`](screenshots/11-light-sessions.png) ·
[`12-light-terminal`](screenshots/12-light-terminal.png)

### 3. ttyd (`scripts/ttyd_check.py`, 13 checks)

The server is started with `ttyd.enabled=true`; the **supervisor** (not the test)
allocates ports, builds the bridge command and launches both entries:

* entries start for a session configured at boot, and the session API exposes
  `terminal.view_url` / `terminal.control_url`;
* page served; `xterm`/ttyd assets present;
* device boot banner reaches the browser terminal;
* typed bytes reach the simulated UART and the `help` output returns (raw bytes
  through ConPTY);
* `Ctrl-C` forwarded as `0x03` and the bridge stays alive;
* basic-auth control entry: `401` without credentials, `200` with them;
* creating a session through the API auto-starts its entries and the new terminal
  is reachable;
* deleting the session stops those entries again.

This clears the plan's **P0 Windows ttyd go/no-go**.

### 3b. In-app Terminal tab (xterm.js + CDP)

`scripts/ui-shot.mjs --send "uname -r"` drives the real built SPA in headless
Chrome: it logs in, opens `#/terminal/board`, focuses the xterm helper textarea,
inserts the text, presses Enter over the DevTools protocol, then reads the
rendered terminal rows back.

* the terminal renders the live prompt (`root@raspberry:~#`);
* keystrokes go through `POST /api/sessions/board/write` to the real UART;
* the device output comes back over `/ws/console` and is rendered by xterm:
  `uname -r` → `6.18.39+rpt-rpi-2712`.

The surrounding API behaviour is covered by pytest (94 tests): `serial_break`
(control gate + duration), raw log export (`txt`/`hex`, timestamps), and
cursor-resumed console subscriptions (no replay of old bytes, catch-up only
after the cursor). The build was also checked with the **Keys** panel open
(browser-reserved shortcut help), the **STATUS** panel, and the **LIVE RX**
bar (received bytes, auto-scroll, clear).

Screenshot: [`10-terminal-tab`](screenshots/10-terminal-tab.png).

### 4. Packaged binaries (`scripts/verify_packaged.py`, 11 checks)

`PyInstaller` artifacts (`tio-server.exe` onedir, `tio-mcp.exe`,
`tio-web-bridge.exe` onefile):

* packaged `init` writes config + one-time credentials;
* packaged server starts, serves the **bundled SPA and assets**, login works;
* auto-open session and a serial command;
* MCP `initialize` over HTTP;
* **packaged `tio-mcp.exe`** speaks stdio MCP to the packaged server and returns
  `serial_status` structured content.

### 5. Live hardware run (`scripts/live_debug.py`, 46 checks)

A real Raspberry Pi serial console was attached through a Raspberry Pi Debug
Probe (`2E8A:000C`, CMSIS-DAP + CDC-ACM UART) on `COM5` — target:
`Debian GNU/Linux 13 raspberry ttyAMA10`, 115200 8N1, prompt `raspberry login:`.

Everything was exercised against the live port: open/close/reopen, control
lines, text/hex/chunked writes, cursor reads, `serial_command` with
`expect="login:"` matching the real prompt in 15 ms, all six MCP tools through
the packaged `tio-mcp.exe`, control-owner and permission arbitration, ttyd
entries (HTTP + raw WebSocket), baud change/reopen, transcript/audit, and the
DTR/RTS reset sequence.

Details, including the DTR-gating behaviour of the probe and the three product
fixes it forced, are in [`live-debug-report.md`](./live-debug-report.md).
Screenshot: [`10-terminal-tab`](screenshots/10-terminal-tab.png).

### 6. Agent path over MCP stdio (`scripts/live_shell_debug.py`, 24 checks)

The packaged `tio-mcp.exe` was driven through the **official MCP SDK stdio
client** — the same client `@deepseek-ai/dsh-mcp-client` uses — against a
Raspberry Pi 5 root shell over the same serial port. It ran `uname -a`,
`/etc/os-release`, `/proc/cpuinfo`, `uptime`, `free -m`, `df -h /`,
`ip -br addr`, `systemctl --failed` and `dmesg | tail`, then exercised cursor
continuity, a no-match timeout, permission removal (`WRITE_DISABLED`) and
control handover/return. `capture_exit: true` (generic POSIX end marker) returned
exit codes `0`/`2`, handled a 1 s command and a heredoc, and never matched the
console echo, and serial_break sent a 100 ms framing BREAK. 24/24 checks passed.

The DSH integration row is documented in [`dsh.md`](./dsh.md); a newly inserted
plugin row is only composed after the DSH app restarts.

## Plan acceptance criteria (plan §14.3)

| Criterion | Status | Evidence |
|---|---|---|
| Linux and Windows installers install/uninstall/autostart | ⚠️ partially verified | Windows: PyInstaller build + service scripts + Inno script (Inno not executed on this machine: toolchain absent). Linux: unit files/install script written, not executed here. |
| UI selects port/baud and opens a session | ✅ | browser CDP check "session created from the dialog is listed and open" |
| Real device end to end | ✅ | live run 46/46 + agent-path MCP run 24/24 on a Raspberry Pi 5 shell through a Debug Probe |
| Agent lists sessions, reads logs, runs commands with structured results | ✅ | MCP e2e checks + protocol tests |
| Browser ttyd sees the same RX; operator can type after authorisation | ✅ | ttyd 13/13 (banner, `help`, Ctrl-C, auth, auto-start/stop) |
| ttyd raw bytes on Windows and Linux | ✅ Windows, ⏳ Linux | Windows ConPTY verified; Linux termios path implemented, not run here |
| `control_owner` switch blocks/allows agent writes | ✅ | integration + UI + MCP checks |
| Replug reconnects, cursor continues, gap reported | ✅ | reconnect test, gap unit tests, HIL enumeration |
| Config changes never leave a half-open state | ✅ | config validation + update/reopen path tests |
| Unauthenticated/unauthorised/illegal port requests rejected + audited | ✅ | security suite (10 tests) |
| 24 h soak without leaks/data loss | ⚠️ not run | short connection/soak behaviour only; no 24 h run in this environment |
| Docs for install/config/MCP/ttyd/troubleshooting | ✅ | `docs/install.md`, `mcp.md`, `ttyd.md`, `architecture.md` |

## Defects found and fixed during verification

1. **`serial_command` without `expect` duplicated output and ran until timeout.**
   The loop re-read from a fixed cursor every iteration; fixed to advance the
   cursor (regression test `test_command_without_expect_settles_once`).
2. **The removed chat console crashed rendering an assistant message** because a
   copy button used a part-scoped hook at message level; moot after the console
   was replaced by the xterm.js terminal (ADR-012).
3. **`/mcp` answered 307** (trailing-slash redirect) which some clients do not
   follow; fixed with an ASGI path rewrite.
4. **Admin write endpoint did not enforce `max_write_bytes_per_call`**; now
   rejected with `INVALID_ARGUMENT`.
5. **Build output crashed on GBK consoles** (`⇄` in a CLI description, non-UTF-8
   stdout); descriptions are ASCII and the CLI/shim force UTF-8 stdio.
6. **A write timeout tore down the session** (found on live hardware): a stalled
   USB write raised `Disconnected` and triggered a reconnect. Now a
   `WriteTimeout` reports the bytes actually written and keeps the port open;
   a 0-byte write is an explicit `TIMEOUT` error instead of a successful write.
7. **Reset left DTR low, which stalls some probes' TX pipe.** The reset sequence
   now restores the pre-reset line state (Raspberry Pi Debug Probe stops
   draining USB while DTR is low; writes recovered immediately on DTR high).

## How to reproduce

```powershell
# 1. dependencies
python -m venv .venv
.venv\Scripts\python -m pip install -e ".[dev]"
npm --prefix frontend ci ; npm --prefix frontend run build

# 2. tests
.venv\Scripts\python -m pytest -q

# 3. server + MCP + UI (needs Chrome or Edge)
.venv\Scripts\python scripts\verify_e2e.py

# 4. ttyd (put ttyd.exe 1.7.7 in tools\ttyd\)
.venv\Scripts\python scripts\ttyd_check.py

# 5. packaged binaries (after packaging/pyinstaller/build.ps1)
.venv\Scripts\python scripts\verify_packaged.py

# 6. live hardware (device attached, server running with a session)
.venv\Scripts\python scripts\live_debug.py --session board

# 7. agent path over MCP stdio against a logged-in shell
.venv\Scripts\python scripts\live_shell_debug.py --session board

# or everything in one go
powershell -ExecutionPolicy Bypass -File scripts\verify_release.ps1
```

## Not verified (explicit)

* Linux runtime behaviour (termios backend, systemd unit, `dialout`): code and CI
  matrix exist, but no Linux host was available for this run. The POSIX backend
  is import-checked and unit-covered where platform-independent.
* RS-485, mark/space parity, arbitrary baud on real drivers: implemented in the
  POSIX backend, requires hardware to confirm.
* FTDI/CP210x/CH340 adapter matrix and per-driver DTR/RTS reset behaviour. One
  real device was tested end to end — a Raspberry Pi Debug Probe (`2E8A:000C`)
  with a Raspberry Pi 5 shell — but that does not cover other bridge chips.
* Destructive real-device operations (reboot, file writes, flashing) and
  high-baud soak on the shared console; the live shell run used read-only commands.
* DSH hot-loading of a newly inserted MCP plugin row (it is loaded after the app
  restarts; the same stdio client was verified directly).
* Inno Setup executable, Authenticode signing, Windows Service registration on a
  clean machine, Linux `.deb`/`.rpm` packages.
* 24 h soak and multi-hour high-baud throughput.
* Remote access behind TLS/OIDC (loopback-only by default).
