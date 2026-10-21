"""Pydantic models that become the MCP tools' ``outputSchema``."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class SessionSummary(BaseModel):
    session_id: str
    name: str
    state: str
    port: str
    baudrate: int
    control_owner: str
    agent_permissions: list[str]


class SessionsResult(BaseModel):
    sessions: list[SessionSummary] = Field(description="All configured serial sessions.")


class SerialConfigModel(BaseModel):
    baudrate: int
    bytesize: int
    parity: str
    stopbits: float
    flow: str
    open_mode: str


class LinesModel(BaseModel):
    dtr: bool | None = None
    rts: bool | None = None
    cts: bool | None = None
    dsr: bool | None = None
    cd: bool | None = None
    ri: bool | None = None


class StatusResult(BaseModel):
    session_id: str
    name: str
    state: str = Field(description="unconfigured|opening|open|reconnecting|error|closed")
    port: str
    config: SerialConfigModel
    control_owner: str = Field(description="Who may write right now: human or agent.")
    agent_permissions: list[str]
    rx_bytes: int
    tx_bytes: int
    rx_start: int = Field(description="Absolute offset of the oldest byte still buffered.")
    rx_head: int = Field(description="Absolute offset of the next byte (total received).")
    buffer_bytes: int
    lines: LinesModel | None = None
    last_error: str | None = None
    opened_at: str | None = None
    last_rx_at: str | None = None
    reconnect_count: int = 0
    platform: str


class TimestampSegment(BaseModel):
    offset: int
    ts: str


class ReadResult(BaseModel):
    session_id: str
    cursor_start: int
    next_cursor: int
    head_cursor: int
    text: str | None = None
    hex: str | None = None
    encoding: str
    gap: bool = Field(description="True when the requested cursor is older than the buffer.")
    lost_bytes: int
    timed_out: bool
    truncated: bool
    segments: list[TimestampSegment] = Field(default_factory=list)
    rx_started_at: str | None = None
    rx_last_at: str | None = None


class WriteResult(BaseModel):
    session_id: str
    bytes_written: int
    tx_cursor: int
    control_owner: str


class CommandResultModel(BaseModel):
    session_id: str
    tx_bytes: int
    rx_text: str
    rx_hex: str | None = None
    matched: bool
    match: str | None = None
    groups: list[str] = Field(default_factory=list)
    next_cursor: int
    timed_out: bool
    elapsed_ms: int
    truncated: bool = False


class ExpectResult(BaseModel):
    session_id: str
    matched: bool
    match: str | None = None
    groups: list[str] = Field(default_factory=list)
    before: str = ""
    next_cursor: int
    timed_out: bool
    truncated: bool = False


class ErrorPayload(BaseModel):
    """Shape used inside ``structuredContent`` for ``isError=true`` results."""

    error: dict[str, Any]
