"""POSIX (Linux/macOS) serial backend using termios, ioctl and os.read.

Design choices that the rest of the system depends on:

* ``O_NONBLOCK`` open plus ``VMIN=0``/``VTIME=0`` so reads never block the
  session reader thread forever; waiting uses ``select()``.
* ``flock(LOCK_EX|LOCK_NB)`` plus ``TIOCEXCL`` gives exclusive access, so a
  second process (including the ``tio`` CLI) fails fast with ``PORT_BUSY``.
* The original termios state is saved and restored on close, so we do not leave
  the port in raw mode.
* Non-standard baud rates use Linux ``termios2`` (``TCGETS2``/``TCSETS2``) and
  macOS ``IOSSIOSPEED``.
* mark/space parity uses ``CMSPAR`` (Linux only).
* RS-485 uses ``TIOCSRS485`` when requested and the driver supports it.
"""

from __future__ import annotations

import errno
import fcntl
import os
import select
import struct
import termios
import time
from pathlib import Path

from serial.tools import list_ports as serial_list_ports

from .base import (
    Disconnected,
    InvalidConfig,
    LineState,
    PortBusy,
    PortInfo,
    PortNotFound,
    SerialConfig,
    SerialHandle,
    SerialStats,
    Unsupported,
)

_BAUD_MAP = {
    50: termios.B50,
    75: termios.B75,
    110: termios.B110,
    134: termios.B134,
    150: termios.B150,
    200: termios.B200,
    300: termios.B300,
    600: termios.B600,
    1200: termios.B1200,
    1800: termios.B1800,
    2400: termios.B2400,
    4800: termios.B4800,
    9600: termios.B9600,
    19200: termios.B19200,
    38400: termios.B38400,
    57600: termios.B57600,
    115200: termios.B115200,
    230400: getattr(termios, "B230400", None),
    460800: getattr(termios, "B460800", None),
    500000: getattr(termios, "B500000", None),
    576000: getattr(termios, "B576000", None),
    921600: getattr(termios, "B921600", None),
    1000000: getattr(termios, "B1000000", None),
    1152000: getattr(termios, "B1152000", None),
    1500000: getattr(termios, "B1500000", None),
    2000000: getattr(termios, "B2000000", None),
    2500000: getattr(termios, "B2500000", None),
    3000000: getattr(termios, "B3000000", None),
    3500000: getattr(termios, "B3500000", None),
    4000000: getattr(termios, "B4000000", None),
}
_BAUD_MAP = {k: v for k, v in _BAUD_MAP.items() if v is not None}

_TIOCM_DTR = 0x002
_TIOCM_RTS = 0x004
_TIOCM_CTS = 0x020
_TIOCM_DSR = 0x100
_TIOCM_CD = 0x040
_TIOCM_RI = 0x080

_TCGETS2 = 0x802C542A
_TCSETS2 = 0x402C542B
_BOTHER = 0o010000
_CBAUD = 0o010017
_IOSSIOSPEED = 0x80045402  # macOS
_TIOCSRS485 = 0x542F


class _Termios2(Structure := __import__("ctypes").Structure):  # type: ignore[misc]
    _fields_ = [
        ("c_iflag", __import__("ctypes").c_uint),
        ("c_oflag", __import__("ctypes").c_uint),
        ("c_cflag", __import__("ctypes").c_uint),
        ("c_lflag", __import__("ctypes").c_uint),
        ("c_line", __import__("ctypes").c_ubyte),
        ("c_cc", __import__("ctypes").c_ubyte * 32),
        ("c_ispeed", __import__("ctypes").c_uint),
        ("c_ospeed", __import__("ctypes").c_uint),
    ]


class PosixBackend:
    name = "posix"

    def __init__(self) -> None:
        self._stats: dict[int, SerialStats] = {}

    # ------------------------------------------------------------------ ports
    def list_ports(self) -> list[PortInfo]:
        by_id: dict[str, str] = {}
        base = Path("/dev/serial/by-id")
        if base.is_dir():
            for entry in base.iterdir():
                try:
                    by_id[str(entry.resolve())] = str(entry)
                except OSError:
                    continue
        out: list[PortInfo] = []
        for info in serial_list_ports.comports():
            out.append(
                PortInfo(
                    port=info.device,
                    os="posix",
                    by_id=by_id.get(str(Path(info.device).resolve())),
                    description=info.description or "",
                    vid=f"{info.vid:04X}" if info.vid else None,
                    pid=f"{info.pid:04X}" if info.pid else None,
                    serial_number=info.serial_number,
                    manufacturer=info.manufacturer,
                    product=info.product,
                    driver=getattr(info, "driver", None) or (info.hwid or None),
                    is_usb=(info.vid is not None),
                )
            )
        out.sort(key=lambda p: p.port)
        return out

    # ------------------------------------------------------------------- open
    def open(self, cfg: SerialConfig) -> SerialHandle:
        if float(cfg.stopbits) == 1.5:
            raise Unsupported("1.5 stop bits is not supported on POSIX")
        path = str(Path(cfg.port).expanduser())
        try:
            fd = os.open(path, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK | getattr(os, "O_CLOEXEC", 0))
        except OSError as exc:
            if exc.errno in (errno.ENOENT, errno.ENODEV):
                raise PortNotFound(f"{path}: no such device", details={"port": cfg.port}) from exc
            if exc.errno in (errno.EBUSY, errno.EACCES, errno.EPERM):
                raise PortBusy(f"{path}: {exc.strerror}", details={"port": cfg.port}) from exc
            raise PortNotFound(str(exc), details={"port": cfg.port}) from exc

        if not os.isatty(fd):
            os.close(fd)
            raise InvalidConfig(f"{path} is not a serial port (not a tty)")

        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            os.close(fd)
            raise PortBusy(f"{path} is locked by another process", details={"port": cfg.port}) from exc

        try:
            fcntl.ioctl(fd, termios.TIOCEXCL)
        except OSError:
            pass

        original = termios.tcgetattr(fd)
        handle = SerialHandle(port=cfg.port, impl=fd, original=original)
        try:
            self._apply(fd, cfg)
        except Exception:
            try:
                termios.tcsetattr(fd, termios.TCSANOW, original)
            except OSError:
                pass
            try:
                fcntl.flock(fd, fcntl.LOCK_UN)
            except OSError:
                pass
            os.close(fd)
            raise
        self._stats.setdefault(fd, SerialStats(open_count=1))
        return handle

    def _apply(self, fd: int, cfg: SerialConfig) -> None:
        attrs = termios.tcgetattr(fd)
        iflag, oflag, cflag, lflag, _, _, cc = attrs
        # cfmakeraw
        iflag &= ~(termios.IGNBRK | termios.BRKINT | termios.PARMRK | termios.ISTRIP)
        iflag &= ~(termios.INLCR | termios.IGNCR | termios.ICRNL)
        oflag &= ~termios.OPOST
        lflag &= ~(termios.ECHO | termios.ECHONL | termios.ICANON | termios.ISIG | termios.IEXTEN)
        cflag &= ~(termios.CSIZE | termios.PARENB | termios.CSTOPB)

        cflag |= termios.CLOCAL | termios.CREAD
        sizes = {5: termios.CS5, 6: termios.CS6, 7: termios.CS7, 8: termios.CS8}
        cflag |= sizes.get(int(cfg.bytesize), termios.CS8)

        if cfg.parity != "none":
            cflag |= termios.PARENB
            if cfg.parity in ("odd", "mark"):
                cflag |= termios.PARODD
            if cfg.parity in ("mark", "space"):
                cmspar = getattr(termios, "CMSPAR", None)
                if cmspar is None:
                    raise Unsupported("mark/space parity is not supported on this platform")
                cflag |= cmspar
        if float(cfg.stopbits) == 2:
            cflag |= termios.CSTOPB

        if cfg.flow == "hard":
            cflag |= getattr(termios, "CRTSCTS", 0)
            iflag &= ~(termios.IXON | termios.IXOFF | termios.IXANY)
        elif cfg.flow == "soft":
            iflag |= termios.IXON | termios.IXOFF
            cflag &= ~getattr(termios, "CRTSCTS", 0)
        else:
            iflag &= ~(termios.IXON | termios.IXOFF | termios.IXANY)
            cflag &= ~getattr(termios, "CRTSCTS", 0)

        cc = list(cc)
        cc[termios.VMIN] = 0
        cc[termios.VTIME] = 0
        attrs = [iflag, oflag, cflag, lflag, termios.B0, termios.B0, cc]
        termios.tcsetattr(fd, termios.TCSANOW, attrs)
        self._set_baud(fd, int(cfg.baudrate))

    def _set_baud(self, fd: int, baud: int) -> None:
        speed = _BAUD_MAP.get(baud)
        if speed is not None:
            attrs = termios.tcgetattr(fd)
            attrs[4] = speed
            attrs[5] = speed
            termios.tcsetattr(fd, termios.TCSANOW, attrs)
            return
        # Arbitrary baud rates.
        import ctypes

        if os.uname().sysname == "Darwin":  # type: ignore[attr-defined]
            speed_val = ctypes.c_ulong(baud)
            fcntl.ioctl(fd, _IOSSIOSPEED, speed_val, True)
            return
        t2 = _Termios2()
        fcntl.ioctl(fd, _TCGETS2, t2)
        t2.c_cflag &= ~_CBAUD
        t2.c_cflag |= _BOTHER
        t2.c_ispeed = baud
        t2.c_ospeed = baud
        fcntl.ioctl(fd, _TCSETS2, t2)

    def close(self, handle: SerialHandle) -> None:
        fd = handle.impl
        if handle.original is not None:
            try:
                termios.tcsetattr(fd, termios.TCSANOW, handle.original)
            except OSError:
                pass
        try:
            fcntl.ioctl(fd, getattr(termios, "TIOCNXCL", 0))
        except OSError:
            pass
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        except OSError:
            pass
        self._stats.pop(fd, None)
        try:
            os.close(fd)
        except OSError:
            pass

    # -------------------------------------------------------------------- I/O
    def read(self, handle: SerialHandle, max_bytes: int, timeout_ms: int) -> bytes:
        fd = handle.impl
        try:
            ready, _, _ = select.select([fd], [], [], max(0, timeout_ms) / 1000.0)
        except (OSError, ValueError) as exc:
            raise Disconnected(str(exc)) from exc
        if not ready:
            return b""
        try:
            data = os.read(fd, max_bytes)
        except BlockingIOError:
            return b""
        except OSError as exc:
            if exc.errno in (errno.EIO, errno.ENXIO, errno.EBADF, errno.ENODEV):
                raise Disconnected(str(exc)) from exc
            raise
        if data:
            self._stats.setdefault(fd, SerialStats()).rx_bytes += len(data)
        return data

    def write(self, handle: SerialHandle, data: bytes, timeout_ms: int) -> int:
        fd = handle.impl
        deadline = time.monotonic() + max(1, timeout_ms) / 1000.0
        written = 0
        view = memoryview(data)
        while written < len(data):
            try:
                n = os.write(fd, view[written:])
                written += n
            except BlockingIOError:
                if time.monotonic() > deadline:
                    break
                time.sleep(0.002)
            except OSError as exc:
                if exc.errno in (errno.EIO, errno.ENXIO, errno.EBADF, errno.ENODEV):
                    raise Disconnected(str(exc)) from exc
                raise
        if written:
            self._stats.setdefault(fd, SerialStats()).tx_bytes += written
        return written

    def configure(self, handle: SerialHandle, cfg: SerialConfig) -> None:
        self._apply(handle.impl, cfg)

    # ----------------------------------------------------------------- lines
    def get_lines(self, handle: SerialHandle) -> LineState:
        fd = handle.impl
        try:
            bits = fcntl.ioctl(fd, termios.TIOCMGET)
        except OSError as exc:
            raise Disconnected(str(exc)) from exc
        return LineState(
            dtr=bool(bits & _TIOCM_DTR),
            rts=bool(bits & _TIOCM_RTS),
            cts=bool(bits & _TIOCM_CTS),
            dsr=bool(bits & _TIOCM_DSR),
            cd=bool(bits & _TIOCM_CD),
            ri=bool(bits & _TIOCM_RI),
        )

    def set_lines(self, handle: SerialHandle, dtr: bool | None, rts: bool | None) -> LineState:
        fd = handle.impl
        try:
            bits = fcntl.ioctl(fd, termios.TIOCMGET)
        except OSError as exc:
            raise Disconnected(str(exc)) from exc
        if dtr is not None:
            bits = (bits | _TIOCM_DTR) if dtr else (bits & ~_TIOCM_DTR)
        if rts is not None:
            bits = (bits | _TIOCM_RTS) if rts else (bits & ~_TIOCM_RTS)
        try:
            fcntl.ioctl(fd, termios.TIOCMSET, struct.pack("I", bits))
        except OSError as exc:
            raise Disconnected(str(exc)) from exc
        return self.get_lines(handle)

    def pulse_line(self, handle: SerialHandle, line: str, active: bool, duration_ms: int) -> None:
        if line not in ("dtr", "rts"):
            raise InvalidConfig(f"unknown control line: {line}")
        current = self.get_lines(handle)
        previous = getattr(current, line)
        kwargs = {line: bool(active)}
        self.set_lines(handle, **kwargs)  # type: ignore[arg-type]
        time.sleep(max(0, duration_ms) / 1000.0)
        self.set_lines(handle, **{line: previous})  # type: ignore[arg-type]

    def flush(self, handle: SerialHandle, input: bool, output: bool) -> None:
        fd = handle.impl
        queue = 0
        if input:
            queue |= termios.TCIFLUSH
        if output:
            queue |= termios.TCOFLUSH
        try:
            termios.tcflush(fd, queue)
        except OSError as exc:
            raise Disconnected(str(exc)) from exc

    def send_break(self, handle: SerialHandle, duration_ms: int) -> None:
        try:
            termios.tcsendbreak(handle.impl, max(0, duration_ms) // 100)
        except OSError as exc:
            raise Disconnected(str(exc)) from exc

    # ----------------------------------------------------------------- rs485
    def set_rs485(
        self,
        handle: SerialHandle,
        *,
        enabled: bool,
        rts_level_for_tx: bool = True,
        rts_level_for_rx: bool = False,
        delay_before_ms: int = 0,
        delay_after_ms: int = 0,
    ) -> None:
        if os.uname().sysname != "Linux":  # type: ignore[attr-defined]
            raise Unsupported("RS-485 configuration is Linux-only")
        # struct serial_rs485 { __u32 flags; __u32 delay_rts_before_send; __u32 delay_rts_after_send; __u32 padding[5]; }
        flags = 0
        if enabled:
            flags |= 0x01  # SER_RS485_ENABLED
        if rts_level_for_tx:
            flags |= 0x02  # SER_RS485_RTS_ON_SEND
        else:
            flags |= 0x04  # SER_RS485_RTS_AFTER_SEND
        if not rts_level_for_rx:
            flags |= 0x08  # SER_RS485_RX_DURING_TX off -> no, this flag enables RX during TX
        payload = struct.pack("8I", flags, delay_before_ms, delay_after_ms, 0, 0, 0, 0, 0)
        try:
            fcntl.ioctl(handle.impl, _TIOCSRS485, payload)
        except OSError as exc:
            raise Unsupported(f"driver refused RS-485 ioctl: {exc}") from exc

    def stats(self, handle: SerialHandle) -> SerialStats:
        st = self._stats.get(handle.impl)
        return SerialStats(rx_bytes=st.rx_bytes, tx_bytes=st.tx_bytes, open_count=st.open_count, read_errors=st.read_errors, write_errors=st.write_errors, overflow_errors=st.overflow_errors) if st else SerialStats()


def make_backend() -> PosixBackend:
    return PosixBackend()
