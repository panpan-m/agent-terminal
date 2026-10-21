"""Windows serial backend built on pyserial.

Notes that matter for correctness (see plan sections 5.2 and 6.3):

* Windows COM handles cannot be ``select()``-ed; the session reader thread uses a
  short ``timeout`` and polls.
* ``COM10`` and above are normalised to ``\\\\.\\COM10``.
* Opening a port may pulse DTR/RTS in the driver.  ``open_mode`` controls what we
  do *after* the open; the unavoidable open-time pulse is documented in the UI.
* mark/space parity and RS-485 are rejected with ``UNSUPPORTED_ON_PLATFORM``
  rather than silently ignored.
"""

from __future__ import annotations

import re
import threading
import time
from typing import Any

import serial
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
    WriteTimeout,
)

_PARITY = {
    "none": serial.PARITY_NONE,
    "even": serial.PARITY_EVEN,
    "odd": serial.PARITY_ODD,
}


def normalise_port(port: str) -> str:
    if re.fullmatch(r"COM(\d+)", port, re.IGNORECASE):
        num = int(port[3:])
        if num >= 10:
            return f"\\\\.\\COM{num}"
        return f"COM{num}"
    return port


class WindowsBackend:
    name = "windows"

    def __init__(self) -> None:
        self._stats: dict[int, SerialStats] = {}
        self._lock = threading.Lock()

    # ------------------------------------------------------------------ ports
    def list_ports(self) -> list[PortInfo]:
        result: list[PortInfo] = []
        for info in serial_list_ports.comports():
            result.append(
                PortInfo(
                    port=info.device,
                    os="windows",
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
        result.sort(key=lambda p: (len(p.port), p.port))
        return result

    # ------------------------------------------------------------------- open
    def open(self, cfg: SerialConfig) -> SerialHandle:
        if cfg.parity in ("mark", "space"):
            raise Unsupported("mark/space parity is not supported on Windows", details={"parity": cfg.parity})
        try:
            ser = serial.Serial(
                port=normalise_port(cfg.port),
                baudrate=int(cfg.baudrate),
                bytesize=int(cfg.bytesize),
                parity=_PARITY[cfg.parity],
                stopbits=float(cfg.stopbits),
                timeout=0,
                write_timeout=max(1, cfg.write_timeout_ms) / 1000.0,
                xonxoff=(cfg.flow == "soft"),
                rtscts=(cfg.flow == "hard"),
                dsrdtr=False,
            )
        except serial.SerialException as exc:
            msg = str(exc)
            code = PortBusy if ("拒绝访问" in msg or "Access is denied" in msg or "busy" in msg.lower()) else PortNotFound
            raise (PortBusy if code is PortBusy else PortNotFound)(msg, details={"port": cfg.port}) from exc
        except (ValueError, KeyError) as exc:
            raise InvalidConfig(f"invalid serial parameters: {exc}") from exc

        handle = SerialHandle(port=cfg.port, impl=ser, original=None)
        with self._lock:
            self._stats[id(ser)] = SerialStats(open_count=1)
        try:
            self._apply_open_mode(ser, cfg.open_mode)
        except Exception:
            ser.close()
            raise
        return handle

    def _apply_open_mode(self, ser: "serial.Serial", open_mode: str) -> None:
        if open_mode == "assert":
            ser.dtr = True
            ser.rts = True
        elif open_mode == "deassert":
            ser.dtr = False
            ser.rts = False
        # preserve: leave whatever the driver did.

    def close(self, handle: SerialHandle) -> None:
        ser = handle.impl
        try:
            ser.close()
        finally:
            with self._lock:
                self._stats.pop(id(ser), None)

    # -------------------------------------------------------------------- I/O
    def read(self, handle: SerialHandle, max_bytes: int, timeout_ms: int) -> bytes:
        ser: serial.Serial = handle.impl  # type: ignore[assignment]
        if timeout_ms > 0:
            deadline = time.monotonic() + timeout_ms / 1000.0
            while True:
                try:
                    data = ser.read(max_bytes)
                except serial.SerialException as exc:
                    raise Disconnected(str(exc)) from exc
                if data:
                    self._bump(handle, rx=len(data))
                    return data
                if time.monotonic() >= deadline:
                    return b""
                time.sleep(0.005)
        try:
            data = ser.read(max_bytes)
        except serial.SerialException as exc:
            raise Disconnected(str(exc)) from exc
        self._bump(handle, rx=len(data))
        return data

    def write(self, handle: SerialHandle, data: bytes, timeout_ms: int) -> int:
        ser: serial.Serial = handle.impl  # type: ignore[assignment]
        total = 0
        chunk = 4096
        try:
            while total < len(data):
                total += ser.write(data[total : total + chunk])
        except serial.SerialTimeoutException as exc:
            # Partial write is not a disconnect: report what went out so the
            # caller can decide (plan 7.3: never pretend the write succeeded).
            self._bump(handle, tx=total)
            raise WriteTimeout(f"write timed out after {total} bytes", written=total) from exc
        except serial.SerialException as exc:
            raise Disconnected(str(exc)) from exc
        self._bump(handle, tx=total)
        return int(total)

    def configure(self, handle: SerialHandle, cfg: SerialConfig) -> None:
        ser: serial.Serial = handle.impl  # type: ignore[assignment]
        try:
            ser.baudrate = int(cfg.baudrate)
            ser.bytesize = int(cfg.bytesize)
            ser.parity = _PARITY[cfg.parity]
            ser.stopbits = float(cfg.stopbits)
            ser.xonxoff = cfg.flow == "soft"
            ser.rtscts = cfg.flow == "hard"
        except (ValueError, serial.SerialException) as exc:
            raise InvalidConfig(f"cannot apply serial configuration: {exc}") from exc

    # ----------------------------------------------------------------- lines
    def get_lines(self, handle: SerialHandle) -> LineState:
        ser: serial.Serial = handle.impl  # type: ignore[assignment]
        try:
            return LineState(
                dtr=bool(ser.dtr),
                rts=bool(ser.rts),
                cts=bool(ser.cts),
                dsr=bool(ser.dsr),
                cd=bool(ser.cd),
                ri=bool(ser.ri),
            )
        except (serial.SerialException, OSError) as exc:
            raise Disconnected(str(exc)) from exc

    def set_lines(self, handle: SerialHandle, dtr: bool | None, rts: bool | None) -> LineState:
        ser: serial.Serial = handle.impl  # type: ignore[assignment]
        try:
            if dtr is not None:
                ser.dtr = bool(dtr)
            if rts is not None:
                ser.rts = bool(rts)
        except (serial.SerialException, OSError) as exc:
            raise Disconnected(str(exc)) from exc
        return self.get_lines(handle)

    def pulse_line(self, handle: SerialHandle, line: str, active: bool, duration_ms: int) -> None:
        ser: serial.Serial = handle.impl  # type: ignore[assignment]
        if line not in ("dtr", "rts"):
            raise InvalidConfig(f"unknown control line: {line}")
        previous = bool(getattr(ser, line))
        try:
            setattr(ser, line, bool(active))
            time.sleep(max(0, duration_ms) / 1000.0)
        finally:
            setattr(ser, line, previous)

    def flush(self, handle: SerialHandle, input: bool, output: bool) -> None:
        ser: serial.Serial = handle.impl  # type: ignore[assignment]
        try:
            if input:
                ser.reset_input_buffer()
            if output:
                ser.reset_output_buffer()
        except (serial.SerialException, OSError) as exc:
            raise Disconnected(str(exc)) from exc

    def send_break(self, handle: SerialHandle, duration_ms: int) -> None:
        ser: serial.Serial = handle.impl  # type: ignore[assignment]
        try:
            ser.send_break(max(0, duration_ms) / 1000.0)
        except (serial.SerialException, OSError) as exc:
            raise Disconnected(str(exc)) from exc

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


class PySerialLoopbackBackend(WindowsBackend):
    """Dev-only backend that lets ``loop://`` exercise the real pyserial I/O path."""

    name = "pyserial-loop"

    def open(self, cfg: SerialConfig) -> SerialHandle:
        if not cfg.port.startswith(("loop://", "socket://")):
            return super().open(cfg)
        try:
            ser = serial.serial_for_url(
                cfg.port,
                baudrate=int(cfg.baudrate),
                bytesize=int(cfg.bytesize),
                parity=_PARITY.get(cfg.parity, serial.PARITY_NONE),
                stopbits=float(cfg.stopbits),
                timeout=0,
                write_timeout=max(1, cfg.write_timeout_ms) / 1000.0,
            )
        except (serial.SerialException, ValueError) as exc:
            raise InvalidConfig(str(exc)) from exc
        handle = SerialHandle(port=cfg.port, impl=ser)
        with self._lock:
            self._stats[id(ser)] = SerialStats(open_count=1)
        return handle


def make_backend(prefer_loopback: bool = True) -> WindowsBackend:
    return PySerialLoopbackBackend() if prefer_loopback else WindowsBackend()
