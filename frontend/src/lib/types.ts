export type SessionState =
  | "unconfigured"
  | "opening"
  | "open"
  | "reconnecting"
  | "error"
  | "closed";

export interface SerialConfig {
  baudrate: number;
  bytesize: number;
  parity: string;
  stopbits: number;
  flow: string;
  open_mode: string;
}

export interface LineState {
  dtr: boolean | null;
  rts: boolean | null;
  cts: boolean | null;
  dsr: boolean | null;
  cd: boolean | null;
  ri: boolean | null;
}

export interface SessionStatus {
  session_id: string;
  name: string;
  state: SessionState;
  port: string;
  config: SerialConfig;
  control_owner: "human" | "agent";
  agent_permissions: string[];
  rx_bytes: number;
  tx_bytes: number;
  rx_start: number;
  rx_head: number;
  buffer_bytes: number;
  lost_bytes: number;
  lines: LineState | null;
  last_error: string | null;
  last_error_code: string | null;
  opened_at: string | null;
  last_rx_at: string | null;
  last_tx_at: string | null;
  last_write_source: string | null;
  reconnect_count: number;
  auto_reconnect: boolean;
  config_revision: number;
  platform: string;
  /** ttyd entries for this session, when the browser terminal is enabled. */
  terminal?: { view_url: string | null; control_url: string | null };
}

export interface PortInfo {
  port: string;
  by_id: string | null;
  os: string;
  description: string;
  vid: string | null;
  pid: string | null;
  serial_number: string | null;
  manufacturer: string | null;
  product: string | null;
  driver: string | null;
  is_usb: boolean;
}

export interface SessionInput {
  id?: string;
  name?: string;
  port: string;
  baudrate?: number;
  bytesize?: number;
  parity?: string;
  stopbits?: number;
  flow?: string;
  open_mode?: string;
  auto_open?: boolean;
  auto_reconnect?: boolean;
  buffer_bytes?: number;
  agent_permissions?: string[];
  transcript?: boolean;
  reset_sequence?: { dtr: boolean | null; rts: boolean | null; delay_ms: number }[];
}

export interface TranscriptEvent {
  ts: string;
  session: string;
  event?: string;
  dir?: "rx" | "tx";
  offset?: number;
  len?: number;
  data_b64?: string;
  source?: string;
  [key: string]: unknown;
}

export interface TtydStatus {
  enabled: boolean;
  available: boolean;
  binary: string | null;
  version: string | null;
  instances: {
    session_id: string;
    mode: string;
    port: number;
    pid: number;
    alive: boolean;
    url: string;
  }[];
}

export interface SystemInfo {
  version: string;
  uptime_seconds: number;
  platform: string;
  python: string;
  config_path: string | null;
  data_dir: string;
  log_dir: string;
  bind: string;
  port: number;
  ttyd: TtydStatus;
  sessions: { session_id: string; state: string; port: string }[];
  health: { sessions_open: number };
}

export interface CommandResponse {
  session_id: string;
  tx_bytes: number;
  rx_text: string;
  matched: boolean;
  match: string | null;
  groups: string[];
  next_cursor: number;
  timed_out: boolean;
  elapsed_ms: number;
}

export interface ApiError extends Error {
  code: string;
  status: number;
  details?: Record<string, unknown>;
  retryable?: boolean;
}

export interface McpToolInfo {
  name: string;
  description: string;
  read_only: boolean;
  destructive: boolean;
}

export interface McpStatus {
  status: string;
  transport: string;
  url: string;
  auth: string;
  api_token_file: string;
  api_token_present: boolean;
  shim: string;
  server: { name: string; version: string };
  tools: McpToolInfo[];
}

export type SshAuth = "password" | "key" | "agent" | "interactive";
export type SshState = "connecting" | "open" | "reconnecting" | "closed" | "error";

export interface SshHost {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth: SshAuth;
  key_file: string;
  known_hosts: string;
  jump_host_id: string;
  auto_reconnect: boolean;
  term: string;
  connect_timeout_s: number;
  created_at: string;
  updated_at: string;
  has_saved_secrets?: boolean;
  saved_fields?: string[];
}

export interface SshHostInput {
  id?: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth: SshAuth;
  key_file?: string;
  known_hosts?: string;
  jump_host_id?: string;
  auto_reconnect?: boolean;
  term?: string;
  connect_timeout_s?: number;
}

export interface SshSessionStatus {
  session_id: string;
  host_id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth: SshAuth;
  state: SshState;
  jump_host_id?: string | null;
  host_key_fingerprint: string | null;
  host_key_type: string | null;
  remote_version: string | null;
  cipher: string | null;
  mac: string | null;
  rx_bytes: number;
  tx_bytes: number;
  rx_start: number;
  rx_head: number;
  buffer_bytes: number;
  opened_at: string | null;
  last_error: string | null;
  last_error_code: string | null;
  control_owner: string;
  auto_reconnect?: boolean;
  reconnect_count?: number;
}

export interface SshConnectInput {
  password?: string;
  passphrase?: string;
  jump_password?: string;
  jump_passphrase?: string;
  responses?: string[];
  use_saved?: boolean;
  remember?: boolean;
  cols?: number;
  rows?: number;
}

export interface SshTestResult {
  host_id: string;
  host: string;
  port: number;
  reachable: boolean;
  remote_version: string;
  host_key_type: string;
  fingerprint: string;
  known_hosts_status: "known" | "unknown" | "changed";
  known_hosts: string;
}

export interface SshFileEntry {
  name: string;
  path: string;
  size: number;
  mtime: number;
  mode: string;
  is_dir: boolean;
  is_link: boolean;
}

export interface SshFileList {
  path: string;
  entries: SshFileEntry[];
}

export interface SshConfigCandidate {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth: SshAuth;
  key_file: string;
  proxy_jump: string;
}
