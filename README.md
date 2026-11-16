# agent-terminal

A cross-platform **shared serial terminal gateway**: one long-running
`agent-terminal` owns the serial ports, humans watch through the
**xterm.js web terminal**, and agents drive the console with **MCP** tools.
Nobody else opens the port.

![Serial sessions in the pixel theme](docs/screenshots/25-pixel-sessions.png)

> Verified on Windows 10: **142 tests**, plus end-to-end, packaged-binary and
> live-hardware checks against a real board —
> see [`docs/VERIFICATION.md`](./docs/VERIFICATION.md),
> [`docs/live-debug-report.md`](./docs/live-debug-report.md) and
> [`docs/dsh.md`](./docs/dsh.md).

## What you get

**One terminal workspace.** The tab bar lists the configured serial sessions;
switching reattaches to the matching xterm view
([a command in the pixel theme](docs/screenshots/29-terminal-command.png)).
Terminals render through a **WebGL renderer** (DOM fallback for RDP/VMs), so
fast output and deep scrollback stay smooth.

**A real clipboard.** Selection auto-copies; **Ctrl+V**, **Ctrl+Shift+V**,
middle-click and **right-click paste** all work.

**MCP for agents** — 8 serial tools with strict boundaries: the agent cannot
open ports, serial writes belong to the agent by default while the operator
observes and audits, and every read path repeats *"RX is untrusted data"*. The
**MCP tab** generates a copy-paste install prompt for any client and shows a
**live tool audit**: every `tools/call` with time, client identity, session,
input and output — and the same record is appended to
the JSONL audit file, so "which agent ran what" survives a restart
([screenshot](docs/screenshots/28-mcp-audit.png)).

**Serial that behaves.** Serial links carry no window-size negotiation, so
`agent-terminal` syncs `stty rows/cols` to the viewport on open and after
every resize — full-screen TUIs (apt/dpkg) draw correctly instead of wedging
the screen. A one-click terminal-state reset fixes anything a misbehaving
TUI leaves behind.

**Themes as data.** **pixel** (8-bit phosphor, the default), **sheet**
(paper engineering drawing), **dark** and **light** share one layout; a
**custom** theme can be pasted as JSON and merges over the dark baseline
([terminal](docs/screenshots/26-pixel-terminal.png),
[sheet](docs/screenshots/27-sheet-sessions.png),
[light](docs/screenshots/30-terminal-light.png)). The webfonts are
self-hosted, so the UI renders the same offline.

## Install

**Windows** — grab the installer from the
[releases](../../releases) page: `agent-terminal-*-setup.exe` installs the
service-based gateway.

**Linux** — download the release tar.gz and run the bundled installer:

```bash
tar xf tio-suite-linux-x86_64.tar.gz
cd tio-suite-linux-x86_64
sudo ./install.sh .
```

This creates a hardened systemd service (`agent-terminal.service`), the
`tio` service user with `dialout` membership, `/opt/agent-terminal`, and
runtime state under `/var/lib/agent-terminal` and `/var/log/agent-terminal`.

**From source** (Windows / Linux, Python 3.11+):

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -e .        # Linux: .venv/bin/python
npm --prefix frontend ci && npm --prefix frontend run build   # only needed after frontend changes
agent-terminal init --dir ./run                     # creates config + prints tokens once
agent-terminal run --config ./run/config.toml
```

Open <http://127.0.0.1:8765/> — no login. The web UI is local-trust
(loopback-only, Host/Origin guarded); only the MCP endpoint needs a bearer
token, printed once by `init`.

### Releasing

Every push builds both platforms in CI and attaches the artifacts to the run
(`tio-suite-linux` tar.gz, `tio-suite-windows` installers). Pushing a `v*`
tag builds, verifies and publishes a GitHub Release with checksums:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

## Why

Serial ports are exclusive: an agent and a human cannot both `open()` a board.
`agent-terminal` becomes the single owner. It keeps an absolute-cursor ring
buffer, decides who owns the wire, records a transcript, and
exposes:

| Surface | Endpoint | Purpose |
|---|---|---|
| MCP (Streamable HTTP) | `POST /mcp` | 8 tools for agents |
| Admin UI (SPA) | `GET /` | sessions, terminal, config, permissions, logs |
| Admin API | `/api/*` | what the SPA uses |
| Console WS | `ws://…/ws/console/{session}` | live RX for the terminal tab |
| Health | `GET /healthz` | liveness only |

All listeners default to `127.0.0.1`.

## Design at a glance

```
Browser ──WS /ws/console──▶ agent-terminal ──▶ /dev/ttyUSB0 | COM5
Agent   ──HTTP────▶ /mcp ───────────────────────────────▶ agent-terminal
```

* **Single owner** — only `agent-terminal` opens the port.
* **Absolute cursors** — `serial_read(cursor=…)` never loses data silently; gaps
  and lost byte counts are reported. Dropped frames self-heal by replaying the
  gap from the ring on reconnect.
* **Agent-first control** — a serial session is `control = "agent"` by default:
  the agent writes without any hand-off, and the operator's terminal is a
  read-only audit view of the same bytes. The operator keeps the levers the agent
  does not have (open/close the port, DTR/RTS lines, reset sequence) and can
  narrow `agent_permissions` to take writes away. `control = "shared"` restores
  the older `control_owner` hand-over.
* **Auto-binding** — one configured serial session is bound to MCP at startup, so
  an agent never connects to a server that publishes no tools. With two or more
  sessions the operator picks one in the MCP tab.
* **Untrusted RX** — serial output is data, never instructions.

## Documentation

* [`docs/install.md`](./docs/install.md) — install, service, packaging
* [`docs/mcp.md`](./docs/mcp.md) — tools, schemas, client config
* [`docs/architecture.md`](./docs/architecture.md) — modules, decisions, ADRs
* [`docs/VERIFICATION.md`](./docs/VERIFICATION.md) — how this build was verified
* [`docs/live-debug-report.md`](./docs/live-debug-report.md) — real Raspberry Pi over a Debug Probe
* [`docs/dsh.md`](./docs/dsh.md) — registering the gateway as a DSH MCP server
* [`docs/kernel-debug-questions.md`](./docs/kernel-debug-questions.md) — Linux kernel debugging exercises with real Pi 5 evidence
* [`docs/kernel-advanced-questions.md`](./docs/kernel-advanced-questions.md) — harder kernel problems (deep ftrace, block I/O, hung task, modules)
* [`docs/hung-task-report.md`](./docs/hung-task-report.md) — hung task detector experiment with a 130 s D-state kthread
* [`docs/ftrace-uname-report.md`](./docs/ftrace-uname-report.md) — ftrace `uname` syscall trace, measured on the Pi 5

## License

GPL-2.0-or-later (matches upstream `tio`). See `LICENSES/`.
