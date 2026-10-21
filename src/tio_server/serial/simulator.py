"""In-process virtual serial backend + a small simulated board.

This is what makes the whole stack testable without hardware: it implements the
same :class:`~tio_server.serial.base.SerialBackend` contract as the Windows and
POSIX backends, including control lines, unplug/replug and a line-oriented shell
that behaves like a bootloader console.

Port names look like ``sim://<device>``.  Devices are created on first open and
can be pre-created by a test to call :meth:`SimulatedDevice.unplug`.
"""

from __future__ import annotations

import queue
import threading
import time
from typing import Callable

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
)

_SIM_PREFIX = "sim://"


class Channel:
    def __init__(self) -> None:
        self.q: queue.Queue[bytes] = queue.Queue()
        self.pending = bytearray()
        self.closed = threading.Event()

    def put(self, data: bytes) -> None:
        if data and not self.closed.is_set():
            self.q.put(data)

    def close(self) -> None:
        self.closed.set()
        try:
            self.q.put_nowait(b"")
        except queue.Full:  # pragma: no cover - unbounded queue
            pass


class SimulatedDevice:
    """A tiny board simulator with a line-oriented shell."""

    def __init__(self, name: str, *, banner: bool = True) -> None:
        self.name = name
        self.banner = banner
        self._lock = threading.Lock()
        self._channel: Channel | None = None
        self._connected = True
        self._line = bytearray()
        self.lines: list[LineState] = []
        self.dtr = False
        self.rts = False
        self.cts = True
        self.dsr = True
        self.cd = True
        self.ri = False
        self.rx_bytes = 0
        self.tx_bytes = 0
        self.opens = 0
        self._reboot_timer: threading.Timer | None = None

    # ------------------------------------------------------------- lifecycle
    @property
    def connected(self) -> bool:
        return self._connected

    @property
    def attached(self) -> bool:
        return self._channel is not None

    def attach(self, channel: Channel) -> None:
        with self._lock:
            if not self._connected:
                raise PortNotFound(f"simulated device {self.name} is unplugged")
            if self._channel is not None:
                raise PortBusy(f"simulated device {self.name} is already open")
            self._channel = channel
            self.opens += 1
            self._line.clear()
        if self.banner:
            self._emit(f"TioSim v1.0.0  board={self.name}\r\n")
            self._emit("Type 'help' for a list of commands.\r\n")
            self._emit("tiosim> ")

    def detach(self) -> None:
        with self._lock:
            ch, self._channel = self._channel, None
        if ch is not None:
            ch.close()

    def unplug(self) -> None:
        self._connected = False
        self.detach()

    def plug(self) -> None:
        self._connected = True

    def emit(self, text: str | bytes) -> None:
        self._emit(text if isinstance(text, bytes) else text.encode())

    # ------------------------------------------------------------------- I/O
    def _emit(self, data: bytes | str) -> None:
        if isinstance(data, str):
            data = data.encode()
        ch = self._channel
        if ch is not None:
            self.tx_bytes += len(data)
            ch.put(data)

    def host_bytes(self, data: bytes) -> None:
        self.rx_bytes += len(data)
        for byte in data:
            if byte in (0x0D, 0x0A):
                if self._line:
                    line = bytes(self._line).decode("utf-8", "replace")
                    self._line.clear()
                    self._dispatch(line)
            elif byte == 0x03:  # Ctrl-C
                self._line.clear()
                self._emit("^C\r\ntiosim> ")
            elif byte in (0x08, 0x7F):
                if self._line:
                    self._line.pop()
            elif 0x20 <= byte < 0x7F or byte >= 0x80:
                self._line.append(byte)

    # ---------------------------------------------------------------- shell
    def _dispatch(self, line: str) -> None:
        line = line.strip()
        if not line:
            self._emit("tiosim> ")
            return
        cmd, _, rest = line.partition(" ")
        cmd = cmd.lower()
        if cmd in ("help", "?"):
            self._emit(
                "commands:\r\n"
                "  help              this text\r\n"
                "  version           firmware version\r\n"
                "  ping              liveness check\r\n"
                "  echo <text>       echo text back\r\n"
                "  dump <n>          print n bytes of a test pattern\r\n"
                "  sleep <ms>        answer after a delay\r\n"
                "  reboot            simulate a board reset (USB drop)\r\n"
                "\r\ntiosim> "
            )
        elif cmd in ("version", "ver"):
            self._emit(f"tiosim 1.0.0 board={self.name}\r\ntiosim> ")
        elif cmd == "ping":
            self._emit("pong\r\ntiosim> ")
        elif cmd == "echo":
            self._emit(f"{rest}\r\ntiosim> ")
        elif cmd == "dump":
            try:
                n = max(0, min(int(rest or "64"), 65536))
            except ValueError:
                n = 64
            pattern = (b"0123456789abcdef" * ((n // 16) + 1))[:n]
            self._emit(pattern + b"\r\ntiosim> ")
        elif cmd == "sleep":
            try:
                delay = max(0, min(int(rest or "100"), 5000)) / 1000.0
            except ValueError:
                delay = 0.1
            threading.Timer(delay, lambda: self._emit("slept\r\ntiosim> ")).start()
        elif cmd == "reboot":
            self._emit("rebooting...\r\n")
            self._reboot()
        else:
            self._emit(f"ERR unknown command '{cmd}'\r\ntiosim> ")

    def _reboot(self) -> None:
        """Drop the USB link, then come back after 350 ms."""

        def drop() -> None:
            self.unplug()
            self._reboot_timer = threading.Timer(0.35, self.plug)
            self._reboot_timer.daemon = True
            self._reboot_timer.start()

        threading.Thread(target=drop, daemon=True).start()


class SimulatorBackend:
    """A :class:`SerialBackend` over :class:`SimulatedDevice` instances."""

    name = "simulator"

    def __init__(self) -> None:
        self._devices: dict[str, SimulatedDevice] = {}
        self._stats: dict[int, SerialStats] = {}
        self._lock = threading.Lock()

    # ------------------------------------------------------------- devices
    def device(self, name: str) -> SimulatedDevice:
        with self._lock:
            dev = self._devices.get(name)
            if dev is None:
                dev = SimulatedDevice(name)
                self._devices[name] = dev
            return dev

    def devices(self) -> dict[str, SimulatedDevice]:
        with self._lock:
            return dict(self._devices)

    # --------------------------------------------------------------- listing
    def list_ports(self) -> list[PortInfo]:
        out = []
        for name, dev in self.devices().items():
            if not dev.connected:
                continue
            out.append(
                PortInfo(
                    port=f"{_SIM_PREFIX}{name}",
                    os="simulator",
                    by_id=f"{_SIM_PREFIX}{name}",
                    description=f"TioSim {name}",
                    manufacturer="tio-suite",
                    product="simulated board",
                    is_usb=True,
                )
            )
        return out

    # ------------------------------------------------------------------ open
    def open(self, cfg: SerialConfig) -> SerialHandle:
        if not cfg.port.startswith(_SIM_PREFIX):
            raise InvalidConfig(f"simulator backend only accepts sim:// ports, got {cfg.port!r}")
        name = cfg.port[len(_SIM_PREFIX) :]
        if not name:
            raise InvalidConfig("sim:// port needs a device name")
        dev = self.device(name)
        ch = Channel()
        dev.attach(ch)
        handle = SerialHandle(port=cfg.port, impl=ch, extra={"device": dev})
        with self._lock:
            self._stats[id(ch)] = SerialStats(open_count=1)
        return handle

    def close(self, handle: SerialHandle) -> None:
        dev: SimulatedDevice = handle.extra["device"]
        dev.detach()
        with self._lock:
            self._stats.pop(id(handle.impl), None)

    # ------------------------------------------------------------------- I/O
    def read(self, handle: SerialHandle, max_bytes: int, timeout_ms: int) -> bytes:
        ch: Channel = handle.impl  # type: ignore[assignment]
        if ch.closed.is_set():
            raise Disconnected("simulated device disconnected")
        deadline = time.monotonic() + max(0, timeout_ms) / 1000.0
        buf = bytearray(ch.pending)
        ch.pending.clear()
        while len(buf) < max_bytes:
            remaining = deadline - time.monotonic()
            if remaining <= 0 and buf:
                break
            try:
                chunk = ch.q.get(timeout=max(0.001, min(remaining, 0.05)) if remaining > 0 else 0.001)
            except queue.Empty:
                if ch.closed.is_set():
                    raise Disconnected("simulated device disconnected")
                if buf or remaining <= 0:
                    break
                continue
            if chunk == b"" and ch.closed.is_set():
                raise Disconnected("simulated device disconnected")
            buf.extend(chunk)
            # Return promptly with what is available.
            if ch.q.empty():
                break
        data = bytes(buf[:max_bytes])
        if len(buf) > max_bytes:
            # Keep the remainder so no byte is lost.
            ch.pending.extend(buf[max_bytes:])
        self._bump(handle, rx=len(data))
        return data

    def write(self, handle: SerialHandle, data: bytes, timeout_ms: int) -> int:
        ch: Channel = handle.impl  # type: ignore[assignment]
        if ch.closed.is_set():
            raise Disconnected("simulated device disconnected")
        dev: SimulatedDevice = handle.extra["device"]
        dev.host_bytes(data)
        self._bump(handle, tx=len(data))
        return len(data)

    def configure(self, handle: SerialHandle, cfg: SerialConfig) -> None:
        return None

    # ----------------------------------------------------------------- lines
    def get_lines(self, handle: SerialHandle) -> LineState:
        dev: SimulatedDevice = handle.extra["device"]
        return LineState(dtr=dev.dtr, rts=dev.rts, cts=dev.cts, dsr=dev.dsr, cd=dev.cd, ri=dev.ri)

    def set_lines(self, handle: SerialHandle, dtr: bool | None, rts: bool | None) -> LineState:
        dev: SimulatedDevice = handle.extra["device"]
        if dtr is not None:
            dev.dtr = bool(dtr)
        if rts is not None:
            dev.rts = bool(rts)
        state = self.get_lines(handle)
        dev.lines.append(state)
        return state

    def pulse_line(self, handle: SerialHandle, line: str, active: bool, duration_ms: int) -> None:
        if line not in ("dtr", "rts"):
            raise InvalidConfig(f"unknown control line: {line}")
        dev: SimulatedDevice = handle.extra["device"]
        previous = getattr(dev, line)
        setattr(dev, line, bool(active))
        dev.lines.append(self.get_lines(handle))
        time.sleep(max(0, duration_ms) / 1000.0)
        setattr(dev, line, previous)
        dev.lines.append(self.get_lines(handle))

    def flush(self, handle: SerialHandle, input: bool, output: bool) -> None:
        ch: Channel = handle.impl  # type: ignore[assignment]
        if input:
            ch.pending.clear()
            while True:
                try:
                    ch.q.get_nowait()
                except queue.Empty:
                    break

    def send_break(self, handle: SerialHandle, duration_ms: int) -> None:
        time.sleep(min(max(0, duration_ms), 500) / 1000.0)

    def stats(self, handle: SerialHandle) -> SerialStats:
        with self._lock:
            st = self._stats.get(id(handle.impl))
            return SerialStats(rx_bytes=st.rx_bytes, tx_bytes=st.tx_bytes, open_count=st.open_count, read_errors=st.read_errors, write_errors=st.write_errors, overflow_errors=st.overflow_errors) if st else SerialStats()

    # --------------------------------------------------------------- helpers
    def _bump(self, handle: SerialHandle, *, rx: int = 0, tx: int = 0) -> None:
        with self._lock:
            st = self._stats.get(id(handle.impl))
            if st is None:
                st = SerialStats()
                self._stats[id(handle.impl)] = st
            st.rx_bytes += rx
            st.tx_bytes += tx


def wait_until(predicate: Callable[[], bool], timeout: float = 2.0, interval: float = 0.01) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return predicate()
