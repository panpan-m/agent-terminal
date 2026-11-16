"""Exclusive agent leases: one agent drives the wire, the others wait.

The lease is cooperative arbitration *between agents* — the operator is not
blocked by it and can force-release. These tests pin the contract:

* with no lease, writes behave exactly as before (single-agent use is unchanged);
* the holder writes freely; every other agent gets ``LEASE_HELD``;
* re-claiming extends your own claim instead of failing;
* release, TTL expiry and an operator force-release all hand the wire back.
"""

from __future__ import annotations

import time

import pytest

from tio_server.config import SessionConfig
from tio_server.errors import ToolFailure
from tio_server.serial.simulator import wait_until
from tio_server.sessions import MAX_LEASE_MS, MIN_LEASE_MS, SessionManager


@pytest.fixture()
def session(make_config):
    # agent control: the lease arbitrates between agents, not against the operator
    cfg = make_config(
        sessions=[
            SessionConfig(id="board-a", name="Board A", port="sim://board-a", control="agent")
        ]
    )
    mgr = SessionManager(cfg, backend=None)
    try:
        sess = mgr.get("board-a")
        sess.open()
        assert wait_until(lambda: b"tiosim>" in sess.ring.read(0, 4096).data)
        yield sess
    finally:
        mgr.stop()


def _write(sess, text: bytes = b"ping\r", owner: str = "agent-a") -> int:
    return sess.write_bytes(text, source="agent", owner=owner)


def test_writes_work_without_a_lease(session):
    """Single-agent use must not require claiming anything."""
    assert session.lease_snapshot() is None
    assert _write(session) == 5


def test_holder_writes_and_others_are_refused(session):
    info = session.acquire_lease("agent-a")
    assert info["owner"] == "agent-a"
    assert info["renewed"] is False

    # the holder may write
    assert _write(session, b"ping\r", owner="agent-a") == 5

    # a different agent may not
    with pytest.raises(ToolFailure) as exc:
        _write(session, b"ping\r", owner="agent-b")
    assert exc.value.code == "LEASE_HELD"
    assert exc.value.details["holder"]["owner"] == "agent-a"
    assert exc.value.retryable is True

    # an unknown caller (no identity) is refused too, rather than silently allowed
    with pytest.raises(ToolFailure) as exc:
        session.write_bytes(b"x", source="agent")
    assert exc.value.code == "LEASE_HELD"


def test_reads_are_never_blocked(session):
    session.acquire_lease("agent-a")
    # a second agent can still observe the console
    sl = session.read(cursor=0, timeout_ms=0, source="agent")
    assert sl.data


def test_reclaiming_extends_your_own_lease(session):
    first = session.acquire_lease("agent-a", ttl_ms=MIN_LEASE_MS)
    again = session.acquire_lease("agent-a", ttl_ms=MAX_LEASE_MS)
    assert again["renewed"] is True
    assert again["ttl_ms"] == MAX_LEASE_MS
    assert again["remaining_ms"] >= first["remaining_ms"]
    assert again["acquired_at"] == first["acquired_at"]


def test_release_hands_the_wire_to_the_next_agent(session):
    session.acquire_lease("agent-a")
    out = session.release_lease("agent-a")
    assert out["released"] is True
    assert out["holder"] == "agent-a"

    assert session.lease_snapshot() is None
    assert _write(session, b"ping\r", owner="agent-b") == 5


def test_only_the_holder_can_release(session):
    session.acquire_lease("agent-a")
    with pytest.raises(ToolFailure) as exc:
        session.release_lease("agent-b")
    assert exc.value.code == "LEASE_HELD"
    assert session.lease_snapshot()["owner"] == "agent-a"


def test_operator_can_force_release(session):
    session.acquire_lease("agent-a")
    out = session.release_lease(None, force=True)
    assert out["released"] is True
    assert session.lease_snapshot() is None
    assert _write(session, b"ping\r", owner="agent-b") == 5


def test_expired_lease_frees_the_wire(session):
    session.acquire_lease("agent-a")
    # stand in for the TTL passing instead of sleeping for MIN_LEASE_MS
    session._lease.deadline = time.monotonic() - 0.001

    assert session.lease_snapshot() is None
    assert _write(session, b"ping\r", owner="agent-b") == 5


def test_lease_is_reported_in_status(session):
    session.acquire_lease("agent-a", ttl_ms=MAX_LEASE_MS)
    lease = session.status()["lease"]
    assert lease["owner"] == "agent-a"
    assert lease["remaining_ms"] > 0
    assert "mine" in lease


def test_ttl_is_clamped(session):
    short = session.acquire_lease("agent-a", ttl_ms=1)
    assert short["ttl_ms"] == MIN_LEASE_MS
    long = session.acquire_lease("agent-a", ttl_ms=10**9)
    assert long["ttl_ms"] == MAX_LEASE_MS


def test_lease_is_audited(session):
    session.acquire_lease("agent-a")
    session.release_lease("agent-a")
    events = [e.get("event") for e in session.manager.audit.tail(50)]
    assert "lease.acquire" in events
    assert "lease.release" in events


# ------------------------------------------------------------------ MCP layer
class _Info:
    def __init__(self, name: str) -> None:
        self.name = name
        self.version = "test"


class _Params:
    def __init__(self, name: str) -> None:
        self.client_info = _Info(name)


class _ProtocolSession:
    def __init__(self, name: str) -> None:
        self.client_params = _Params(name)


class _RequestContext:
    def __init__(self, name: str) -> None:
        self.session = _ProtocolSession(name)


class FakeContext:
    """Stand-in for the SDK request context, carrying a client name."""

    def __init__(self, name: str) -> None:
        self.request_context = _RequestContext(name)


@pytest.fixture()
def mcp_env(make_config):
    from tio_server.mcp.bindings import McpBindings
    from tio_server.mcp.tools import build_mcp_server

    cfg = make_config(
        sessions=[SessionConfig(id="board", port="sim://board-a", control="agent")]
    )
    mgr = SessionManager(cfg, backend=None)
    bindings = McpBindings()
    bindings.set(serial_session_id="board")
    mcp = build_mcp_server(mgr, cfg, bindings=bindings)
    try:
        mgr.get("board").open()
        assert wait_until(lambda: b"tiosim>" in mgr.get("board").ring.read(0, 4096).data)
        yield mcp
    finally:
        mgr.stop()


async def test_second_agent_is_blocked_over_mcp(mcp_env):
    mcp = mcp_env
    agent_a, agent_b = FakeContext("agent-a"), FakeContext("agent-b")

    claim = await mcp.call_tool("serial_claim", {"ttl_ms": 120_000}, agent_a)
    assert claim.is_error is False
    assert claim.structured_content["owner"] == "agent-a"

    mine = await mcp.call_tool("serial_write", {"data": "ping", "newline": "lf"}, agent_a)
    assert mine.is_error is False

    blocked = await mcp.call_tool("serial_write", {"data": "x"}, agent_b)
    assert blocked.is_error is True
    assert blocked.structured_content["error"]["code"] == "LEASE_HELD"
    assert blocked.structured_content["error"]["details"]["holder"]["owner"] == "agent-a"

    # observing is still allowed while the other agent drives
    observing = await mcp.call_tool("serial_read", {"cursor": 0}, agent_b)
    assert observing.is_error is False

    released = await mcp.call_tool("serial_release", {}, agent_a)
    assert released.structured_content["released"] is True

    handed_over = await mcp.call_tool("serial_write", {"data": "x"}, agent_b)
    assert handed_over.is_error is False


async def test_claim_is_visible_in_serial_status(mcp_env):
    mcp = mcp_env
    agent_a = FakeContext("agent-a")
    await mcp.call_tool("serial_claim", {"ttl_ms": 60_000}, agent_a)
    status = await mcp.call_tool("serial_status", {}, agent_a)
    lease = status.structured_content["lease"]
    assert lease["owner"] == "agent-a"
    assert lease["remaining_ms"] > 0
