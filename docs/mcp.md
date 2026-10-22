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

Fifteen tools: eight for serial sessions and seven for SSH sessions. The SSH
tools never connect or disconnect — they only operate sessions the operator has
already opened in the UI.

| Tool | Read-only | Purpose |
|---|---|---|
| `serial_sessions` | yes | list configured sessions |
| `serial_status` | yes | state, config, counters, cursors, control lines, owner |
| `serial_read` | yes | buffered RX by absolute cursor or tail |
| `serial_tail` | yes | newest N lines of terminal output (ANSI stripped, CR normalised) |
| `serial_write` | no | raw bytes (text or hex) with optional newline/chunking |
| `serial_break` | no | send a serial framing BREAK (`duration_ms`, default 250) |
| `serial_command` | no | write one line and collect the response (expect, or a POSIX end marker with exit code) |
| `serial_expect` | yes | wait for a pattern without writing |
| `ssh_sessions` | yes | list SSH sessions the operator has already opened |
| `ssh_status` | yes | host/user/state, host-key fingerprint, cipher/MAC, counters |
| `ssh_read` | yes | buffered SSH output by cursor or tail |
| `ssh_tail` | yes | newest N lines from an SSH session |
| `ssh_write` | no | raw input to the interactive SSH shell |
| `ssh_exec` | no | separate exec channel: stdout, stderr, exit code |
| `ssh_expect` | yes | wait for a pattern in SSH output |

There is deliberately **no** `serial_open`, `serial_close` or
`serial_configure`: only the operator configures ports. Likewise there is no
`ssh_connect` or `ssh_disconnect`: the agent can only operate SSH sessions the
operator opened **and marked Agent visible**. Unmarked SSH sessions are omitted
from `ssh_sessions`, and direct tool calls with their id return
`PERMISSION_DENIED`.

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

### `serial_tail`

Returns the newest **N lines** of terminal output:

| Arg | Default | Meaning |
|---|---|---|
| `lines` | 40 | trailing lines to return (1–500) |
| `max_bytes` | 65536 | ring bytes scanned from the tail (1 KiB–1 MiB) |
| `strip_ansi` | true | remove CSI/OSC escape sequences |
| `encoding` | utf-8 | text decoding |

CRLF and lone CR are normalised to LF, other control bytes are dropped, and
trailing blank lines are removed. The result is
`{lines, text, count, next_cursor, head_cursor, truncated, bytes_scanned}`;
`truncated=true` means fewer than `lines` lines were available in the scanned
window. Read-only, no cursor bookkeeping needed.

### `serial_break`

Sends a real **framing BREAK** (not a 0x00 byte) for `duration_ms` (1–5000,
default 250). Needed by U-Boot, OpenWrt failsafe and some bootloaders; the
operator button in the Terminal tab uses the same endpoint. Requires write
control (`WRITE_LOCKED` otherwise). Return: `{session_id, duration_ms}`.

### `serial_command`
Writes `command + newline` (default `lf`), then collects from the cursor just
before the write until `expect` matches, the stream is quiet for `settle_ms`, or
`timeout_ms` expires. Returns `rx_text`, `matched`, `match`, `groups`,
`next_cursor`, `timed_out`, `elapsed_ms`, `truncated`, `completion`, and
`exit_code` (when `capture_exit=true`). Matching modes: `literal` (bytes-safe,
case optional), `regex` (RE2-like `regex` module with a 500 ms match timeout and
a 512-char pattern cap) and `glob`.

### Universal end-of-command marker (`capture_exit`)

`capture_exit: true` makes the call return **when the remote command really
finishes**, without knowing the board's prompt. The server appends a POSIX
marker line:

```sh
<your command>
rc=$?; a=__TIO_; b=<random>; echo ${a}${b}:$rc
```

and waits for `__TIO_<random>:<exit>`. Why this is not board-specific:

* plain POSIX shell syntax — bash, dash, ash, busybox `sh`, ksh, zsh;
* the marker is split across two variables, so the **echoed command line never
  contains the joined marker** (no false match from terminal echo);
* `rc=$?` captures the real exit status before anything else runs;
* no dependency on `PS1`, hostname, locale, colours or `printf`;
* multi-line commands and heredocs work (the marker is appended on a new line).

The result adds `completion: "marker"` and `exit_code`, keeping
`rx_text` / `next_cursor` / `timed_out` / `truncated`. If the marker does not
arrive (non-POSIX firmware, or the command is still running), the call ends with
`completion: "timeout"` and the partial output.

Devices without a POSIX shell (U-Boot, RTOS, bare-metal monitors) cannot run the
marker: use `expect` (prompt or completion string), the quiet period, or
`serial_expect` there. The marker is generic across POSIX boards, not tailored
to one host.

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
