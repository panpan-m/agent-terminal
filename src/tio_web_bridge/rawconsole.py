"""Raw console handling for :mod:`tio_web_bridge`.

The bridge must move *bytes* between ttyd's PTY and the serial WebSocket:

* no line buffering, no echo, no CR/LF translation;
* ``Ctrl-C`` must arrive as ``0x03``, not as a signal;
* nothing may be printed to stdout except serial bytes.

On POSIX this is ``tty.setraw``.  On Windows the bridge usually runs inside a
ConPTY created by ttyd, so it is a console application: we clear
``ENABLE_LINE_INPUT``/``ENABLE_ECHO_INPUT``/``ENABLE_PROCESSED_INPUT`` and read
the console in raw chunks.  If the console cannot be read as a byte stream we
fall back to ``msvcrt`` and translate special keys back to VT sequences, which
is what ttyd's browser terminal sends.
"""

from __future__ import annotations

import os
import sys
import threading

_WIN_SPECIAL = {
    "H": "\x1b[A",  # up
    "P": "\x1b[B",  # down
    "M": "\x1b[C",  # right
    "K": "\x1b[D",  # left
    "G": "\x1b[H",  # home
    "O": "\x1b[F",  # end
    "R": "\x1b[2~",  # insert
    "S": "\x1b[3~",  # delete
    "I": "\x1b[5~",  # page up
    "Q": "\x1b[6~",  # page down
    ";": "\x1bOP",
    "<": "\x1bOQ",
    "=": "\x1bOR",
    ">": "\x1bOS",
}


class RawConsole:
    """Cross-platform raw stdin/stdout."""

    def __init__(self) -> None:
        self.is_windows = os.name == "nt"
        self._restore: tuple | None = None
        self._stop = threading.Event()

    # ---------------------------------------------------------------- lifetime
    def enter(self) -> None:
        if self.is_windows:
            self._enter_windows()
        else:
            self._enter_posix()

    def exit(self) -> None:
        if not self.is_windows and self._restore is not None:
            import termios

            try:
                termios.tcsetattr(0, termios.TCSANOW, self._restore)
            except OSError:
                pass
        self._restore = None

    # ------------------------------------------------------------------- posix
    def _enter_posix(self) -> None:
        import termios
        import tty

        try:
            self._restore = termios.tcgetattr(0)
        except termios.error:
            self._restore = None
        try:
            tty.setraw(0)
        except termios.error:
            pass

    # ----------------------------------------------------------------- windows
    def _enter_windows(self) -> None:
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.windll.kernel32
        STD_INPUT_HANDLE = -10
        handle = kernel32.GetStdHandle(STD_INPUT_HANDLE)
        mode = wintypes.DWORD()
        if not kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
            return
        self._restore = (handle, mode.value)
        ENABLE_PROCESSED_INPUT = 0x0001
        ENABLE_LINE_INPUT = 0x0002
        ENABLE_ECHO_INPUT = 0x0004
        new_mode = mode.value & ~(ENABLE_PROCESSED_INPUT | ENABLE_LINE_INPUT | ENABLE_ECHO_INPUT)
        kernel32.SetConsoleMode(handle, new_mode)

    # -------------------------------------------------------------------- read
    def read(self, size: int = 4096) -> bytes:
        """Block until some input is available; return b'' only on EOF."""
        if self.is_windows:
            return self._read_windows(size)
        try:
            return os.read(0, size)
        except InterruptedError:
            return b""

    def _read_windows(self, size: int) -> bytes:
        # A pipe (tests, redirected input) is a byte stream.
        try:
            data = os.read(0, size)
            return data
        except OSError:
            pass
        import msvcrt

        chunk = bytearray()
        while len(chunk) < size:
            if self._stop.is_set():
                break
            ch = msvcrt.getwch()
            if not ch:
                continue
            if ch in ("\x00", "\xe0"):
                code = msvcrt.getwch()
                chunk.extend(_WIN_SPECIAL.get(code, "").encode())
                continue
            if ch == "\x03":  # Ctrl-C: forward, do not raise
                chunk.append(0x03)
                continue
            chunk.extend(ch.encode("utf-8", "replace"))
            if not msvcrt.kbhit():
                break
        return bytes(chunk)

    # ------------------------------------------------------------------- write
    @staticmethod
    def write(data: bytes) -> None:
        if not data:
            return
        try:
            os.write(1, data)
        except OSError:
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()

    def request_stop(self) -> None:
        self._stop.set()
