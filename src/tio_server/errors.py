"""Structured error model shared by MCP tools and the admin API.

Every failure that a caller can act on is expressed as a :class:`ToolFailure`
with a stable ``code`` (see the plan's error table), a human message, optional
details and a ``retryable`` flag.  The MCP layer serialises it into an
``isError=true`` tool result with structured content; the admin API turns it
into an HTTP status plus the same JSON body.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


# Stable error codes (plan section 8.5).
NO_SESSION = "NO_SESSION"
SESSION_NOT_FOUND = "SESSION_NOT_FOUND"
PORT_NOT_FOUND = "PORT_NOT_FOUND"
PORT_BUSY = "PORT_BUSY"
PERMISSION_DENIED = "PERMISSION_DENIED"
READ_DISABLED = "READ_DISABLED"
WRITE_DISABLED = "WRITE_DISABLED"
WRITE_LOCKED = "WRITE_LOCKED"
DISCONNECTED = "DISCONNECTED"
TIMEOUT = "TIMEOUT"
BUFFER_GAP = "BUFFER_GAP"
INVALID_ARGUMENT = "INVALID_ARGUMENT"
UNSUPPORTED_ON_PLATFORM = "UNSUPPORTED_ON_PLATFORM"
RATE_LIMITED = "RATE_LIMITED"
INTERNAL = "INTERNAL"
NOT_FOUND = "NOT_FOUND"
UNAUTHORIZED = "UNAUTHORIZED"
FORBIDDEN = "FORBIDDEN"
CONFLICT = "CONFLICT"
CONFIG_INVALID = "CONFIG_INVALID"
SSH_HOST_UNKNOWN = "SSH_HOST_UNKNOWN"
SSH_HOST_KEY_CHANGED = "SSH_HOST_KEY_CHANGED"
SSH_AUTH_FAILED = "SSH_AUTH_FAILED"
SSH_UNREACHABLE = "SSH_UNREACHABLE"
SSH_ERROR = "SSH_ERROR"

_HTTP_STATUS = {
    NO_SESSION: 409,
    SESSION_NOT_FOUND: 404,
    PORT_NOT_FOUND: 404,
    PORT_BUSY: 409,
    PERMISSION_DENIED: 403,
    READ_DISABLED: 403,
    WRITE_DISABLED: 403,
    WRITE_LOCKED: 409,
    DISCONNECTED: 503,
    TIMEOUT: 504,
    BUFFER_GAP: 410,
    INVALID_ARGUMENT: 400,
    UNSUPPORTED_ON_PLATFORM: 501,
    RATE_LIMITED: 429,
    INTERNAL: 500,
    NOT_FOUND: 404,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    CONFLICT: 409,
    CONFIG_INVALID: 400,
    SSH_HOST_UNKNOWN: 409,
    SSH_HOST_KEY_CHANGED: 409,
    SSH_AUTH_FAILED: 401,
    SSH_UNREACHABLE: 502,
    SSH_ERROR: 502,
}


@dataclass(slots=True)
class ToolFailure(Exception):
    """A caller-visible failure with a stable machine code."""

    code: str
    message: str
    details: dict[str, Any] = field(default_factory=dict)
    retryable: bool = False

    def __post_init__(self) -> None:
        # ``super()`` is unusable here: ``slots=True`` recreates the class, so the
        # zero-arg form would still point at the pre-dataclass class.
        Exception.__init__(self, self.message)

    def to_dict(self) -> dict[str, Any]:
        return {
            "error": {
                "code": self.code,
                "message": self.message,
                "details": self.details,
                "retryable": self.retryable,
            }
        }

    @property
    def http_status(self) -> int:
        return _HTTP_STATUS.get(self.code, 500)


def invalid_argument(message: str, **details: Any) -> ToolFailure:
    return ToolFailure(INVALID_ARGUMENT, message, details)


def unsupported(message: str, **details: Any) -> ToolFailure:
    return ToolFailure(UNSUPPORTED_ON_PLATFORM, message, details)
