"""Windows desktop shell for tio-server.

The server and the UI run in one process: uvicorn binds an ephemeral loopback
port, then pywebview hosts the existing SPA in a WebView2 window.  This is the
entry point used by the ``tio-desktop`` installer; the service/browser install
remains available separately.
"""

from __future__ import annotations

import argparse
import ctypes
import json
import logging
import os
import sys
import threading
import time
from pathlib import Path

from .auth import write_secret_file
from .config import CONFIG_FILENAME, Config, init_config
from .errors import ToolFailure

APP_NAME = "tio-server"
APP_ID = "tio.server.desktop"
MUTEX_NAME = "Global\\tio-server-desktop-single-instance"
_MUTEX = None  # keep the Win32 handle alive


def _default_desktop_dir() -> Path:
    override = os.environ.get("TIO_DESKTOP_HOME")
    if override:
        return Path(override).expanduser()
    base = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA") or str(Path.home())
    return Path(base) / "tio-server-desktop"


def _log_path(data_dir: Path) -> Path:
    data_dir.mkdir(parents=True, exist_ok=True)
    return data_dir / "desktop.log"


def _setup_logging(path: Path) -> None:
    handler = logging.FileHandler(path, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.addHandler(handler)
    # A windowed PyInstaller build has no console; keep libraries that print
    # from crashing on sys.stdout/sys.stderr being None.
    if sys.stdout is None or sys.stderr is None:
        stream = open(path, "a", encoding="utf-8", buffering=1)
        if sys.stdout is None:
            sys.stdout = stream
        if sys.stderr is None:
            sys.stderr = stream


def _message(title: str, text: str, *, error: bool = False) -> None:
    if sys.platform == "win32":
        flags = 0x10 if error else 0x40
        try:
            ctypes.windll.user32.MessageBoxW(None, text, title, flags)
            return
        except Exception:
            pass
    print(f"{title}: {text}", file=sys.stderr)


def _single_instance() -> bool:
    global _MUTEX
    if sys.platform != "win32":
        return True
    _MUTEX = ctypes.windll.kernel32.CreateMutexW(None, False, MUTEX_NAME)
    return ctypes.windll.kernel32.GetLastError() != 183


def _make_config(data_dir: Path, *, interactive: bool = True) -> tuple[Config, dict | None]:
    config_path = data_dir / CONFIG_FILENAME
    created = None
    if not config_path.exists():
        cfg, secrets = init_config(data_dir)
        created = secrets
        cred_path = data_dir / "first-run-credentials.json"
        write_secret_file(cred_path, json.dumps(secrets, indent=2))
        if interactive:
            try:
                os.startfile(str(cred_path))  # type: ignore[attr-defined]
            except Exception:
                pass
            _message(
                "tio-server first run",
                "A local admin account was created.\n\n"
                f"Credentials: {cred_path}\n\n"
                "The file has been opened. Read the password, delete the file after "
                "first login, then sign in in the window that follows.",
            )
    cfg = Config.load(config_path)
    return cfg, created


def _start_server(cfg: Config, *, host: str, port: int):
    import uvicorn

    from .web.app import create_app

    app = create_app(cfg)
    config = uvicorn.Config(
        app,
        host=host,
        port=port,
        log_level=cfg.server.log_level,
        access_log=False,
        log_config=None,
    )
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, name="tio-uvicorn", daemon=True)
    thread.start()
    deadline = time.monotonic() + 20
    while not server.started and time.monotonic() < deadline:
        if not thread.is_alive():
            raise RuntimeError("server thread exited before startup")
        time.sleep(0.05)
    if not server.started:
        raise RuntimeError("server did not start within 20 seconds")
    sockets = server.servers[0].sockets if getattr(server, "servers", None) else []
    if not sockets:
        raise RuntimeError("server has no listening socket")
    actual_port = int(sockets[0].getsockname()[1])
    return server, thread, actual_port


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="tio-desktop", description="tio-server desktop window")
    parser.add_argument("--data-dir", help="desktop data directory (default: %LOCALAPPDATA%\\tio-server-desktop)")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18765, help="loopback port (default: 18765; 0 picks a free port)")
    parser.add_argument("--smoke", action="store_true", help="start the server, print the URL and exit")
    parser.add_argument("--debug", action="store_true", help="enable the WebView inspector")
    args = parser.parse_args(argv)

    if sys.platform == "win32":
        try:
            ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(APP_ID)
        except Exception:
            pass
        if not args.smoke and not _single_instance():
            _message(APP_NAME, "tio-server desktop is already running.")
            return 0

    data_dir = Path(args.data_dir).expanduser() if args.data_dir else _default_desktop_dir()
    data_dir.mkdir(parents=True, exist_ok=True)
    _setup_logging(_log_path(data_dir))

    try:
        cfg, created = _make_config(data_dir, interactive=not args.smoke)
        server, thread, port = _start_server(cfg, host=args.host, port=args.port)
    except (ToolFailure, OSError, RuntimeError) as exc:
        logging.exception("desktop startup failed")
        _message(APP_NAME, f"Could not start: {exc}\n\nSee {_log_path(data_dir)}", error=True)
        return 1

    url = f"http://{args.host}:{port}/"
    logging.info("desktop server listening at %s (data=%s)", url, data_dir)
    if args.smoke:
        print(url)
        server.should_exit = True
        thread.join(timeout=5)
        return 0

    try:
        import webview

        window = webview.create_window(
            "tio-server",
            url,
            width=1280,
            height=860,
            min_size=(1000, 680),
            text_select=True,
        )
        del window
        webview.start(
            gui="edgechromium",
            debug=args.debug,
            private_mode=False,
            storage_path=str(data_dir / "webview"),
        )
    except Exception as exc:
        logging.exception("desktop window failed")
        _message(
            APP_NAME,
            f"The desktop window could not start: {exc}\n\n"
            "Install Microsoft Edge WebView2 Runtime, or open the server URL:\n"
            f"{url}\n\nSee {_log_path(data_dir)}",
            error=True,
        )
        return 1
    finally:
        server.should_exit = True
        thread.join(timeout=5)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
