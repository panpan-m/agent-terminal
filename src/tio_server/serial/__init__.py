"""Serial backends: one Protocol, three implementations."""

from __future__ import annotations

import os

from .base import (
    Disconnected,
    InvalidConfig,
    LineState,
    PortBusy,
    PortInfo,
    PortNotFound,
    SerialBackend,
    SerialConfig,
    SerialError,
    SerialHandle,
    SerialStats,
    Unsupported,
    WriteTimeout,
)


def make_backend(prefer_simulator: bool = True):
    """Pick the native backend for this OS.

    ``sim://`` ports are always routed to the simulator by :class:`BackendRouter`,
    so the native backend stays the default for real ports.
    """
    if os.name == "nt":
        from .windows import PySerialLoopbackBackend

        return BackendRouter(PySerialLoopbackBackend(), SimulatorBackend())
    from .posix import PosixBackend

    return BackendRouter(PosixBackend(), SimulatorBackend())


class BackendRouter:
    """Routes ``sim://`` ports to the simulator and everything else to the OS."""

    name = "router"

    def __init__(self, native, simulator) -> None:  # type: ignore[no-untyped-def]
        self.native = native
        self.simulator = simulator

    def _pick(self, port: str):
        return self.simulator if port.startswith("sim://") else self.native

    def list_ports(self) -> list[PortInfo]:
        return self.native.list_ports() + self.simulator.list_ports()

    def open(self, cfg: SerialConfig) -> SerialHandle:
        return self._pick(cfg.port).open(cfg)

    def close(self, handle: SerialHandle) -> None:
        return self._pick(handle.port).close(handle)

    def read(self, handle: SerialHandle, max_bytes: int, timeout_ms: int) -> bytes:
        return self._pick(handle.port).read(handle, max_bytes, timeout_ms)

    def write(self, handle: SerialHandle, data: bytes, timeout_ms: int) -> int:
        return self._pick(handle.port).write(handle, data, timeout_ms)

    def configure(self, handle: SerialHandle, cfg: SerialConfig) -> None:
        return self._pick(handle.port).configure(handle, cfg)

    def get_lines(self, handle: SerialHandle) -> LineState:
        return self._pick(handle.port).get_lines(handle)

    def set_lines(self, handle: SerialHandle, dtr: bool | None, rts: bool | None) -> LineState:
        return self._pick(handle.port).set_lines(handle, dtr, rts)

    def pulse_line(self, handle: SerialHandle, line: str, active: bool, duration_ms: int) -> None:
        return self._pick(handle.port).pulse_line(handle, line, active, duration_ms)

    def flush(self, handle: SerialHandle, input: bool, output: bool) -> None:
        return self._pick(handle.port).flush(handle, input, output)

    def send_break(self, handle: SerialHandle, duration_ms: int) -> None:
        return self._pick(handle.port).send_break(handle, duration_ms)

    def stats(self, handle: SerialHandle) -> SerialStats:
        return self._pick(handle.port).stats(handle)


from .simulator import SimulatorBackend  # noqa: E402  (avoid cycle at import time)

__all__ = [
    "BackendRouter",
    "Disconnected",
    "InvalidConfig",
    "LineState",
    "PortBusy",
    "PortInfo",
    "PortNotFound",
    "SerialBackend",
    "SerialConfig",
    "SerialError",
    "SerialHandle",
    "SerialStats",
    "SimulatorBackend",
    "Unsupported",
    "WriteTimeout",
    "make_backend",
]
