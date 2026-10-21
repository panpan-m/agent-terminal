"""Hardware-in-the-loop checks against the serial ports present on this machine.

These are skipped automatically when no usable port exists.  They prove that the
Windows backend talks to a real COM driver (open, configure, control lines,
timeouts, close) rather than only to the simulator.
"""

from __future__ import annotations

import time

import pytest

from tio_server.serial import make_backend
from tio_server.serial.base import SerialConfig
from tio_server.serial.windows import normalise_port


def real_ports():
    backend = make_backend()
    ports = [p for p in backend.list_ports() if p.os == "windows"]
    return backend, ports


def test_normalise_com_port_names():
    assert normalise_port("COM3") == "COM3"
    assert normalise_port("com3") == "COM3"
    assert normalise_port("COM10") == r"\\.\COM10"
    assert normalise_port("loop://") == "loop://"


def test_enumeration_returns_port_metadata():
    backend, ports = real_ports()
    assert isinstance(ports, list)
    for port in ports:
        data = port.to_dict()
        assert data["port"]
        assert data["os"] == "windows"


def test_open_real_com_port_if_available():
    backend, ports = real_ports()
    if not ports:
        pytest.skip("no physical COM port on this machine")
    # Prefer a USB adapter; fall back to whatever exists (e.g. Bluetooth SPP).
    usb = [p for p in ports if p.is_usb]
    candidates = usb or ports
    last_error: Exception | None = None
    for candidate in candidates:
        cfg = SerialConfig(port=candidate.port, baudrate=115200)
        try:
            handle = backend.open(cfg)
        except Exception as exc:  # busy/removed ports are not a test failure
            last_error = exc
            continue
        try:
            lines = backend.get_lines(handle)
            assert lines is not None
            backend.set_lines(handle, dtr=True, rts=True)
            state = backend.get_lines(handle)
            assert state.dtr is True
            backend.set_lines(handle, dtr=False, rts=False)
            # A short read must time out cleanly with b"" rather than raise.
            started = time.monotonic()
            data = backend.read(handle, 64, 150)
            elapsed = time.monotonic() - started
            assert data == b""
            assert elapsed >= 0.1
            backend.flush(handle, input=True, output=False)
            stats = backend.stats(handle)
            assert stats.open_count == 1
        finally:
            backend.close(handle)
        return
    pytest.skip(f"ports present but not openable: {last_error}")


def test_loopback_url_uses_real_pyserial():
    backend = make_backend()
    cfg = SerialConfig(port="loop://", baudrate=115200)
    handle = backend.open(cfg)
    try:
        written = backend.write(handle, b"abc", 1000)
        assert written == 3
        assert backend.read(handle, 16, 500) == b"abc"
    finally:
        backend.close(handle)
