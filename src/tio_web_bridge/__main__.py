"""``tio-web-bridge``: ttyd PTY <-> tio-server WebSocket byte pump.

ttyd runs this program as its child command.  We never open the serial port: the
server stays the single owner and this process only forwards bytes.

    stdin  --(keyboard bytes)--> WebSocket binary frame --> tio-server --> UART
    stdout <--(binary frame)---- WebSocket ------------- tio-server <-- UART
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import sys
import threading
import time
from pathlib import Path

from .rawconsole import RawConsole


def _read_token(args: argparse.Namespace) -> str | None:
    if args.token:
        return args.token
    if args.token_file:
        try:
            return Path(args.token_file).read_text(encoding="utf-8").strip()
        except OSError:
            return None
    return os.environ.get("TIO_BRIDGE_TOKEN")


def _ws_url(url: str, mode: str, replay: int) -> str:
    sep = "&" if "?" in url else "?"
    return f"{url}{sep}mode={mode}&replay={replay}"


def bridge_loop(url: str, mode: str, token: str | None, replay: int, console: RawConsole, stop: threading.Event) -> None:
    from websockets.exceptions import ConnectionClosed
    from websockets.sync.client import connect

    backoff = 0.2
    while not stop.is_set():
        try:
            with connect(
                _ws_url(url, mode, replay),
                open_timeout=5,
                max_size=None,
                additional_headers={"X-Bridge-Token": token} if token else None,
            ) as ws:
                backoff = 0.2

                def upstream() -> None:
                    while not stop.is_set():
                        try:
                            data = console.read(4096)
                        except Exception:
                            stop.set()
                            return
                        if not data:
                            stop.set()
                            try:
                                ws.close()
                            except Exception:
                                pass
                            return
                        try:
                            ws.send(data)
                        except Exception:
                            return

                reader = threading.Thread(target=upstream, name="stdin->ws", daemon=True)
                reader.start()
                while not stop.is_set():
                    try:
                        message = ws.recv(timeout=0.5)
                    except TimeoutError:
                        continue
                    if isinstance(message, bytes):
                        console.write(message)
                    else:
                        try:
                            payload = json.loads(message)
                        except json.JSONDecodeError:
                            continue
                        if payload.get("type") == "error":
                            err = payload.get("error", {})
                            sys.stderr.write(f"tio-web-bridge: {err.get('code')}: {err.get('message')}\n")
                            sys.stderr.flush()
                        # status/hello/overflow are informational for the terminal bridge
                stop.set()
        except (OSError, ConnectionClosed, TimeoutError) as exc:
            if stop.is_set():
                return
            sys.stderr.write(f"tio-web-bridge: reconnect after {exc}\n")
            sys.stderr.flush()
            stop.wait(backoff)
            backoff = min(5.0, backoff * 2)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="tio-web-bridge", description="ttyd <-> tio-server bridge")
    parser.add_argument("--url", required=True, help="ws://host:port/ws/bridge/<session>")
    parser.add_argument("--mode", choices=("ro", "rw"), default="ro")
    parser.add_argument("--token-file")
    parser.add_argument("--token")
    parser.add_argument("--replay-bytes", type=int, default=4096)
    parser.add_argument("--no-raw", action="store_true", help="do not touch terminal modes (tests)")
    args = parser.parse_args(argv)

    token = _read_token(args)
    if not token:
        sys.stderr.write("tio-web-bridge: no bridge token (use --token-file or TIO_BRIDGE_TOKEN)\n")
        return 2

    console = RawConsole()
    stop = threading.Event()

    def _signal(signum, frame):  # pragma: no cover - signal path
        stop.set()
        console.request_stop()

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, _signal)
        except (ValueError, OSError):
            pass

    if not args.no_raw:
        console.enter()
    try:
        bridge_loop(args.url, args.mode, token, args.replay_bytes, console, stop)
    finally:
        if not args.no_raw:
            console.exit()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
