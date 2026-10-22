# Verification report

**Result: all automated suites pass on Windows 10 x64.**

| Suite | Result | Artifact |
|---|---|---|
| `pytest` (unit + integration + protocol + security + HIL) | **106 passed, 1 skipped** | `pytest -q` |
| End-to-end: real server process, MCP, serial I/O, reconnection, browser UI | **37 / 37 checks** | `artifacts/e2e/report.json` |
| Packaged PyInstaller binaries (server + shim) | **11 / 11 checks** | `artifacts/packaged/report.json` |
| **Live hardware**: Raspberry Pi over a Debug Probe UART | **46 / 46 checks** | [`live-debug-report.md`](./live-debug-report.md) |
| **Live agent path**: MCP stdio client (DSH's client) on the Pi shell | **25 / 25 checks** | `artifacts/live-shell/report.json` |
| **Terminal tab**: xterm.js in the built SPA, typed on the real Pi | **3 / 3 checks** (CDP) | `docs/screenshots/10-terminal-tab.png` |
| **SSH web terminal**: Paramiko against the real Pi (OpenSSH 10.0p2) | **7 / 7 checks** | [`ssh.md`](./ssh.md), [screenshot](screenshots/14-ssh-terminal.png) |
| **SSH MCP tools**: exec/read/tail/write/expect on a real session | **7 / 7 checks** | [`ssh-plan.md`](./ssh-plan.md) |

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

### 7. SSH web terminal (7 checks)

The Paramiko session manager was exercised against the **real Pi 5**
(OpenSSH 10.0p2) over the LAN, with a dedicated Ed25519 key installed only for
the test and removed afterwards:

1. key login (`root@192.168.124.23`) opened a PTY, `state=open`;
2. `uname -a` through the `/ws/ssh` WebSocket returned the 6.18.39 kernel;
3. a WebSocket resize to 120×40 made the remote `stty size` return `40 120`;
4. an empty known_hosts produced `SSH_HOST_UNKNOWN` with the SHA256 fingerprint;
5. a wrong known_hosts entry produced `SSH_HOST_KEY_CHANGED` with both
   expected and actual fingerprints;
6. disconnect removed the session (`sessions=[]`);
7. the built SPA was driven through CDP: typing `uname -r` in the SSH terminal
   printed `6.18.39+rpt-rpi-2712`.

Status showed `aes128-ctr` / `hmac-sha2-256` and the host-key fingerprint.
Transcripts (`run/transcripts/ssh-*.jsonl`) and audit events (`ssh.connect`,
`ssh.disconnect`, `ssh.connect_failed`) were present. Screenshots:
[13-ssh-connections](screenshots/13-ssh-connections.png),
[14-ssh-terminal](screenshots/14-ssh-terminal.png),
[15-ssh-typed](screenshots/15-ssh-typed.png).

Phase 2 additions were verified on the same Pi host:

- **connection test** (`POST /api/ssh/hosts/{id}/test`) returned `reachable=true`,
  `OpenSSH_10.0p2`, `ssh-ed25519`, SHA256 fingerprint and
  `known_hosts_status=unknown` without authenticating;
- **log export** (`GET /api/ssh/sessions/{id}/export?format=txt`) returned the
  timestamped RX transcript (`RX` + `Linux raspberry...`);
- the SSH terminal header now exposes **Log** and **Keys**, and host cards expose
  **Test**; screenshot [14-ssh-terminal](screenshots/14-ssh-terminal.png) was
  refreshed;
- **multi-session tabs** verified with two sessions to the Pi: both appear in the
  tab bar and switching reattaches to the server-side ring
  ([16-ssh-tabs](screenshots/16-ssh-tabs.png), superseded by the unified
  workspace below);
- **one Terminal workspace** verified with the real COM5 serial session plus two
  SSH sessions: a single tab bar shows `USB Serial (COM5)` and both `128` SSH
  tabs, switching keeps the matching xterm view
  ([19-terminal-mixed-serial](screenshots/19-terminal-mixed-serial.png),
  [20-terminal-mixed-ssh](screenshots/20-terminal-mixed-ssh.png));
- **tab close ×** verified through CDP: clicking the × on an SSH tab called
  `ssh_disconnect`, removed the tab and navigated to `#/terminal/board` (the
  serial tab), not back to Sessions.
- **auto reconnect** verified on the real Pi: stopping sshd and killing the root
  `sshd-session` moved the session to `reconnecting`; starting sshd again restored
  `open` with `reconnect_count=1`, and `ssh_exec("uname -r")` returned
  `6.18.39+rpt-rpi-2712` (exit 0).

### 8. SSH MCP tools (8 checks)

Through the live `/mcp` endpoint (Bearer + `Mcp-Session-Id`), with an
operator-opened SSH session to the Pi:

1. `tools/list` returned **16 tools** (8 serial + 8 SSH) with schemas/annotations;
2. `ssh_sessions` listed the open session and its host-key fingerprint;
3. `ssh_status` reported `state=open`, `aes128-ctr`, SHA256 fingerprint;
4. `ssh_exec("uname -r")` returned `exit_code=0`, stdout `6.18.39+rpt-rpi-2712`;
5. `ssh_read`/`ssh_tail` returned the login banner and root prompt;
6. `ssh_write("echo mcp-ssh-ok")` + `ssh_expect("mcp-ssh-ok")` matched;
7. disconnect/delete removed the session/profile; the temporary key was removed
   from the Pi and the artifacts deleted. No `ssh_connect`/`ssh_disconnect`
   tools exist (operator-opened sessions only);
8. `ssh_host_info` contract is covered by a unit test with a fake manager
   (description/path notes, visible_sessions, no password); it is gated on an
   agent-visible session just like the other SSH tools.

### 9. SSH Phase 4 (SFTP, jump host, agent, config import)

- **SFTP** against the Pi: listed `/root` (16 entries), uploaded
  `/root/tio-sftp-test.txt` (19 bytes), downloaded identical bytes, created
  `tio-sftp-dir`, renamed it, then deleted both. All steps returned 200.
- **Jump host**: two saved profiles, target `jump_host_id=jump`; the target
  connected through a `direct-tcpip` channel and `ssh_exec("uname -r")` returned
  `6.18.39+rpt-rpi-2712` (exit 0).
- **~/.ssh/config import**: unit test parses Host/HostName/User/Port/
  IdentityFile, skips wildcard entries (`tests/unit/test_ssh_config_import.py`).
- **SSH agent**: unit test asserts `allow_agent=True` and no key filename
  (`tests/unit/test_ssh_session.py`); no real agent is available in this
  environment.
- **keyboard-interactive/2FA**: backend handler and UI response list are
  implemented, but no 2FA host was available; **not** end-to-end verified.

### 10. SSH remembered credentials

Against the real Pi with a temporary `tiotest` account:

1. first connect sent `password` + `remember=true`; `GET /api/ssh/hosts` then
   returned `has_saved_secrets=true`, `saved_fields=["password"]`, and no plaintext;
2. after disconnect, a second connect sent **no password**, only
   `use_saved=true`, and returned `state=open` as `tiotest`;
3. `run/ssh-secrets.json` contained no plaintext (`TioTest!123` absent) and
   `ssh-secrets.key` existed;
4. `DELETE /api/ssh/hosts/{id}/secrets` returned `cleared=true` and the host
   flags went back to false;
5. the profile and the temporary Linux user were removed afterwards.

### 11. SSH agent visibility

With one SSH session to the Pi (default `agent_visible=false`):

1. MCP `ssh_sessions` returned `sessions=[]`;
2. `POST /api/ssh/sessions/{id}/agent {enabled:true}` then `ssh_sessions` listed
   exactly that session and `ssh_exec("uname -r")` returned exit 0;
3. `enabled:false` hid it again: `ssh_sessions` empty and `ssh_status` with the
   explicit id returned `PERMISSION_DENIED`;
4. the session/profile and temporary key were removed afterwards.

### 12. SSH agent activity in the web terminal

With an agent-visible SSH session:

1. MCP `ssh_write(data="ls", newline="lf")` wrote **3 bytes to the PTY**;
   the terminal showed `ls` and the directory listing exactly as if typed by a
   human, and `ssh_read` returned the same listing from the session ring;
2. the session status became `last_write_source=agent`,
   `agent_last_action=write`; the LIVE bar/AGENT ACTIVITY card and the 5 s header
   pulse reported the action, while the terminal showed the command and output
   directly with no separate agent panel
   ([24-ssh-agent-pty](screenshots/24-ssh-agent-pty.png));
3. MCP `ssh_exec` remains a separate channel: it does not echo into the PTY, but
   still updates the activity card with action/exit/latency; use `ssh_write` for
   transparent interactive operation;
4. the verification session was left open for the operator; no files were
   changed by the commands.

### 13. Windows desktop app

1. `packaging/pyinstaller/build_desktop.ps1` built `dist/agent-desktop` (PyInstaller
   onedir, windowed, icon) and its `--smoke` step started the server and exited 0;
2. `packaging/windows/agent-desktop.iss` produced
   `dist/installer/agent-terminal-0.1.0-setup.exe` (~24.7 MB);
3. silent per-user install exited 0; Start Menu/desktop shortcut
   `agent-terminal Desktop` and the installed `agent-desktop.exe` were created under
   `%LOCALAPPDATA%\Programs\agent-terminal`;
4. the installed app opened a WebView2 window titled `agent-terminal`; first run
   created `%LOCALAPPDATA%\agent-terminal\config.toml` + `api-token`,
   independent from the service data directory;
5. the desktop server bound `127.0.0.1:18765` (stable MCP endpoint), `/api`
   answered without login, and the app/service used different data dirs and
   ports; no service was installed or modified.

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
| SSH web terminal: saved hosts, strict known_hosts, PTY resize | ✅ | 7/7 real Pi checks; pytest SSH profile/session/API tests |
| SSH MCP tools on operator-opened sessions | ✅ | 7/7 real Pi checks (exec/read/tail/write/expect); 16 tools total; host_info contract tested |
| SSH Phase 2: connection test, log export, Keys help | ✅ | real Pi test endpoint + transcript export; covered by pytest |
| SSH Phase 2: multi-tabs + transport auto reconnect | ✅ | two Pi sessions in tabs; sshd restart → `reconnecting` → `open`, reconnect_count=1 |
| Unified Terminal: serial + SSH in one tab bar | ✅ | COM5 + two SSH sessions; screenshots 19/20; per-tab × disconnect verified |
| SSH Phase 4: SFTP + jump host | ✅ | real Pi upload/download/mkdir/rename/delete; jump-host `ssh_exec` |
| SSH remembered credentials | ✅ | encrypted at rest; second connect without password; Forget clears |
| SSH agent visibility | ✅ | default private; marked session listed/executable; unmarked denied |
| SSH agent activity in web UI | ✅ | `ssh_write` PTY input visible in terminal; activity card; exec separate |
| Windows desktop app/installer | ✅ | WebView2 onedir + per-user setup; installed, launched, first-run data verified |
| SSH agent / config import / 2FA | ⚠️ partial | agent + config parser tested; 2FA code path not end-to-end |
| `control_owner` switch blocks/allows agent writes | ✅ | integration + UI + MCP checks |
| Replug reconnects, cursor continues, gap reported | ✅ | reconnect test, gap unit tests, HIL enumeration |
| Config changes never leave a half-open state | ✅ | config validation + update/reopen path tests |
| Unauthenticated/unauthorised/illegal port requests rejected + audited | ✅ | security suite (10 tests) |
| 24 h soak without leaks/data loss | ⚠️ not run | short connection/soak behaviour only; no 24 h run in this environment |
| Docs for install/config/MCP/troubleshooting | ✅ | `docs/install.md`, `mcp.md`, `ssh.md`, `architecture.md` |

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
