# Windows desktop app

`tio-server Desktop` is a self-contained Windows window for the existing SPA and
server. It does **not** require a browser, a Windows service, or an open console:
one `tio-desktop.exe` process starts uvicorn on a loopback port (18765 by
default) and hosts the UI in **Microsoft Edge WebView2**.

The service + browser install remains available and independent; desktop data is
stored under `%LOCALAPPDATA%\tio-server-desktop`, while the service uses
`C:\ProgramData\tio-server`.

## Build

Prerequisites on the build machine:

* Python venv with the desktop extra: `pip install -e ".[desktop]"`;
* a built SPA (`npm --prefix frontend run build`);
* [Inno Setup 6](https://jrsoftware.org/isinfo.php) for the installer.

```powershell
powershell -ExecutionPolicy Bypass -File packaging\pyinstaller\build_desktop.ps1
& "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe" packaging\windows\tio-desktop.iss
```

Outputs:

```text
dist\tio-desktop\tio-desktop.exe             WebView2 desktop app (onedir)
dist\installer\tio-server-desktop-0.1.0-setup.exe
```

`build_desktop.ps1` also runs `tio-desktop.exe --smoke --data-dir <temp>`, which
starts the server, prints the URL, and shuts down without opening a window.

## Install and first run

Run the setup. It installs per-user to:

```text
%LOCALAPPDATA%\Programs\tio-server\
```

and creates Start Menu + optional desktop shortcuts and an optional
**Start with Windows** task (off by default). No administrator prompt is needed.

On first launch it creates:

```text
%LOCALAPPDATA%\tio-server-desktop\
  config.toml
  api-token                        MCP bearer token (also shown in the MCP tab)
  logs\, transcripts\, webview\
```

The window opens straight into the UI; there is no login and no browser tab.
Existing configs from older versions (with `admin_*` fields) still load; the
stale fields are ignored.

## Runtime

* The server binds `127.0.0.1:18765` by default, so the MCP endpoint is stable
  across desktop restarts (`http://127.0.0.1:18765/mcp`). Pass `--port 0` for an
  ephemeral test port; if 18765 is occupied, launch with another free port.
* Closing the window stops the server; the app is single-instance.
* The desktop app is independent from a running `tio-server` service.
* WebView2 Runtime is required; it is present on current Windows 10/11. If it is
  missing, the app shows the URL and points to the log instead of crashing.
* Serial and SSH sessions, MCP, SFTP and the rest of the UI are unchanged.

Logs: `%LOCALAPPDATA%\tio-server-desktop\desktop.log`.

## Uninstall

Use **Apps & features** / the Start Menu uninstaller. The uninstaller asks whether
to delete `%LOCALAPPDATA%\tio-server-desktop`; choose No to keep configuration and
transcripts for a reinstall.

## Limitations

* Windows x64 only; Linux uses the service/systemd install.
* No tray icon or auto-update yet; **Start with Windows** is the only autostart
  option.
* The installer/executable are unsigned; add Authenticode before distribution.
