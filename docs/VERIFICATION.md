# Verification report

**Result: all automated suites pass on Windows 10 x64.**

## Update — agent-first control model (2026-11-16)

Sessions default to `control = "agent"` (ADR-017): the agent writes with no
hand-off, the operator terminal is a read-only audit view, and a single serial
session is auto-bound to MCP. Re-verified on the same machine:

| Suite | Result |
|---|---|
| `pytest -q` | **142 passed** (was 106 passed + 1 skipped) |
| `scripts/verify_control_model.py --port sim://board-a` | **21 / 21 checks** |
| `scripts/verify_control_model.py --port COM5 --baud 115200` | **21 / 21 checks** |

The new checks assert, against a live server: one session auto-binds and
`tools/list` returns 8 serial tools; the agent writes and reads back with no
`control_owner` hand-off; operator `write` / `command` / `break` and
`PUT /control` all return `403 READ_ONLY`; and the same write still appears in
`/api/mcp/audit` (with the client identity and the exact bytes) plus the
transcript export, which is what the operator sees in the web UI.

Observed on `COM5` in this run: the port opens and accepts the agent's 21-byte
write, but the attached device emitted no RX during the probe, so the read-back
was empty. That is a property of the hardware on the bench, not of the access
model — the same script returns 21/21 on the simulator with live echo.

The tables below describe the earlier build and are kept as the historical
record.

## Update — architecture fixes (2026-11-16, ADR-018)

Four invariants that the docs claimed but the code did not enforce. Re-verified
on the same machine:

| Fix | Evidence |
|---|---|
| MCP tool bodies run on worker threads, not the event loop | `probe_event_loop_blocking.py`: `/healthz` behind an 8 s `serial_read` went **7125 ms → 63 ms** (and 6 s wait → 47 ms). Pinned by `tests/unit/test_tool_offload.py`. |
| Subscriber queues are actually bounded and shared | `Subscriber(maxsize=4)` held 20000 items with 0 drops before; now `q.maxsize=4`, drops counted, one `overflow` notice delivered. `tests/unit/test_streaming.py`. |
| MCP tool calls are written to the durable audit file | `tests/integration/test_audit.py`; the E2E probe's `/api/audit` now shows `mcp.tool_call` records that were absent before. |
| Off-loopback bind requires the API token | `tests/security/test_control_plane_auth.py` (9 checks: no token → 401, token → 200, `?token=` → 200, wrong token → 401, WS gated). |
| Rate limit covers the admin write path | `tests/security/test_rate_limit_paths.py`. |
| `pytest -q` | **167 passed** |

`scripts/verify_control_model.py` still reports **21 / 21** on both
`sim://board-a` and the real `COM5`.

## Update — structural debt P3/P4 (2026-11-16, ADR-019)

| Item | Before | After | Guard |
|---|---|---|---|
| Streaming core duplicated across transports | `subscribe`/`unsubscribe`/`_broadcast_status`/fan-out written twice (and the queue bug copied with it) | one `streaming.StreamSession` base, both transports inherit | `tests/unit/test_streaming.py` |
| Ring chunk metadata | one tuple per append, unbounded in append count | merged above `max(64, capacity/4096)`; 8 MiB ring keeps 2048 | `tests/unit/test_ring_bounds.py` |
| Process exclusivity | POSIX kernel only; Windows convention | `SingleInstanceLock` on both, second start exits 3 | `tests/unit/test_single_instance.py` (incl. cross-process) |
| `pytest -q` | 167 passed | **178 passed** | |

Re-verified end to end: `probe_event_loop_blocking.py` stayed responsive
(79 ms behind a 5 s wait) and `verify_control_model.py` returned **21 / 21** on
both the simulator and `COM5`.

| Suite | Result | Artifact |
|---|---|---|
| `pytest` (unit + integration + protocol + security + HIL) | **106 passed, 1 skipped** | `pytest -q` |
| End-to-end: real server process, MCP, serial I/O, reconnection, browser UI | **37 / 37 checks** | [`docs/reports/e2e.json`](./reports/e2e.json) |
| Packaged PyInstaller binaries (server + shim) | **11 / 11 checks** | [`docs/reports/packaged.json`](./reports/packaged.json) |
| **Live hardware**: Raspberry Pi over a Debug Probe UART | **46 / 46 checks** | [`live-debug-report.md`](./live-debug-report.md) |
| **Live agent path**: MCP stdio client (DSH's client) on the Pi shell | **25 / 25 checks** | [`docs/reports/live-shell.json`](./reports/live-shell.json) |
| **Terminal tab**: xterm.js in the built SPA, typed on the real Pi | **3 / 3 checks** (CDP) | `docs/screenshots/10-terminal-tab.png` |

The skipped test is the HIL "open a real COM port" case while the live
debugging server holds `COM5` exclusively (expected; it passed in the earlier run).

## Environment

| Item | Value |
|---|---|
| OS | Windows 10 家庭版 10.0.19045 (x64) |
| Python | 3.12.14 (venv) |
| Node / npm | 22.14.0 |
| Browser (automation) | Google Chrome, headless, driven over CDP |
| Hardware | 2 real COM ports (Bluetooth SPP: COM3, COM4); no USB-UART board attached |

## What was executed

### 1. Test suite (`pytest`, 106 passed + 1 skipped)

* **Unit** — ring buffer cursors/gap/wrap/timestamps, config validation/round-trip/atomic
  save, Argon2 token checks + origin allow-list, transcript rotation
  and redaction.
* **Integration** — session state machine, reader/writer arbitration of
  `control_owner`, permissions, `serial_command` (expect/regex/timeout/settle),
  unplug→reconnect with the buffer preserved, reset sequence; MCP tools called
  through `MCPServer` with schema/annotation checks and structured errors; HTTP
  API + WebSockets; MCP end-to-end over Streamable HTTP.
* **Protocol** — raw JSON-RPC `initialize` / `notifications/initialized` /
  `tools/list` / `tools/call` (SSE responses), `Mcp-Session-Id` handling,
  `outputSchema` and annotations on all fifteen tools.
* **Security** — open `/api` rejects foreign `Origin` and foreign `Host`,
  strict MCP bearer token, payload cap, path traversal, regex DoS
  (catastrophic pattern bounded by the 500 ms matcher timeout), pattern-length
  cap, WS origin rejection.
* **HIL** — real COM port open/configure/control-lines/read-timeout/close via
  pyserial (`COM3`), plus the pyserial `loop://` transport.

### 2. End-to-end (`scripts/verify_e2e.py`, 38 checks)

Starts `agent-terminal` as a **separate process** with a simulated board
(`sim://board-a`), then:

* auto-opened session reachable without login; banner captured in the ring
  buffer;
* human `command` with `expect` over the simulated UART;
* MCP `initialize`, `tools/list` (exactly fifteen tools, schemas + annotations),
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
* **browser UI** (headless Chrome over CDP): sessions page renders directly
  (no login), **create-session dialog** (typed, submitted, session
  appears open), terminal page with LIVE RX and STATUS, hand control to the agent
  and take it back, type `ping` into xterm and see `pong`, **toggle light/dark
  theme** (and back), **MCP page** (status, endpoint, fifteen tools, install
  prompt), configuration/logs/system pages render, no JS console errors.

The `/api/mcp` status endpoint is covered by its own pytest case: open without
login, Streamable HTTP URL, bearer mode, token/shim paths, and the fifteen-tool
list.

Screenshots: [`02-sessions`](screenshots/02-sessions.png) ·
[`03-terminal`](screenshots/03-terminal.png) ·
[`04-terminal-command`](screenshots/04-terminal-command.png) ·
[`06-logs`](screenshots/06-logs.png) ·
[`08-mcp`](screenshots/08-mcp.png) ·
[`11-light-sessions`](screenshots/11-light-sessions.png) ·
[`12-light-terminal`](screenshots/12-light-terminal.png)

### 3b. In-app Terminal tab (xterm.js + CDP)

`scripts/ui-shot.mjs --send "uname -r"` drives the real built SPA in headless
Chrome: it logs in, opens `#/terminal/board`, focuses the xterm helper textarea,
inserts the text, presses Enter over the DevTools protocol, then reads the
rendered terminal rows back.

* the terminal renders the live prompt (`root@raspberry:~#`);
* keystrokes go through `POST /api/sessions/board/write` to the real UART;
* the device output comes back over `/ws/console` and is rendered by xterm:
  `uname -r` → `6.18.39+rpt-rpi-2712`.

The surrounding API behaviour is covered by pytest (106 tests): `serial_break`
(control gate + duration), raw log export (`txt`/`hex`, timestamps), and
cursor-resumed console subscriptions (no replay of old bytes, catch-up only
after the cursor). The build was also checked with the **Keys** panel open
(browser-reserved shortcut help), the **STATUS** panel, and the **LIVE RX**
bar (received bytes, auto-scroll, clear).

Screenshot: [`10-terminal-tab`](screenshots/10-terminal-tab.png).

### 4. Packaged binaries (`scripts/verify_packaged.py`, 11 checks)

`PyInstaller` artifacts (`agent-terminal.exe` onedir, `agent-mcp.exe`,
`tio-web-bridge.exe` onefile):

* packaged `init` writes config + one-time credentials;
* packaged server starts, serves the **bundled SPA and assets**, `/api` answers without login;
* auto-open session and a serial command;
* MCP `initialize` over HTTP;
* **packaged `agent-mcp.exe`** speaks stdio MCP to the packaged server and returns
  `serial_status` structured content.

### 5. Live hardware run (`scripts/live_debug.py`, 46 checks)

A real Raspberry Pi serial console was attached through a Raspberry Pi Debug
Probe (`2E8A:000C`, CMSIS-DAP + CDC-ACM UART) on `COM5` — target:
`Debian GNU/Linux 13 raspberry ttyAMA10`, 115200 8N1, prompt `raspberry login:`.

Everything was exercised against the live port: open/close/reopen, control
lines, text/hex/chunked writes, cursor reads, `serial_command` with
`expect="login:"` matching the real prompt in 15 ms, all eight serial MCP tools through
the packaged `agent-mcp.exe`, control-owner and permission arbitration, baud
change/reopen, transcript/audit, and the
DTR/RTS reset sequence.

Details, including the DTR-gating behaviour of the probe and the three product
fixes it forced, are in [`live-debug-report.md`](./live-debug-report.md).
Screenshot: [`10-terminal-tab`](screenshots/10-terminal-tab.png).

### 6. Agent path over MCP stdio (`scripts/live_shell_debug.py`, 24 checks)

The packaged `agent-mcp.exe` was driven through the **official MCP SDK stdio
client** — the same client `@deepseek-ai/dsh-mcp-client` uses — against a
Raspberry Pi 5 root shell over the same serial port. It ran `uname -a`,
`/etc/os-release`, `/proc/cpuinfo`, `uptime`, `free -m`, `df -h /`,
`ip -br addr`, `systemctl --failed` and `dmesg | tail`, then exercised cursor
continuity, a no-match timeout, permission removal (`WRITE_DISABLED`) and
control handover/return. `capture_exit: true` (generic POSIX end marker) returned
exit codes `0`/`2`, handled a 1 s command and a heredoc, and never matched the
console echo, serial_break sent a 100 ms framing BREAK, and serial_tail returned
the newest lines including the root prompt. 25/25 checks passed.

The DSH integration row is documented in [`dsh.md`](./dsh.md); a newly inserted
plugin row is only composed after the DSH app restarts.

### 14. Login-free rework (this build)

The admin account, login page, cookie sessions, CSRF and the login rate
limiter were removed; the product is now a local terminal tool plus MCP
service:

1. `pytest` — **106 passed, 1 skipped**: new security cases reject a foreign
   `Origin` (HTTP + WS) and a foreign `Host` on `/api`; the MCP bearer-token
   checks are unchanged;
2. `scripts/verify_e2e.py` — **37/37 checks** against a fresh server process:
   the SPA opens straight into the sessions page (no login), the full browser
   flow (dialog, terminal, control handover, xterm typing, theme, MCP page)
   passes, and the MCP endpoint still demands a bearer token;
3. `init` now prints only the MCP API token; old `config.toml` files with
   `admin_*`/`session_*`/`[ttyd]` fields still load (unknown keys are ignored);
4. the MCP `TransportSecuritySettings` DNS-rebinding allow-list is unchanged.

## Plan acceptance criteria (plan §14.3)

| Criterion | Status | Evidence |
|---|---|---|
| Linux and Windows installers install/uninstall/autostart | ⚠️ partially verified | Windows: PyInstaller build + service scripts + Inno script (Inno not executed on this machine: toolchain absent). Linux: unit files/install script written, not executed here. |
| UI selects port/baud and opens a session | ✅ | browser CDP check "session created from the dialog is listed and open" |
| Real device end to end | ✅ | live run 46/46 + agent-path MCP run 25/25 on a Raspberry Pi 5 shell through a Debug Probe |
| Agent lists sessions, reads logs, runs commands with structured results | ✅ | MCP e2e checks + protocol tests |
| `control_owner` switch blocks/allows agent writes | ✅ | integration + UI + MCP checks |
| Replug reconnects, cursor continues, gap reported | ✅ | reconnect test, gap unit tests, HIL enumeration |
| Config changes never leave a half-open state | ✅ | config validation + update/reopen path tests |
| Unauthenticated/unauthorised/illegal port requests rejected + audited | ✅ | security suite (10 tests) |
| 24 h soak without leaks/data loss | ⚠️ not run | short connection/soak behaviour only; no 24 h run in this environment |

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

# 4. packaged binaries (after packaging/pyinstaller/build.ps1)
.venv\Scripts\python scripts\verify_packaged.py

# 5. live hardware (device attached, server running with a session)
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
