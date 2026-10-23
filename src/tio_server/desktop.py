"""Windows desktop shell for agent-terminal.

The server and the UI run in one process: uvicorn binds an ephemeral loopback
port, then pywebview hosts the existing SPA in a WebView2 window.  This is the
entry point used by the ``agent-desktop`` installer; the service/browser install
remains available separately.
"""

from __future__ import annotations

import argparse
import ctypes
import logging
import os
import socket
import sys
import threading
import time
import urllib.request
from pathlib import Path

from .config import CONFIG_FILENAME, Config, init_config
from .errors import ToolFailure

APP_NAME = "agent-terminal"
APP_ID = "agent.terminal.desktop"
MUTEX_NAME = "Global\\agent-terminal-single-instance"
_MUTEX = None  # keep the Win32 handle alive


def _default_desktop_dir() -> Path:
    override = os.environ.get("AGENT_DESKTOP_HOME") or os.environ.get("TIO_DESKTOP_HOME")
    if override:
        return Path(override).expanduser()
    base = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA") or str(Path.home())
    return Path(base) / "agent-terminal"


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
    if sys.stderr is not None:
        print(f"{title}: {text}", file=sys.stderr)


def _single_instance() -> bool:
    global _MUTEX
    if sys.platform != "win32":
        return True
    # use_last_error: ctypes' own Win32 calls can clobber the thread's last
    # error, so GetLastError via windll is unreliable across the two calls.
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _MUTEX = kernel32.CreateMutexW(None, False, MUTEX_NAME)
    if not _MUTEX:
        return True  # creation failed; do not block startup
    return ctypes.get_last_error() != 183  # ERROR_ALREADY_EXISTS


def _make_config(data_dir: Path) -> Config:
    """Create the config on first run; the MCP token lands in ``api-token``."""
    config_path = data_dir / CONFIG_FILENAME
    if not config_path.exists():
        init_config(data_dir)
    return Config.load(config_path)


_CF_UNICODETEXT = 13
_GMEM_MOVEABLE = 0x0002


def _win32_clipboard_read() -> str:
    """Read the Windows clipboard as text (``""`` when it holds no text)."""
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32.GlobalLock.restype = ctypes.c_void_p
    kernel32.GlobalLock.argtypes = [ctypes.c_void_p]
    kernel32.GlobalUnlock.argtypes = [ctypes.c_void_p]
    user32.GetClipboardData.restype = ctypes.c_void_p
    user32.GetClipboardData.argtypes = [ctypes.c_uint]
    if not user32.OpenClipboard(None):
        raise OSError(f"OpenClipboard failed (Win32 error {ctypes.get_last_error()})")
    try:
        handle = user32.GetClipboardData(_CF_UNICODETEXT)
        if not handle:
            return ""
        ptr = kernel32.GlobalLock(handle)
        if not ptr:
            return ""
        try:
            return ctypes.wstring_at(ptr)
        finally:
            kernel32.GlobalUnlock(handle)
    finally:
        user32.CloseClipboard()


def _win32_clipboard_write(text: str) -> None:
    """Put text on the Windows clipboard (with a trailing NUL)."""
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32.GlobalAlloc.restype = ctypes.c_void_p
    kernel32.GlobalAlloc.argtypes = [ctypes.c_uint, ctypes.c_size_t]
    kernel32.GlobalLock.restype = ctypes.c_void_p
    kernel32.GlobalLock.argtypes = [ctypes.c_void_p]
    kernel32.GlobalUnlock.argtypes = [ctypes.c_void_p]
    kernel32.GlobalFree.argtypes = [ctypes.c_void_p]
    user32.SetClipboardData.restype = ctypes.c_void_p
    user32.SetClipboardData.argtypes = [ctypes.c_uint, ctypes.c_void_p]
    data = ctypes.create_unicode_buffer(text)
    size = ctypes.sizeof(data)
    if not user32.OpenClipboard(None):
        raise OSError(f"OpenClipboard failed (Win32 error {ctypes.get_last_error()})")
    try:
        user32.EmptyClipboard()
        handle = kernel32.GlobalAlloc(_GMEM_MOVEABLE, size)
        if not handle:
            raise OSError(f"GlobalAlloc failed (Win32 error {ctypes.get_last_error()})")
        ptr = kernel32.GlobalLock(handle)
        if not ptr:
            kernel32.GlobalFree(handle)
            raise OSError(f"GlobalLock failed (Win32 error {ctypes.get_last_error()})")
        try:
            ctypes.memmove(ptr, data, size)
        finally:
            kernel32.GlobalUnlock(handle)
        # After a successful SetClipboardData the system owns the handle.
        if not user32.SetClipboardData(_CF_UNICODETEXT, handle):
            kernel32.GlobalFree(handle)
            raise OSError(f"SetClipboardData failed (Win32 error {ctypes.get_last_error()})")
    finally:
        user32.CloseClipboard()


class DesktopBridge:
    """js bridge for the SPA.  WebView2 denies ``navigator.clipboard`` reads
    and writes because pywebview never answers the PermissionRequested event,
    so the frontend falls back to these Win32 calls.  Downloads additionally
    get a native Save-As dialog and a direct-to-disk stream (progress is
    pushed back as ``window.__tioDlProgress(taskId, loaded, total)``)."""

    def __init__(self) -> None:
        # underscore-prefixed: pywebview recurses into plain js_api attributes
        # when generating the JS bridge, and walking the Window (WinForms
        # object graph, self-recursive Rectangle.Empty) deadlocks the UI.
        self._window = None
        self._last_push = 0.0
        self._cancels: "dict[int, threading.Event]" = {}

    def cancel_save(self, task_id: int) -> None:
        event = self._cancels.get(int(task_id))
        if event is not None:
            event.set()

    def read_clipboard(self) -> str:
        return _win32_clipboard_read()

    def write_clipboard(self, text: str) -> None:
        _win32_clipboard_write(text)

    def pick_save_path(self, suggested_name: str) -> "str | None":
        """Native Save-As dialog; the chosen full path, or null on cancel."""
        if self._window is None:
            return None
        import webview

        result = self._window.create_file_dialog(webview.FileDialog.SAVE, save_filename=suggested_name)
        if isinstance(result, (list, tuple)) and result:
            return str(result[0])
        return None

    def _push_progress(self, task_id: int, loaded: int, total: "int | None", *, force: bool = False) -> None:
        now = time.monotonic()
        if not force and now - self._last_push < 0.1:
            return
        self._last_push = now
        if self._window is None:
            return
        js_total = "null" if total is None else str(total)
        try:
            self._window.evaluate_js(
                f"window.__tioDlProgress && window.__tioDlProgress({task_id}, {loaded}, {js_total})"
            )
        except Exception:  # pragma: no cover - window closing mid-download
            pass

    def save_url_to(
        self,
        url: str,
        dest_path: str,
        task_id: int,
        method: str = "GET",
        json_body: "dict | None" = None,
    ) -> dict:
        """Stream one of this server's URLs straight to ``dest_path``."""
        import httpx

        loaded = 0
        cancel = self._cancels.setdefault(int(task_id), threading.Event())
        try:
            with httpx.stream(
                method, url, json=json_body, headers={"Accept": "application/octet-stream"}, timeout=None
            ) as response:
                response.raise_for_status()
                total_raw = response.headers.get("content-length")
                total = int(total_raw) if total_raw and total_raw.isdigit() else None
                with open(dest_path, "wb") as handle:
                    for chunk in response.iter_bytes(262144):
                        if cancel.is_set():
                            raise OSError("cancelled")
                        handle.write(chunk)
                        loaded += len(chunk)
                        self._push_progress(task_id, loaded, total)
            self._push_progress(task_id, loaded, None, force=True)
            return {"ok": True, "bytes": loaded, "path": dest_path}
        except Exception as exc:  # noqa: BLE001 - reported to the UI
            try:
                os.remove(dest_path)
            except OSError:
                pass
            return {"ok": False, "error": str(exc), "cancelled": cancel.is_set(), "bytes": loaded, "path": dest_path}
        finally:
            self._cancels.pop(int(task_id), None)


def _pick_port(requested: int) -> int:
    """Resolve ``--port 0`` to a concrete free port before the app is built.

    The Host/Origin guard allow-list is derived from ``server.port`` when the
    app is created, so the real port must be known by then.
    """
    if requested:
        return requested
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


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
    thread = threading.Thread(target=server.run, name="agent-terminal-uvicorn", daemon=True)
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
    parser = argparse.ArgumentParser(prog="agent-desktop", description="agent-terminal desktop window")
    parser.add_argument("--data-dir", help="desktop data directory (default: %LOCALAPPDATA%\\agent-terminal)")
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
            _message(APP_NAME, "agent-terminal desktop is already running.")
            return 0

    data_dir = Path(args.data_dir).expanduser() if args.data_dir else _default_desktop_dir()
    data_dir.mkdir(parents=True, exist_ok=True)
    _setup_logging(_log_path(data_dir))

    try:
        cfg = _make_config(data_dir)
        # The guard's Host/Origin allow-list is built from server.bind/port at
        # app creation, so reflect the actual desktop bind address here.
        cfg.server.bind = args.host
        cfg.server.port = _pick_port(args.port)
        server, thread, port = _start_server(cfg, host=args.host, port=cfg.server.port)
    except (ToolFailure, OSError, RuntimeError) as exc:
        logging.exception("desktop startup failed")
        _message(APP_NAME, f"Could not start: {exc}\n\nSee {_log_path(data_dir)}", error=True)
        return 1

    url = f"http://{args.host}:{port}/"
    logging.info("desktop server listening at %s (data=%s)", url, data_dir)
    if args.smoke:
        # Hit the API the way the WebView2 window will (real Host header).
        with urllib.request.urlopen(f"{url}api/system", timeout=10) as response:
            if response.status != 200:
                raise RuntimeError(f"smoke /api/system returned {response.status}")
        print(url)
        server.should_exit = True
        thread.join(timeout=5)
        return 0

    try:
        import webview

        bridge = DesktopBridge() if sys.platform == "win32" else None
        window = webview.create_window(
            "agent-terminal",
            url,
            width=1280,
            height=860,
            min_size=(1000, 680),
            text_select=True,
            js_api=bridge,
        )
        if bridge is not None:
            bridge._window = window
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
