# Using tio-server from DSH

DSH is the agent. Register the gateway as a normal MCP server and its tools show
up as `mcp__tio__serial_*` next to the built-in tools.

## Configuration

Edit the profile patch (`~/.dsh/profiles/desktop/cordis.patch.yml`) and add one
row. The UI's **MCP** tab generates a **universal install prompt** (any MCP
client can follow it; the DSH row below is included as one example) with the real
paths and a **Copy prompt** button, so you can hand it to an agent instead of
editing by hand.

The stdio shim keeps the bearer token in a file, so nothing secret lands in the
config:

```yaml
- id: mcp-tio
  name: "@deepseek-ai/dsh-mcp-client"
  config:
    serverName: tio
    transport: stdio
    command: C:\serial_mcp\dist\tio-mcp.exe
    args:
      - --url
      - http://127.0.0.1:8765/mcp
      - --token-file
      - C:\serial_mcp\run\api-token
    toolCallTimeoutMs: 70000
```

Streamable HTTP works too (no child process):

```yaml
- id: mcp-tio
  name: "@deepseek-ai/dsh-mcp-client"
  config:
    serverName: tio
    transport: streamable-http
    url: http://127.0.0.1:8765/mcp
    headers:
      Authorization: !!js '`Bearer ${require("node:fs").readFileSync("C:/serial_mcp/run/api-token","utf8").trim()}`'
```

`serverName: tio` is what shapes the model-visible names; keep it stable so
history and permission rules survive restarts.

## Restart is required for a new row

DSH composes the profile at app boot. The HMR layer reloads *existing* rows in
place, but a newly inserted plugin row only appears after the app restarts. So:

1. add the row;
2. quit and reopen DSH;
3. start a session — the tool list now contains
   `mcp__tio__serial_sessions`, `serial_status`, `serial_read`, `serial_tail`,
   `serial_write`, `serial_break`, `serial_command`, `serial_expect`,
   `ssh_sessions`, `ssh_status`, `ssh_read`, `ssh_tail`, `ssh_write`,
   `ssh_exec`, `ssh_expect`.

The same behaviour was verified here: the row was added at 16:31 and the running
app did not spawn the shim; restarting is the supported path.

## What the agent can do

| Tool | Use |
|---|---|
| `mcp__tio__serial_sessions` | find the session id (`board`) |
| `mcp__tio__serial_status` | port, state, owner, counters, lines |
| `mcp__tio__serial_read` | cursor/tail reads, text or hex |
| `mcp__tio__serial_tail` | newest N lines of terminal output (ANSI stripped) |
| `mcp__tio__serial_command` | one command + wait for a prompt/pattern, or `capture_exit: true` for a generic POSIX end marker and exit code |
| `mcp__tio__serial_write` | raw bytes |
| `mcp__tio__serial_break` | framing BREAK (U-Boot/failsafe), needs write control |
| `mcp__tio__serial_expect` | wait for a pattern without writing |
| `mcp__tio__ssh_sessions` | list operator-opened SSH sessions |
| `mcp__tio__ssh_status` | SSH state, host-key fingerprint, cipher/MAC, counters |
| `mcp__tio__ssh_read` | cursor/tail reads from an SSH session |
| `mcp__tio__ssh_tail` | newest N lines from an SSH session |
| `mcp__tio__ssh_write` | raw input to the interactive SSH shell |
| `mcp__tio__ssh_exec` | run one command over SSH, return stdout/stderr/exit code |
| `mcp__tio__ssh_expect` | wait for a pattern in SSH output |

There is deliberately no open/close/configure tool: the operator owns the port
and the SSH connection. The agent cannot connect to a new SSH host; an operator
must open the session in the UI first.
Writes need `control_owner=agent` (hand over in the UI or via the admin API).

For shell boards, `capture_exit: true` is the portable way to know a command
finished — it appends a POSIX marker and returns `exit_code`:

```json
{"session_id": "board", "command": "make -j4", "capture_exit": true, "timeout_ms": 60000}
```

Works on bash/dash/ash/busybox/ksh/zsh; non-POSIX firmware should use `expect`.

## Verified client path

`scripts/live_shell_debug.py` drives the packaged `tio-mcp.exe` through the
official MCP SDK stdio client — the same client `dsh-mcp-client` uses — and ran
23/23 checks against a Raspberry Pi 5 root shell:

```
serial_status        -> board / COM5 / open
serial_command       -> uname -a, /etc/os-release, /proc/cpuinfo, uptime,
                        free -m, df -h /, ip -br addr, systemctl --failed,
                        dmesg | tail
capture_exit         -> exit codes 0 and 2, 1 s sleep, heredoc
serial_read(cursor)  -> gap=false, head advances
serial_command       -> no-match pattern times out cleanly
serial_write         -> WRITE_DISABLED after removing the permission
```

## Troubleshooting

| Symptom | Check |
|---|---|
| no `mcp__tio__*` tools | DSH restarted after editing the patch? YAML valid? |
| tool calls fail with connection error | `curl http://127.0.0.1:8765/healthz`; is `tio-server` running? |
| `unauthorized` / 401 | token file path correct and readable; regenerate with `tio-server init` |
| `WRITE_LOCKED` | hand control to the agent in the UI |
| `TIMEOUT` on write | device stalled (e.g. Debug Probe with DTR low); re-assert DTR |
