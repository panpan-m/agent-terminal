import time

import pytest

from tio_server.errors import ToolFailure
from tio_server.serial.simulator import wait_until
from tio_server.sessions import SessionManager, SessionState


def test_open_read_and_banner(manager: SessionManager):
    sess = manager.get("board-a")
    sess.open()
    assert wait_until(lambda: sess.ring.head > 0)
    sl = sess.read(cursor=0, timeout_ms=500, max_bytes=4096)
    assert b"TioSim" in sl.data
    assert b"tiosim> " in sl.data
    assert sess.status()["state"] == "open"
    assert sess.status()["rx_bytes"] > 0


def test_read_cursor_incremental(manager: SessionManager):
    sess = manager.get("board-a")
    sess.open()
    assert wait_until(lambda: sess.ring.head > 0)
    first = sess.read(cursor=0, timeout_ms=500, max_bytes=4096)
    nxt = first.next_cursor
    sess.write_bytes(b"ping\r", source="human")
    assert wait_until(lambda: sess.ring.head > nxt)
    second = sess.read(cursor=nxt, timeout_ms=500, max_bytes=4096)
    assert b"pong" in second.data
    assert second.gap is False


def test_control_owner_blocks_agent(manager: SessionManager):
    sess = manager.get("board-a")
    sess.open()
    with pytest.raises(ToolFailure) as exc:
        sess.write_bytes(b"ping\r", source="agent")
    assert exc.value.code == "WRITE_LOCKED"

    manager.set_control_owner("board-a", "agent")
    assert sess.write_bytes(b"ping\r", source="agent") == 5
    assert wait_until(lambda: b"pong" in sess.ring.read(0, 4096).data)

    # The human entry is blocked while the agent owns control.
    with pytest.raises(ToolFailure) as exc2:
        sess.write_bytes(b"x", source="human")
    assert exc2.value.code == "WRITE_LOCKED"


def test_permissions_disable_write(manager: SessionManager):
    manager.set_control_owner("board-a", "agent")
    manager.set_permissions("board-a", ["read"])
    sess = manager.get("board-a")
    sess.open()
    with pytest.raises(ToolFailure) as exc:
        sess.write_bytes(b"ping\r", source="agent")
    assert exc.value.code == "WRITE_DISABLED"
    # read is still allowed
    assert sess.read(cursor=0, timeout_ms=200).data != b""

    manager.set_permissions("board-a", ["write"])
    with pytest.raises(ToolFailure) as exc2:
        sess.read(cursor=0, source="agent")
    assert exc2.value.code == "READ_DISABLED"


def test_command_matches_expect(manager: SessionManager):
    manager.set_control_owner("board-a", "agent")
    sess = manager.get("board-a")
    sess.open()
    assert wait_until(lambda: b"tiosim>" in sess.ring.read(0, 4096).data)
    res = sess.command("help", newline="cr", expect="commands:", timeout_ms=2000)
    assert res.matched is True
    assert res.match == "commands:"
    assert b"dump" in res.rx_data
    assert res.timed_out is False


def test_command_regex_groups(manager: SessionManager):
    manager.set_control_owner("board-a", "agent")
    sess = manager.get("board-a")
    sess.open()
    assert wait_until(lambda: b"tiosim>" in sess.ring.read(0, 4096).data)
    res = sess.command("version", newline="cr", expect=r"tiosim (\d+\.\d+\.\d+)", expect_mode="regex", timeout_ms=2000)
    assert res.matched
    assert res.groups == ["1.0.0"]


def test_command_timeout_returns_partial(manager: SessionManager):
    manager.set_control_owner("board-a", "agent")
    sess = manager.get("board-a")
    sess.open()
    res = sess.command("sleep 500", newline="cr", expect="never", timeout_ms=250)
    assert res.timed_out is True
    assert res.elapsed_ms >= 200


def test_command_without_expect_settles_once(manager: SessionManager):
    manager.set_control_owner("board-a", "agent")
    sess = manager.get("board-a")
    sess.open()
    assert wait_until(lambda: b"tiosim>" in sess.ring.read(0, 4096).data)
    res = sess.command("ping", newline="cr", timeout_ms=3000, settle_ms=100)
    # The response must be collected exactly once, not re-read every iteration.
    assert res.rx_data.count(b"pong") == 1, res.rx_data
    assert res.elapsed_ms < 2000
    assert res.next_cursor == sess.ring.head


def test_reconnect_unplug_replug(manager: SessionManager):
    sess = manager.get("board-a")
    sess.open()
    assert wait_until(lambda: sess.ring.head > 0)
    dev = manager.backend.simulator.device("board-a")
    dev.unplug()
    assert wait_until(lambda: sess.state is SessionState.RECONNECTING, timeout=3)
    dev.plug()
    assert wait_until(lambda: sess.state is SessionState.OPEN, timeout=5)
    assert sess.reconnect_count == 1
    assert sess.ring.head > 0  # buffer survived the disconnect


def test_ring_gap_on_small_buffer(make_config):
    cfg = make_config()
    cfg.sessions[0].buffer_bytes = 1024 * 1024
    mgr = SessionManager(cfg)
    try:
        sess = mgr.get("board-a")
        sess.open()
        assert wait_until(lambda: sess.ring.head > 0)
        dev = mgr.backend.simulator.device("board-a")
        dev.emit("x" * (1024 * 1024 + 100))
        assert wait_until(lambda: sess.ring.head > 1024 * 1024)
        sl = sess.read(cursor=0, max_bytes=100)
        assert sl.gap is True
        assert sl.lost_bytes > 0
    finally:
        mgr.stop()


def test_exported_status_has_contract_fields(manager: SessionManager):
    sess = manager.get("board-a")
    sess.open()
    st = sess.status()
    for key in (
        "session_id",
        "state",
        "port",
        "config",
        "control_owner",
        "agent_permissions",
        "rx_bytes",
        "rx_start",
        "rx_head",
        "buffer_bytes",
        "lines",
        "last_error",
        "opened_at",
        "platform",
    ):
        assert key in st
    assert st["platform"] == ("windows" if manager.is_windows else "posix")


def test_reset_sequence_is_recorded(manager: SessionManager):
    sess = manager.get("board-a")
    sess.open()
    initial = sess.lines()
    out = sess.apply_reset_sequence()
    dev = manager.backend.simulator.device("board-a")
    assert out["steps"] == 3
    # three configured steps + one restore of the pre-reset line state
    assert len(dev.lines) == 4
    assert (dev.lines[0].dtr, dev.lines[0].rts) == (False, True)
    assert (dev.lines[1].dtr, dev.lines[1].rts) == (True, False)
    assert (dev.lines[2].dtr, dev.lines[2].rts) == (False, False)
    assert (dev.lines[3].dtr, dev.lines[3].rts) == (initial["dtr"], initial["rts"])
    assert out["reset_cursor"] >= 0


def test_write_timeout_is_partial_and_keeps_the_session(manager: SessionManager, monkeypatch):
    from tio_server.serial import WriteTimeout

    sess = manager.get("board-a")
    sess.open()
    assert wait_until(lambda: sess.ring.head > 0)

    def timed_out(handle, data, timeout_ms):
        raise WriteTimeout("write timed out after 2 bytes", written=2)

    monkeypatch.setattr(manager.backend, "write", timed_out)
    written = sess.write_bytes(b"abcdef", source="human")
    assert written == 2
    assert sess.state is SessionState.OPEN
    assert sess.last_error is None
    events = sess.transcript.tail(10)
    assert any(event.get("event") == "tx_timeout" for event in events)


def test_zero_byte_write_is_a_timeout(manager: SessionManager, monkeypatch):
    from tio_server.serial import WriteTimeout

    sess = manager.get("board-a")
    sess.open()

    def nothing(handle, data, timeout_ms):
        raise WriteTimeout("write timed out after 0 bytes", written=0)

    monkeypatch.setattr(manager.backend, "write", nothing)
    with pytest.raises(ToolFailure) as exc:
        sess.write_bytes(b"x", source="human")
    assert exc.value.code == "TIMEOUT"
    assert sess.state is SessionState.OPEN


def test_subscribe_replay_ends_at_ring_head(manager: SessionManager):
    """Regression: the console tail replay used to stop max_bytes (16 KiB)
    short of the ring head, so switching browser tabs back to a serial
    terminal lost the newest output."""
    sess = manager.get("board-a")
    sess.open()
    assert wait_until(lambda: sess.ring.head > 0)
    sess.write_bytes(b"dump 30000\r", source="human")
    assert wait_until(lambda: sess.ring.head > 30020)
    time.sleep(0.2)  # let the dump settle so head is stable across the snapshot
    head = sess.ring.head

    sub = sess.subscribe(replay_bytes=65536)
    try:
        replay = None
        deadline = time.time() + 2
        while time.time() < deadline:
            item = sub.get(0.1)
            if item and item.get("type") == "replay":
                replay = item
                break
        assert replay is not None, "expected a replay frame"
        assert replay["offset"] + len(replay["data"]) == head, "replay must end at the ring head"
    finally:
        sess.unsubscribe(sub)
