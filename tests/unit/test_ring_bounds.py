"""Ring chunk metadata is bounded by append count, so it needs a cap.

The byte ring is capacity-bounded, but one metadata tuple is stored per append.
A console that trickles one byte per read would otherwise accumulate millions of
tuples for a few MiB of data.  Oldest neighbours are merged instead, which keeps
memory flat and costs only timestamp resolution under fragmentation.
"""

from __future__ import annotations

import time

from tio_server.ring import RingBuffer


def test_chunk_metadata_is_capped_under_byte_at_a_time_traffic():
    ring = RingBuffer(1024)
    for index in range(20000):
        ring.append(bytes([index % 256]))
    assert ring._max_chunks >= 64
    assert len(ring._chunks) <= ring._max_chunks


def test_merged_chunks_stay_contiguous_and_cover_the_buffered_range():
    ring = RingBuffer(4096)
    for index in range(30000):
        ring.append(b"x")
    spans = [(start, end) for start, end, _ in ring._chunks]
    # Contiguous: no gaps or overlaps introduced by merging.
    assert all(spans[i][1] == spans[i + 1][0] for i in range(len(spans) - 1))
    # The oldest span may start before the buffer (a straddling chunk is kept and
    # clipped at read time), but it must never start after it.
    assert spans[0][0] <= ring.start
    assert spans[-1][1] == ring.head
    assert spans[-1][0] <= ring.start < spans[-1][1] or spans[0][0] <= ring.start


def test_read_still_returns_the_right_bytes_after_merging():
    ring = RingBuffer(4096)
    for _ in range(10000):
        ring.append(b"ab")
    tail = ring.read(tail_bytes=10)
    assert tail.data == b"ab" * 5
    assert tail.truncated is False


def test_segments_do_not_explode_in_a_read():
    ring = RingBuffer(8192)
    for _ in range(20000):
        ring.append(b"z")
    assert len(ring._chunks) <= ring._max_chunks
    sl = ring.read(cursor=0, max_bytes=8192)
    assert len(sl.segments) <= ring._max_chunks
    assert all(isinstance(ts, float) for _, ts in sl.segments)


def test_timestamps_survive_merging():
    ring = RingBuffer(1024)
    before = time.time() * 1000.0
    for _ in range(5000):
        ring.append(b"q")
    sl = ring.read(tail_bytes=64)
    assert sl.segments, "merged chunks must still expose a timestamp"
    assert sl.segments[-1][1] >= before - 1000


def test_large_ring_still_keeps_a_useful_number_of_chunks():
    ring = RingBuffer(8 * 1024 * 1024)
    assert ring._max_chunks == 2048
