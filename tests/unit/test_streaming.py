"""Subscriber queues are bounded, or a stalled client eats the owner process."""

from __future__ import annotations

import queue

from tio_server.sessions import Subscriber as SerialSubscriber
from tio_server.streaming import Subscriber


def test_queue_is_actually_bounded():
    sub = Subscriber(maxsize=4)
    for index in range(100):
        sub.put({"type": "rx", "n": index})
    assert sub.q.maxsize == 4
    assert sub.q.qsize() <= 4
    assert sub.dropped >= 90


def test_overflow_notice_survives_and_is_delivered_once_per_burst():
    sub = Subscriber(maxsize=2)
    for index in range(20):
        sub.put({"type": "rx", "n": index})
    drained = []
    while not sub.q.empty():
        drained.append(sub.q.get_nowait())
    notices = [item for item in drained if item.get("type") == "overflow"]
    assert len(notices) == 1, drained
    assert notices[0]["dropped"] >= 1
    # Data still flows again after the consumer catches up.
    sub.put({"type": "rx", "n": 99})
    assert sub.get(0.1) == {"type": "rx", "n": 99}


def test_zero_or_negative_maxsize_cannot_mean_unbounded():
    for size in (0, -5):
        sub = Subscriber(maxsize=size)
        assert sub.q.maxsize >= 1
        for index in range(50):
            sub.put({"type": "rx", "n": index})
        assert sub.q.qsize() <= sub.q.maxsize


def test_the_serial_session_uses_the_shared_implementation():
    assert SerialSubscriber is Subscriber


def test_get_returns_none_on_timeout():
    assert Subscriber(maxsize=4).get(0.01) is None
    assert isinstance(Subscriber(maxsize=4).q, queue.Queue)
