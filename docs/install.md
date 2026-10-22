# Installation

Supported: Windows 10/11 x64, Linux x86_64/ARM64 (Python 3.11+ for source
installs).

## 1. From source (development)

```bash
git clone <repo> && cd tio-suite
python -m venv .venv
.venv/Scripts/python -m pip install -e ".[dev]"     # Linux: .venv/bin/python
npm --prefix frontend ci && npm --prefix frontend run build   # writes src/tio_server/web/static
tio-server doctor
```

Build the SPA whenever the frontend changes; the server serves the prebuilt
files, so the packaged product needs no Node runtime.

## 2. First run

```bash
tio-server init --dir ./run
tio-server run --config ./run/config.toml
```

`init` prints the MCP API token
**once** (and stores it in a `0600` file). Open
<http://127.0.0.1:8765/> and create a session — the web UI needs no login;
`/api` is local-trust, guarded by Host/Origin checks instead.

Useful commands:

| Command | Purpose |
|---|---|
| `tio-server doctor [--config …]` | dependency/port diagnostics (JSON) |
| `tio-server ports` | enumerate serial ports as JSON |
| `tio-server check-config --config …` | validate a config without starting |
| `tio-server version` | version |

## 3. Windows

### Build the executables

```powershell
powershell -ExecutionPolicy Bypass -File packaging\pyinstaller\build.ps1
# dist\tio-server\tio-server.exe, dist\tio-mcp.exe, dist\tio-web-bridge.exe
```

### Installer

1. Install [Inno Setup](https://jrsoftware.org/isinfo.php) and run
   `iscc packaging\windows\tio-server.iss`.
2. The installer creates `C:\ProgramData\tio-server\config.toml`, writes
   `first-run-credentials.json` with the MCP API token (delete it after
   reading), registers the `tio-server` service via `sc.exe`, starts it
   and opens the UI.

Layout:

```text
C:\Program Files\tio-server\           tio-server.exe, tio-mcp.exe
C:\ProgramData\tio-server\             config.toml, api-token, bridge-token, transcripts\, logs\
```

Service management (WinSW config is also provided in
`packaging/windows/tio-server.xml`):

```powershell
powershell -ExecutionPolicy Bypass -File "C:\Program Files\tio-server\install-service.ps1"
sc.exe query tio-server
sc.exe stop tio-server
```

Notes:

* COM ports are usually accessible to services; if not, run the service under a
  dedicated local account and grant it access to `C:\ProgramData\tio-server`.
* Opening some USB-UART bridges (FTDI/CP210x/CH340) pulses DTR/RTS and can reset
  the board. Set `open_mode = "preserve"` (default) and read the warning on the
  session page.
* Add an Authenticode signature to the installer and executables before
  distributing.

## 4. Windows desktop app

For a normal desktop install (no service, no browser), use the WebView2 app:

```powershell
pip install -e ".[desktop]"
powershell -ExecutionPolicy Bypass -File packaging\pyinstaller\build_desktop.ps1
& "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe" packaging\windows\tio-desktop.iss
```

Run `dist\installer\tio-server-desktop-0.1.0-setup.exe`. It installs per-user to
`%LOCALAPPDATA%\Programs\tio-server`, adds Start Menu/optional desktop shortcuts
and an optional **Start with Windows** entry. Data lives in
`%LOCALAPPDATA%\tio-server-desktop`; first launch opens straight into the
UI (no login); the MCP token is in `api-token` there.

See [desktop.md](desktop.md) for the runtime, uninstall and limitations.

## 5. Linux

### Bundle layout (produced by CI / PyInstaller)

```text
tio-server            onedir executable
tio-mcp               onefile
_internal/            PyInstaller payload (contains web/static)
```

Install with:

```bash
sudo ./packaging/linux/install.sh /path/to/bundle
```

That creates the `tio` system user, `/opt/tio-server`, `/var/lib/tio-server`
(runtime config, tokens, transcripts), `/var/log/tio-server`, adds the user to
`dialout`, installs `tio-server.service` and starts it.

systemd unit highlights (`packaging/linux/tio-server.service`): `Restart=always`,
`KillMode=control-group` (child processes die with the service),
`ProtectSystem=strict` with writable `/var/lib/tio-server` and
`/var/log/tio-server`, `UMask=0077`, `LimitNOFILE=65536`.

```bash
systemctl status tio-server
journalctl -u tio-server -f
```

Permissions: the service user must be in `dialout` (Debian/Ubuntu) or `uucp`
(Arch); a udev rule can also grant access to a specific USB VID/PID.

## 6. Configuration essentials

`config.toml` (validated on load; atomic writes from the UI):

```toml
config_version = 1

[server]
bind = "127.0.0.1"      # non-loopback requires security.allow_remote_bind
port = 8765

[auth]
api_token_hash = "$argon2id$…"   # MCP bearer token hash; the web UI has no login

[security]
allowed_ports = ["/dev/ttyUSB*", "/dev/ttyACM*", "/dev/serial/by-id/*", "COM[0-9]*"]
allowed_baudrates = [9600, 115200, 921600]
max_sessions = 4
max_read_bytes = 16384
regex_timeout_ms = 500
rate_limit_per_second = 20
allow_dev_ports = false   # true only for sim:// in development/tests

[[sessions]]
id = "board-a"
port = "COM5"             # or /dev/serial/by-id/…
baudrate = 115200
bytesize = 8
parity = "none"
stopbits = 1
flow = "none"
open_mode = "preserve"
auto_open = true
auto_reconnect = true
buffer_bytes = 8388608
agent_permissions = ["read", "write", "command"]
```

`control_owner` is runtime state and always starts as `human` after a restart.

## 7. Upgrade / uninstall

* Upgrade: replace the program files, keep `config.toml`, restart. `config_version`
  migration runs on load; the old file is kept as `config.toml.bak` when a
  migration changes it.
* Windows uninstall: `sc.exe stop/delete tio-server` (the installer does this) and
  optionally delete `C:\ProgramData\tio-server`.
* Linux uninstall: `systemctl disable --now tio-server`, remove
  `/opt/tio-server` and the unit; keep `/var/lib/tio-server` if you want to keep
  transcripts and tokens.

## 8. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `PORT_BUSY` | another program (or `tio`) holds the port; close it |
| permission denied opening `/dev/ttyUSB0` | add the service user to `dialout` |
| board resets when the session opens | driver pulses DTR/RTS; use `open_mode="preserve"` and check the cable/adapter |
| MCP 401 | wrong/missing bearer token; `tio-mcp` reads `<data-dir>/api-token` |
| `WRITE_LOCKED` | hand control to the agent in the UI (or take it back) |
| browser shows a 404 for the UI | frontend not built: `npm --prefix frontend run build` |
| service starts then exits | run `tio-server check-config --config …`; check `logs/server.log` |
