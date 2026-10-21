# MCP interface

Endpoint: `POST/GET/DELETE http://127.0.0.1:8765/mcp` (Streamable HTTP)
Auth: `Authorization: Bearer <api-token>` — the raw token is in
`<data-dir>/api-token` (0600); only its Argon2 hash is in `config.toml`.
Protocol: MCP 2026-07-28 via the official Python SDK v2 (2.3.x). Legacy 2025
clients are served by the SDK compatibility layer.

```bash
curl -s http://127.0.0.1:8765/mcp \
  -H "Authorization: Bearer $(cat api-token)" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2026-07-28","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

The server answers with `text/event-stream`; parse `data:` lines. A
`Mcp-Session-Id` response header must be echoed on subsequent requests (the
server keeps transport sessions; the *serial* session is always selected by the
`session_id` **argument**, not by protocol state).

## Tools

| Tool | Read-only | Purpose |
|---|---|---|
| `serial_sessions` | yes | list configured sessions |
| `serial_status` | yes | state, config, counters, cursors, control lines, owner |
| `serial_read` | yes | buffered RX by absolute cursor or tail |
| `serial_write` | no | raw bytes (text or hex) with optional newline/chunking |
| `serial_command` | no | write one line and collect the response (expect literal/regex/glob) |
| `serial_expect` | yes | wait for a pattern without writing |

There is deliberately **no** `serial_open`, `serial_close` or
`serial_configure`: only the operator configures ports.

### `serial_read`

| Arg | Default | Meaning |
|---|---|---|
| `session_id` | — | required when more than one session exists |
| `cursor` | — | absolute offset (feed back `next_cursor`) |
| `tail_bytes` | — | newest N bytes (mutually exclusive with `cursor`) |
| `timeout_ms` | 1000 | wait for new data (0–30000) |
| `max_bytes` | 4096 | response cap (≤16384) |
| `format` | text | `text` or `hex` (hex dump) |
| `encoding` | utf-8 | text decoding |
| `strip_ansi` | false | remove terminal escapes |
| `with_timestamps` | false | per-chunk RX timestamps |

Neither `cursor` nor `tail_bytes` returns the last 4096 bytes ("what is on
screen"). A timeout is not an error: `isError=false`, `timed_out=true`.

### `serial_command`

Writes `command + newline` (default `lf`), then collects from the cursor just
before the write until `expect` matches, the stream is quiet for `settle_ms`, or
`timeout_ms` expires. Returns `rx_text`, `matched`, `match`, `groups`,
`next_cursor`, `timed_out`, `elapsed_ms`, `truncated`. Matching modes:
`literal` (bytes-safe, case optional), `regex` (RE2-like `regex` module with a
500 ms match timeout and a 512-char pattern cap) and `glob`.

### Errors

Business failures are `isError: true` **and** carry structured content:

```json
{
  "error": {
    "code": "WRITE_LOCKED",
    "message": "control owner is human; ask the operator to hand control to the agent",
    "details": {"session_id": "board-a", "control_owner": "human"},
    "retryable": true
  }
}
```

| Code | Meaning |
|---|---|
| `NO_SESSION` | nothing configured |
| `SESSION_NOT_FOUND` | unknown `session_id` |
| `PORT_NOT_FOUND` / `PORT_BUSY` | device missing / held by another process |
| `PERMISSION_DENIED`, `READ_DISABLED`, `WRITE_DISABLED` | capability switched off |
| `WRITE_LOCKED` | the operator owns control |
| `DISCONNECTED` | device unplugged / reconnecting |
| `BUFFER_GAP` | cursor older than the buffer |
| `INVALID_ARGUMENT` | bad argument (also schema violations) |
| `UNSUPPORTED_ON_PLATFORM` | e.g. mark parity on Windows |
| `RATE_LIMITED` | over `security.rate_limit_per_second` |
| `BUSY` | another writer holds the lock |
| `INTERNAL` | unexpected; details are not leaked |

## Client configuration

### HTTP-capable agent

```json
{
  "mcpServers": {
    "tio": {
      "url": "http://127.0.0.1:8765/mcp",
      "headers": { "Authorization": "Bearer <api-token>" }
    }
  }
}
```

### stdio-only agent

```json
{
  "mcpServers": {
    "tio": {
      "command": "tio-mcp",
      "args": [
        "--url", "http://127.0.0.1:8765/mcp",
        "--token-file", "C:\\ProgramData\\tio-server\\api-token"
      ]
    }
  }
}
```

`tio-mcp` refuses to start without a token, reports connection failures as JSON-RPC
`-32000` ("tio-server is not running…"), forwards `Mcp-Session-Id` and
`MCP-Protocol-Version`, and never opens the serial port.

## Control ownership

`agent_permissions = ["read","write","command"]` is the capability ceiling;
`control_owner` is the live switch (runtime only, resets to `human` on restart).
Both must allow a write. The operator flips it in the UI (Sessions card or console
toolbar); `serial_status` reports the current owner and the last write source.
