"""The MCP tool layer must never run blocking work on the ASGI event loop.

The whole product promise is "the operator watches the agent live".  A tool body
that waits on the UART inline froze ``/api``, ``/ws`` and ``/healthz`` for the
whole wait (measured 7.1 s of ``/healthz`` latency behind an 8 s ``serial_read``
before this was fixed), so the guard is asserted here rather than trusted.
"""

from __future__ import annotations

import asyncio
import threading

from tio_server.errors import INVALID_ARGUMENT, ToolFailure
from tio_server.mcp.tools import _guard


def test_tool_body_runs_off_the_event_loop():
    seen: dict[str, int] = {}

    @_guard
    def handler() -> str:
        seen["body"] = threading.get_ident()
        return "ok"

    async def main() -> str:
        seen["loop"] = threading.get_ident()
        return await handler()

    assert asyncio.run(main()) == "ok"
    assert seen["body"] != seen["loop"], "the tool body ran on the event loop"


def test_tool_body_receives_arguments_through_the_thread():
    @_guard
    def handler(session_id: str, count: int = 1) -> str:
        return f"{session_id}:{count}"

    assert asyncio.run(handler("board", count=3)) == "board:3"


def test_tool_failure_becomes_a_structured_error_result():
    @_guard
    def handler() -> None:
        raise ToolFailure(INVALID_ARGUMENT, "bad argument", {"field": "cursor"})

    result = asyncio.run(handler())
    assert result.is_error is True
    assert result.structured_content["error"]["code"] == INVALID_ARGUMENT


def test_unexpected_exception_does_not_leak_internals():
    @_guard
    def handler() -> None:
        raise RuntimeError("secret path C:/keys/signing.pem")

    result = asyncio.run(handler())
    assert result.is_error is True
    error = result.structured_content["error"]
    assert error["code"] == "INTERNAL"
    assert "signing.pem" not in str(error)
