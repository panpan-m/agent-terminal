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
