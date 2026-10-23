import pytest

from tio_server.ring import RingBuffer


def test_append_read_cursor_advances():
    rb = RingBuffer(64)
    assert rb.append(b"hello") == 0
    assert rb.append(b" world") == 5
    assert rb.head == 11
    assert rb.start == 0

    first = rb.read(0, 64)
    assert first.data == b"hello world"
    assert first.next_cursor == 11
    assert first.gap is False
    assert first.truncated is False

    assert rb.read(11, 64).data == b""


def test_read_is_non_consuming():
    rb = RingBuffer(64)
    rb.append(b"abc")
    assert rb.read(0, 3).data == b"abc"
    assert rb.read(0, 3).data == b"abc"
    assert rb.head == 3


def test_max_bytes_truncates_and_reports():
    rb = RingBuffer(64)
    rb.append(b"0123456789")
    sl = rb.read(0, 4)
    assert sl.data == b"0123"
    assert sl.truncated is True
    assert sl.next_cursor == 4
    assert rb.read(4, 4).data == b"4567"


def test_wrap_reports_gap_and_lost_bytes():
    rb = RingBuffer(8)
    rb.append(b"aaaabbbb")  # start=0 head=8
    rb.append(b"cc")        # overwrite first 2 bytes
    assert rb.start == 2
    assert rb.lost_bytes == 2
    sl = rb.read(0, 8)
    assert sl.gap is True
    assert sl.lost_bytes == 2
    assert sl.start == 2
    # 8 bytes available from absolute offset 2: abs 2..10 == "aabbbbcc"
    assert sl.data == b"aabbbbcc"
    assert rb.read(2, 8).data == b"aabbbbcc"


def test_huge_append_keeps_tail():
    rb = RingBuffer(4)
    rb.append(b"0123456789")
    assert rb.head == 10
    assert rb.start == 6
    assert rb.read(None, 100).data == b"6789"


def test_tail_bytes():
    rb = RingBuffer(64)
    rb.append(b"abcdefghij")
    sl = rb.read(tail_bytes=4)
    assert sl.data == b"ghij"
    assert sl.start == 6
    assert sl.next_cursor == 10


def test_tail_bytes_always_end_at_head():
    """Regression: a tail read used to stop max_bytes short of the newest
    bytes (default 16 KiB), so tail replays missed recent output -- including
    escape sequences such as the mouse-tracking disable vim sends on exit."""
    rb = RingBuffer(1024 * 1024)
    rb.append(b"a" * 80000)
    rb.append(b"tail!")
    sl = rb.read(tail_bytes=65536)  # default max_bytes shrinks the window, never the end
    assert sl.end == rb.head
    assert sl.data.endswith(b"tail!")
    assert len(sl.data) == 16384  # default cap: newest 16 KiB of the window
    assert sl.start == rb.head - 16384

    full = rb.read(tail_bytes=65536, max_bytes=65536)
    assert len(full.data) == 65536
    assert full.end == rb.head
    assert full.start == rb.head - 65536
    assert full.truncated is False

    capped = rb.read(tail_bytes=8192, max_bytes=4096)
    assert len(capped.data) == 4096
    assert capped.end == rb.head  # the cap drops the oldest bytes, never the newest
    assert capped.truncated is True


def test_cursor_ahead_clamps():
    rb = RingBuffer(16)
    rb.append(b"abc")
    sl = rb.read(99, 10)
    assert sl.data == b""
    assert sl.next_cursor == 3
    assert sl.gap is False


def test_timestamps_segments():
    rb = RingBuffer(64)
    rb.append(b"aa", ts_ms=1000.0)
    rb.append(b"bb", ts_ms=1500.0)
    sl = rb.read(0, 64)
    assert sl.segments == [(0, 1000.0), (2, 1500.0)]
    assert [pytest.approx(x, rel=0, abs=1e-6) for _, x in sl.segments] == [1000.0, 1500.0]


def test_wait_for_data():
    rb = RingBuffer(32)
    assert rb.wait_for_data(0, 0.05) is False
    rb.append(b"x")
    assert rb.wait_for_data(0, 0.05) is True
    assert rb.wait_for_data(1, 0.01) is False


def test_close_unblocks_waiters():
    rb = RingBuffer(32)
    rb.close()
    assert rb.wait_for_data(0, 0.5) is False
