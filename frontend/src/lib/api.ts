import type {
  CommandResponse,
  McpAuditEvent,
  McpBindings,
  McpStatus,
  PortInfo,
  SessionInput,
  SessionStatus,
  SshConnectInput,
  SshConfigCandidate,
  SshFileList,
  SshFileStat,
  SshHost,
  SshHostInput,
  SshSessionStatus,
  SshTestResult,
  SystemInfo,
  TranscriptEvent,
} from "./types";

export class ApiFailure extends Error {
  code: string;
  status: number;
  details: Record<string, unknown>;
  retryable: boolean;

  constructor(message: string, code: string, status: number, details: Record<string, unknown> = {}, retryable = false) {
    super(message);
    this.name = "ApiFailure";
    this.code = code;
    this.status = status;
    this.details = details;
    this.retryable = retryable;
  }
}

const TOKEN_KEY = "agent-terminal-admin-token";

/**
 * Admin token, needed only when the server is bound off loopback.
 *
 * On loopback the server keeps the no-login local-trust model.  Off loopback it
 * demands the API token on `/api` and `/ws`; the operator passes it once as
 * `?token=…`, we keep it and strip it from the address bar.
 */
function bootstrapAdminToken(): string | null {
  try {
    const url = new URL(window.location.href);
    const fromQuery = url.searchParams.get("token");
    if (fromQuery) {
      window.localStorage.setItem(TOKEN_KEY, fromQuery);
      url.searchParams.delete("token");
      window.history.replaceState({}, "", url.toString());
      return fromQuery;
    }
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

let adminToken: string | null = bootstrapAdminToken();

export function getAdminToken(): string | null {
  return adminToken;
}

export function setAdminToken(token: string | null): void {
  adminToken = token && token.length > 0 ? token : null;
  try {
    if (adminToken) window.localStorage.setItem(TOKEN_KEY, adminToken);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable: keep the in-memory value */
  }
}

/** Build a WebSocket URL, carrying the token when one is configured. */
export function wsUrl(path: string): string {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL(`${scheme}//${window.location.host}${path}`);
  if (adminToken) url.searchParams.set("token", adminToken);
  return url.toString();
}

/** Build a console WebSocket URL, carrying the token when one is configured. */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !(init.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  if (adminToken) {
    headers.set("Authorization", `Bearer ${adminToken}`);
  }
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "same-origin",
  });
  if (response.status === 204) {
    return undefined as T;
  }
  const text = await response.text();
  let payload: unknown = undefined;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = undefined;
    }
  }
  if (!response.ok) {
    const body = payload as
      | { error?: { code?: string; message?: string; details?: Record<string, unknown>; retryable?: boolean }; detail?: string }
      | undefined;
    const err = body?.error;
    throw new ApiFailure(
      err?.message || body?.detail || `HTTP ${response.status}`,
      err?.code || (response.status === 401 ? "UNAUTHORIZED" : "INTERNAL"),
      response.status,
      err?.details ?? {},
      err?.retryable ?? false,
    );
  }
  return payload as T;
}

export const api = {
  version: () => request<{ version: string }>("/api/version"),
  ports: () => request<{ ports: PortInfo[] }>("/api/ports"),
  sessions: () => request<{ sessions: SessionStatus[] }>("/api/sessions"),
  createSession: (body: SessionInput) =>
    request<SessionStatus>("/api/sessions", { method: "POST", body: JSON.stringify(body) }),
  updateSession: (id: string, body: SessionInput) =>
    request<SessionStatus>(`/api/sessions/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  deleteSession: (id: string) =>
    request<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }),
  openSession: (id: string) =>
    request<SessionStatus>(`/api/sessions/${encodeURIComponent(id)}/open`, { method: "POST" }),
  closeSession: (id: string) =>
    request<SessionStatus>(`/api/sessions/${encodeURIComponent(id)}/close`, { method: "POST" }),
  resetSession: (id: string) =>
    request<{ reset_cursor: number; steps: number; status: SessionStatus }>(
      `/api/sessions/${encodeURIComponent(id)}/reset`,
      { method: "POST" },
    ),
  setControl: (id: string, owner: "human" | "agent") =>
    request<{ control_owner: string }>(`/api/sessions/${encodeURIComponent(id)}/control`, {
      method: "PUT",
      body: JSON.stringify({ owner }),
    }),
  setPermissions: (id: string, permissions: string[]) =>
    request<{ agent_permissions: string[] }>(`/api/sessions/${encodeURIComponent(id)}/permissions`, {
      method: "PUT",
      body: JSON.stringify({ permissions }),
    }),
  write: (id: string, body: { text?: string; hex?: string; newline?: string }) =>
    request<{ bytes_written: number; tx_cursor: number }>(`/api/sessions/${encodeURIComponent(id)}/write`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  command: (id: string, body: { command: string; expect?: string; timeout_ms?: number; settle_ms?: number }) =>
    request<CommandResponse>(`/api/sessions/${encodeURIComponent(id)}/command`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  sendBreak: (id: string, durationMs = 250) =>
    request<{ session_id: string; duration_ms: number }>(`/api/sessions/${encodeURIComponent(id)}/break`, {
      method: "POST",
      body: JSON.stringify({ duration_ms: durationMs }),
    }),
  transcript: (id: string, limit = 200) =>
    request<{ events: TranscriptEvent[] }>(
      `/api/sessions/${encodeURIComponent(id)}/transcript?limit=${limit}`,
    ),
  audit: (limit = 200) => request<{ events: Record<string, unknown>[] }>(`/api/audit?limit=${limit}`),
  system: () => request<SystemInfo>("/api/system"),
  mcp: () => request<McpStatus>("/api/mcp"),
  mcpAudit: (limit = 100) => request<{ events: McpAuditEvent[] }>(`/api/mcp/audit?limit=${limit}`),
  sshHosts: () => request<{ hosts: SshHost[] }>("/api/ssh/hosts"),
  sshConfigCandidates: () =>
    request<{ path: string; hosts: SshConfigCandidate[] }>("/api/ssh/config"),
  createSshHost: (body: SshHostInput) =>
    request<SshHost>("/api/ssh/hosts", { method: "POST", body: JSON.stringify(body) }),
  updateSshHost: (id: string, body: SshHostInput) =>
    request<SshHost>(`/api/ssh/hosts/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  deleteSshHost: (id: string) =>
    request<{ ok: boolean }>(`/api/ssh/hosts/${encodeURIComponent(id)}`, { method: "DELETE" }),
  sshConnect: (id: string, body: SshConnectInput) =>
    request<{ session: SshSessionStatus }>(`/api/ssh/hosts/${encodeURIComponent(id)}/connect`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  sshTestHost: (id: string) =>
    request<SshTestResult>(`/api/ssh/hosts/${encodeURIComponent(id)}/test`, { method: "POST" }),
  sshForgetSecrets: (id: string) =>
    request<{ ok: boolean; cleared: boolean }>(`/api/ssh/hosts/${encodeURIComponent(id)}/secrets`, {
      method: "DELETE",
    }),
  sshSftpList: (sessionId: string, path: string) =>
    request<SshFileList>(
      `/api/ssh/sessions/${encodeURIComponent(sessionId)}/sftp/list?path=${encodeURIComponent(path)}`,
    ),
  sshSftpUpload: (sessionId: string, path: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<{ path: string; bytes: number }>(
      `/api/ssh/sessions/${encodeURIComponent(sessionId)}/sftp/upload?path=${encodeURIComponent(path)}`,
      { method: "POST", body: form },
    );
  },
  sshSftpMkdir: (sessionId: string, path: string) =>
    request<{ path: string }>(`/api/ssh/sessions/${encodeURIComponent(sessionId)}/sftp/mkdir`, {
      method: "POST",
      body: JSON.stringify({ path }),
    }),
  sshSftpDelete: (sessionId: string, path: string) =>
    request<{ path: string }>(`/api/ssh/sessions/${encodeURIComponent(sessionId)}/sftp/delete`, {
      method: "POST",
      body: JSON.stringify({ path }),
    }),
  sshSftpRename: (sessionId: string, path: string, newPath: string) =>
    request<{ path: string }>(`/api/ssh/sessions/${encodeURIComponent(sessionId)}/sftp/rename`, {
      method: "POST",
      body: JSON.stringify({ path, new_path: newPath }),
    }),
  sshSftpStat: (sessionId: string, path: string) =>
    request<SshFileStat>(
      `/api/ssh/sessions/${encodeURIComponent(sessionId)}/sftp/stat?path=${encodeURIComponent(path)}`,
    ),
  /** `mode` is the numeric permission value, e.g. 0o755 = 493. */
  sshSftpChmod: (sessionId: string, path: string, mode: number) =>
    request<{ path: string; mode: string }>(`/api/ssh/sessions/${encodeURIComponent(sessionId)}/sftp/chmod`, {
      method: "POST",
      body: JSON.stringify({ path, mode }),
    }),
  /** Download the file to a server-side temp dir and open it with the OS
   *  default application; the server watches the file and uploads saves back. */
  sshSftpOpenLocal: (sessionId: string, path: string) =>
    request<{ path: string; local: string; bytes: number; reused: boolean }>(
      `/api/ssh/sessions/${encodeURIComponent(sessionId)}/sftp/open-local`,
      { method: "POST", body: JSON.stringify({ path }) },
    ),
  /** Streaming single-file download path (GET, has Content-Length). */
  sshSftpDownloadPath: (sessionId: string, path: string) =>
    `/api/ssh/sessions/${encodeURIComponent(sessionId)}/sftp/download?path=${encodeURIComponent(path)}`,
  /** Folder/multi-file zip download path (POST with { paths }). */
  sshSftpArchivePath: (sessionId: string) =>
    `/api/ssh/sessions/${encodeURIComponent(sessionId)}/sftp/download-archive`,
  sshSessions: () => request<{ sessions: SshSessionStatus[] }>("/api/ssh/sessions"),
  sshTranscript: (id: string, limit = 200) =>
    request<{ events: TranscriptEvent[] }>(
      `/api/ssh/sessions/${encodeURIComponent(id)}/transcript?limit=${limit}`,
    ),
  sshSession: (id: string) =>
    request<SshSessionStatus>(`/api/ssh/sessions/${encodeURIComponent(id)}`),
  sshDisconnect: (id: string) =>
    request<{ ok: boolean }>(`/api/ssh/sessions/${encodeURIComponent(id)}/disconnect`, {
      method: "POST",
    }),
  sshRenameSession: (id: string, name: string) =>
    request<{ name: string }>(`/api/ssh/sessions/${encodeURIComponent(id)}/rename`, {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  /** Which sessions the MCP serial/ssh tools are bound to (null = unbound, tools hidden). */
  mcpBindings: () =>
    request<McpBindings>("/api/mcp/bindings"),
  setMcpBindings: (body: { serial_session_id: string | null; ssh_session_id: string | null }) =>
    request<{ serial_session_id: string | null; ssh_session_id: string | null }>("/api/mcp/bindings", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
};

export function sshConsoleUrl(sessionId: string, replay = 65536): string {
  const query = replay > 0 ? `?replay=${replay}` : "";
  return wsUrl(`/ws/ssh/${encodeURIComponent(sessionId)}${query}`);
}

export function consoleUrl(sessionId: string, replay = 65536): string {
  const query = replay > 0 ? `?replay=${replay}` : "";
  return wsUrl(`/ws/console/${encodeURIComponent(sessionId)}${query}`);
}
