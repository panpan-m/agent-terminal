# SSH 网页终端 + MCP 工具：设计与实施计划

状态：Phase 1 已实现并真机验证；Phase 2/3/4 待做
日期：2026-10-22
参考产品：[billchurch/webssh2](https://github.com/billchurch/webssh2)（MIT；Node 22 + Express + socket.io + ssh2 + xterm.js）

---

## 1. 需求

1. **SSH 网页终端**：配置主机（host/port/user/认证），打开后是完整 xterm.js 交互终端；
   支持窗口 resize、颜色、搜索、重连、状态栏，体验对齐现有 Serial Terminal。
2. **连接管理**：SSH 主机配置可增删改查、测试连通性；终端可多开；有审计和 transcript。
3. **凭据与主机密钥安全**：密码/私钥/passphrase 不通过 API 回显；严格 known_hosts；
   后续 MCP 也不能绕过。
4. **MCP 扩展**（后续阶段）：增加 `ssh_*` 工具（状态、执行、读取、写、tail、expect），
   只操作操作员已打开的 SSH 会话，并有权限/审计。
5. **不破坏现有串口功能与单二进制打包**。

## 2. 已确认的技术决策

| 决策 | 选择 | 理由 |
|---|---|---|
| SSH 协议栈 | **Paramiko，进现有 Python 进程** | LGPL-2.1，与 GPL-2.0 兼容；PTY/resize/SFTP/known_hosts 完整；保持 PyInstaller 单产品 |
| 认证（MVP） | 密码 + 私钥（含 passphrase） | 覆盖大多数 Linux 主机 |
| MCP 连接策略 | 只操作操作员已打开的会话 | 防止 agent 自行连内网主机/横向移动 |
| known_hosts | 严格校验 | 未知或变更的主机直接拒绝，不做静默 TOFU |
| SFTP | 后续阶段 | 先把交互终端与 MCP 打磨好 |

**不采用 webssh2 作为运行时依赖**：它是独立 Node 应用，引入第二个运行时、认证/会话模型和
socket.io 协议；MCP 需要跨进程桥接。它的 hosts 表单、host key 校验、keyboard-interactive 设计
可作为参考（MIT 许可，若复用代码会在 `LICENSES/` 记录）。

## 3. 总体架构

```text
Browser (React 19 + xterm.js)
  ├─ Connections 页面 ──HTTP──▶ /api/ssh/hosts        （CRUD、测试）
  └─ SSH Terminal 页面 ──WS /ws/ssh/{session} ──┐
                                                 ▼
FastAPI (tio-server)
  SshManager
    ├─ SshProfileStore        data_dir/ssh_hosts.json（无秘密）
    └─ SshSession             Paramiko SSHClient + shell channel
         ├─ RingBuffer/Subscriber（复用串口实现）
         ├─ Transcript JSONL + Audit
         ├─ exec channel（给 MCP 的 ssh_exec）
         └─ resize_pty(cols, rows)
MCP (/mcp)
  ssh_* 工具 ──同一 SshManager──▶ 仅 operator 已打开会话
```

与串口共享的组件：

- `RingBuffer` / `Subscriber` / 绝对 cursor；
- `TranscriptWriter`、审计日志；
- 控制权/写锁（交互终端同一时刻一个写者）；
- 前端主题、搜索、日志导出、状态面板。

## 4. 数据模型

`data_dir/ssh_hosts.json`（原子写，0600）：

```json
{
  "version": 1,
  "hosts": [
    {
      "id": "pi",
      "name": "Raspberry Pi",
      "host": "192.168.124.23",
      "port": 22,
      "username": "root",
      "auth": "key",
      "key_file": "C:\\Users\\PC\\.ssh\\id_ed25519",
      "known_hosts": "C:\\Users\\PC\\.ssh\\known_hosts",
      "term": "xterm-256color",
      "connect_timeout_s": 10,
      "created_at": "2026-10-22T10:30:00+08:00",
      "updated_at": "2026-10-22T10:30:00+08:00"
    }
  ]
}
```

**秘密默认不落盘**：

- `password`、`passphrase` 只出现在 `POST /connect` 请求体，内存中使用，不写 JSON/日志/transcript。
- 可选 **Remember credentials**：用 `ssh-secrets.key`（0600）加密后写入
  `ssh-secrets.json`；API 只返回 `has_saved_secrets` / `saved_fields`，不返回明文；
  `Forget` 删除。该密钥与密文同目录，属于便利存储而非硬件保险箱。
- 私钥文件本身由用户管理；路径可配置，内容不读取进配置。
- 后续可选 OS keyring/加密存储，但 MVP 不做“保存密码”。

字段校验：

- `id`：`[a-z0-9][a-z0-9_-]{0,31}`，唯一；
- `host`：非空，不能是 URL；禁止 CR/LF；
- `port`：1–65535；
- `auth`：`password` | `key`；
- `key_file`：auth=key 时必填，必须存在且可读（连接时检查）；
- `known_hosts`：为空时用 `~/.ssh/known_hosts`；
- `term`：默认 `xterm-256color`。

## 5. 后端组件

```text
src/tio_server/ssh/
├── __init__.py
├── profiles.py       SshHost、SshProfileStore（JSON 原子读写、校验）
├── session.py        SshSession（Paramiko、ring、subscriber、resize、exec）
└── manager.py        SshManager（连接生命周期、审计、速率限制）
```

复用：

- `src/tio_server/ring.py`、`transcript.py`、`errors.py`；
- 参考 `sessions.py` 的写锁/订阅模式，但不复用串口的 `Session` 类（串口特定逻辑太多）。

`SshSession` 关键方法：

```python
connect() / disconnect()
write_bytes(data, source="human"|"agent")
resize(cols, rows)
read(cursor=None, tail_bytes=None, max_bytes=...)
expect(pattern, mode, timeout_ms, ...)
exec(command, timeout_ms) -> {stdout, stderr, exit_code, elapsed_ms}
status() -> {state, host, user, rx_bytes, tx_bytes, head, connected_at, ...}
```

Paramiko 是同步库：

- 连接/读写/exec 都通过 `asyncio.to_thread` 调用，避免阻塞事件循环；
- 每个 SSH session 一个 reader 线程，读 `channel.recv(4096)` 写入 ring 并广播；
- `channel.send()` 在写锁内执行；
- `resize_pty(width, height)` 由 WS 的 resize 消息触发。

## 6. HTTP / WebSocket 协议

### HTTP

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/ssh/hosts` | 列表（不含秘密） |
| POST | `/api/ssh/hosts` | 新建（CSRF） |
| PUT | `/api/ssh/hosts/{id}` | 修改（CSRF） |
| DELETE | `/api/ssh/hosts/{id}` | 删除（CSRF）；若会话仍打开则拒绝 |
| POST | `/api/ssh/hosts/{id}/connect` | body `{password?, passphrase?, use_saved?, remember?, cols?, rows?}`；返回会话 |
| GET | `/api/ssh/sessions` | 当前 SSH 会话列表 |
| GET | `/api/ssh/sessions/{sid}` | 状态 |
| POST | `/api/ssh/sessions/{sid}/disconnect` | 断开 |
| POST | `/api/ssh/sessions/{sid}/write` | 文本输入（可选，主要走 WS） |

### WebSocket `/ws/ssh/{session_id}`

客户端 → 服务端：

```json
{"type": "input", "data_b64": "bHMK"}
{"type": "resize", "cols": 120, "rows": 30}
{"type": "ping"}
```

服务端 → 客户端：

```json
{"type": "hello", "session_id": "ssh-...", "replay_bytes": 65536}
{"type": "replay", "offset": 0, "data_b64": "..."}
{"type": "rx", "offset": 1234, "data_b64": "..."}
{"type": "status", "status": {...}}
{"type": "exit", "exit_code": 0}
```

支持 `?cursor=` 断点续传（复用串口 console WS 的逻辑）。

### 前端路由

- `#/connections`：SSH 主机列表 + 新建/编辑/删除/连接/测试；
- `#/ssh/{session_id}`：SSH 终端页（xterm.js）；
- 现有 `#/terminal/{serial}` 不变。

前端复用：

- 抽出 `XtermView`（终端创建、fit、search、主题、cursor、overflow）；
- 抽出 `TerminalChrome`（工具栏/状态栏/LIVE RX/搜索/导出/Keys）；
- Serial 与 SSH 各自提供 transport（WS URL、输入编码、resize 能力）。

## 7. 主机密钥（严格）

```python
client = paramiko.SSHClient()
client.load_system_host_keys()
if profile.known_hosts:
    client.load_host_keys(profile.known_hosts)
client.set_missing_host_key_policy(paramiko.RejectPolicy())
```

- 未知主机：连接失败，返回 `SSH_HOST_UNKNOWN`，附带服务器指纹（SHA256）和
  `ssh-keyscan -p {port} {host}` 提示；**不自动写入**。
- 密钥变更：失败，返回 `SSH_HOST_KEY_CHANGED` + 旧/新指纹，要求人工处理。
- MCP 工具没有“信任主机”能力；host key 必须由操作员预先配置。

后续可加 UI：

- 显示服务器指纹；
- “Copy ssh-keyscan command”；
- 手动导入 known_hosts（仍不自动 TOFU）。

## 8. MCP 工具（Phase 3）

只暴露已由操作员打开的会话：

| 工具 | 读/写 | 说明 |
|---|---|---|
| `ssh_sessions` | 读 | 当前 SSH 会话（id、host、user、state） |
| `ssh_status` | 读 | 详细状态、rx/tx、host key 指纹、cipher |
| `ssh_exec` | 写 | 在会话连接上开 exec channel，返回 stdout/stderr/exit_code |
| `ssh_read` | 读 | 按 cursor/tail 读取 ring |
| `ssh_tail` | 读 | 最新 N 行（复用 `serial_tail` 的清洗逻辑） |
| `ssh_write` | 写 | 向交互 shell 写字节 |
| `ssh_expect` | 读 | 等模式 |
| `ssh_disconnect` | 写 | 关闭会话（可选；默认不允许 agent 关闭） |

不提供 `ssh_connect`（agent 不能自行连主机）。所有 exec/write 记录审计：
`ssh.exec`（命令、退出码、耗时、输出长度）、`ssh.write`（长度/来源）。

权限：`ssh.read` / `ssh.write` / `ssh.exec`，默认只读，操作员显式授予。

## 9. 安全边界

- **凭据**：默认不落盘、不回显、不进日志/transcript；可选 Remember 加密存储，API 不回传明文。
- **主机密钥**：严格 known_hosts；未知/变更即拒绝；错误里只给指纹，不给密钥内容。
- **SSRF/横向移动**：host 只能来自管理员创建的 profile；agent 不能指定 host。
- **CSRF/Origin**：沿用现有 `csrf_guard`、`_ws_auth`。
- **速率限制**：连接尝试纳入 limiter；失败退避，防止暴力破解。
- **审计**：连接/断开/exec/write 全部记录；transcript 与串口一致可导出。
- **密钥文件**：只读取路径，不复制；Windows ACL/权限检查在连接错误中提示。

## 10. 与 webssh2 的对应关系

| webssh2 能力 | 本方案 |
|---|---|
| xterm.js 前端 | 复用现有 xterm.js（搜索/主题/断点续传已有） |
| socket.io 协议 | 改用原生 WS（与现有 console 一致） |
| ssh2 (Node) | Paramiko（Python，LGPL） |
| 密码/私钥/keyboard-interactive | MVP 密码+私钥；keyboard-interactive 放 Phase 4 |
| host key 校验 | 严格 known_hosts + 指纹错误（更强，无静默 TOFU） |
| SFTP | Phase 4 |
| telnet | 不做（串口已覆盖） |

## 11. 分阶段与验收

### Phase 1 — 可用 MVP ✅ 已实现（2026-10-22）

- `SshProfileStore` + CRUD API；
- Paramiko 连接（密码/私钥+passphrase）；
- 严格 known_hosts；
- shell channel + reader 线程 + ring/subscriber；
- WS 终端（input/resize/replay/cursor）；
- Connections 页面 + SSH Terminal 页面；
- transcript/audit；
- pytest（profile 校验、fake channel、API）+ 真机验证。

实现证据：

- 真实 Pi 5（OpenSSH 10.0p2）私钥登录、`uname -a`、120×40 resize 后 `stty size` 返回 `40 120`；
- 未知 host key → `SSH_HOST_UNKNOWN` + SHA256 指纹；
- 错误 known_hosts → `SSH_HOST_KEY_CHANGED` + expected/actual 指纹；
- 截图 [13-ssh-connections.png](./screenshots/13-ssh-connections.png)、
  [14-ssh-terminal.png](./screenshots/14-ssh-terminal.png)；
- 测试：`tests/unit/test_ssh_profiles.py`、`tests/unit/test_ssh_session.py`、
  `tests/integration/test_ssh_api.py`。

验收：

1. 新建 host → 用密码连接成功 → `ls`/`top`/`vim` 基本可用；
2. 用私钥+passphrase 连接成功；
3. 浏览器 resize 后远端 `stty size` 变化；
4. 未知 host key 被拒绝并显示指纹；
5. 断开/重连后 ring 历史可续读；
6. transcript/audit 有记录；
7. 不破坏串口测试与打包。

### Phase 2 — 体验对齐 ✅ 完成

- ✅ 搜索、日志导出、主题、Keys 提示；
- ✅ host key 指纹/known_hosts 提示、`ssh-keyscan` 复制；
- ✅ 连接测试（仅 TCP/握手，不认证、不执行命令）；
- ✅ 多标签/多会话切换：统一 Terminal 工作区的 tab 同时列出 serial 和 SSH，
  点击切换（服务端 ring 续读）；
- ✅ transport 掉线自动重连：保留凭据于内存，指数退避（2s→30s，最多 8 次），
  状态 `reconnecting`，成功后 `reconnect_count` +1，ring/cursor 不丢。

### Phase 3 — MCP ✅ 已实现（2026-10-22）

- `ssh_sessions/status/exec/read/tail/write/expect`；
- 权限与审计；
- DSH 安装提示/工具列表更新；
- 只操作 operator 已打开会话。

实现证据：真实 Pi 会话上通过 MCP 调用 `ssh_sessions`、`ssh_status`、
`ssh_exec("uname -r")`（exit 0）、`ssh_read`、`ssh_tail`、`ssh_write` +
`ssh_expect`（匹配 `mcp-ssh-ok`），随后断开并删除临时 profile。MCP 工具总数为
**15**（8 串口 + 7 SSH）；没有 `ssh_connect`/`ssh_disconnect`。

### Phase 4 — 进阶（大部分完成）

- ✅ SFTP：目录浏览、上传/下载、mkdir/rename/delete，走同一 SSH transport；
- ✅ jump host：目标 host 配置 `jump_host_id`，经跳板机 `direct-tcpip` 通道连接；
- ✅ SSH agent：auth=agent，使用 tio-server 进程的 agent；
- ✅ ~/.ssh/config 导入：解析 Host/HostName/User/Port/IdentityFile，预览后导入；
- ⚠️ keyboard-interactive/2FA：后端 handler + UI 响应列表已实现，但当前没有
  2FA 测试主机，只做了代码路径/构建验证，未做真机端到端。

## 12. 风险与待确认

| 风险 | 处理 |
|---|---|
| Paramiko 许可证 LGPL-2.1 | 与 GPL-2.0 兼容；在 `LICENSES/THIRD-PARTY.md` 记录 |
| PyInstaller 打包 cryptography/paramiko | 增加 hidden imports，打包测试覆盖 |
| 严格 known_hosts 首次体验差 | 错误中给指纹 + `ssh-keyscan` 命令；Phase 2 做指纹页 |
| 私钥格式 | 支持 OpenSSH/PEM；PuTTY PPK 需转换，文档说明 |
| 主机密钥算法 | Paramiko 支持 RSA/ECDSA/Ed25519；旧 ssh-rsa 需显式启用 |
| 阻塞 I/O | 全部 `asyncio.to_thread`，reader 独立线程 |
| MCP 越权 | 不提供 connect；host 仅来自 profile；权限+审计 |

Phase 1 按“Connections 页面 + SSH Terminal 页面”两个路由实现（已确认选 A）。
