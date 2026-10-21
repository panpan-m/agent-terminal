"""Platform-independent serial interface.

Everything above this layer (sessions, MCP, admin, bridge) speaks only these
types.  Platform code lives in :mod:`tio_server.serial.windows` and
:mod:`tio_server.serial.posix`; tests use :mod:`tio_server.serial.simulator`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable


class SerialError(Exception):
    """Base class; ``code`` is a plan error code."""

    code = "INTERNAL"

    def __init__(self, message: str, *, details: dict | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.details = details or {}


class PortNotFound(SerialError):
    code = "PORT_NOT_FOUND"


class PortBusy(SerialError):
    code = "PORT_BUSY"


class Disconnected(SerialError):
    code = "DISCONNECTED"


class Unsupported(SerialError):
    code = "UNSUPPORTED_ON_PLATFORM"


class InvalidConfig(SerialError):
    code = "INVALID_ARGUMENT"


@dataclass(slots=True)
class SerialConfig:
    port: str
    baudrate: int = 115200
    bytesize: int = 8
    parity: str = "none"
    stopbits: float = 1
    flow: str = "none"
    open_mode: str = "preserve"
    write_timeout_ms: int = 2000

    def redacted(self) -> dict:
        return {
            "port": self.port,
            "baudrate": self.baudrate,
            "bytesize": self.bytesize,
            "parity": self.parity,
            "stopbits": self.stopbits,
            "flow": self.flow,
            "open_mode": self.open_mode,
        }


@dataclass(slots=True)
class PortInfo:
    port: str
    os: str
    by_id: str | None = None
    description: str = ""
    vid: str | None = None
    pid: str | None = None
    serial_number: str | None = None
    manufacturer: str | None = None
    product: str | None = None
    driver: str | None = None
    is_usb: bool = False

    def to_dict(self) -> dict:
        return {
            "port": self.port,
            "by_id": self.by_id,
            "os": self.os,
            "description": self.description,
            "vid": self.vid,
            "pid": self.pid,
            "serial_number": self.serial_number,
            "manufacturer": self.manufacturer,
            "product": self.product,
            "driver": self.driver,
            "is_usb": self.is_usb,
        }


@dataclass(slots=True)
class LineState:
    dtr: bool | None = None
    rts: bool | None = None
    cts: bool | None = None
    dsr: bool | None = None
    cd: bool | None = None
    ri: bool | None = None

    def to_dict(self) -> dict:
        return {
            "dtr": self.dtr,
            "rts": self.rts,
            "cts": self.cts,
            "dsr": self.dsr,
            "cd": self.cd,
            "ri": self.ri,
        }


@dataclass(slots=True)
class SerialStats:
    rx_bytes: int = 0
    tx_bytes: int = 0
    open_count: int = 0
    read_errors: int = 0
    write_errors: int = 0
    overflow_errors: int = 0


@dataclass(slots=True)
class SerialHandle:
    """Opaque handle wrapper; ``impl`` is backend-specific."""

    port: str
    impl: object
    original: object | None = None
    extra: dict = field(default_factory=dict)


@runtime_checkable
class SerialBackend(Protocol):
    name: str

    def list_ports(self) -> list[PortInfo]: ...

    def open(self, cfg: SerialConfig) -> SerialHandle: ...

    def close(self, handle: SerialHandle) -> None: ...

    def read(self, handle: SerialHandle, max_bytes: int, timeout_ms: int) -> bytes: ...

    def write(self, handle: SerialHandle, data: bytes, timeout_ms: int) -> int: ...

    def configure(self, handle: SerialHandle, cfg: SerialConfig) -> None: ...

    def get_lines(self, handle: SerialHandle) -> LineState: ...

    def set_lines(self, handle: SerialHandle, dtr: bool | None, rts: bool | None) -> LineState: ...

    def pulse_line(self, handle: SerialHandle, line: str, active: bool, duration_ms: int) -> None: ...

    def flush(self, handle: SerialHandle, input: bool, output: bool) -> None: ...

    def send_break(self, handle: SerialHandle, duration_ms: int) -> None: ...

    def stats(self, handle: SerialHandle) -> SerialStats: ...


def normalise_stopbits(value: float):
    return 1.5 if float(value) == 1.5 else int(value)
