import type {
  CommandResponse,
  McpStatus,
  PortInfo,
  SessionInput,
  SessionStatus,
  SshConnectInput,
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

let csrfToken = "";

export function setCsrf(token: string) {
  csrfToken = token;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !(init.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  if (csrfToken && init.method && init.method !== "GET" && init.method !== "HEAD") {
    headers.set("X-CSRF-Token", csrfToken);
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
  async login(username: string, password: string) {
    const out = await request<{ username: string; csrf: string; expires_at: number }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    setCsrf(out.csrf);
    return out;
  },
  async me() {
    const out = await request<{ username: string; csrf: string; expires_at: number }>("/api/auth/me");
    setCsrf(out.csrf);
    return out;
  },
  logout: () => request<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
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
  sshHosts: () => request<{ hosts: SshHost[] }>("/api/ssh/hosts"),
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
  sshSessions: () => request<{ sessions: SshSessionStatus[] }>("/api/ssh/sessions"),
  sshSession: (id: string) =>
    request<SshSessionStatus>(`/api/ssh/sessions/${encodeURIComponent(id)}`),
  sshDisconnect: (id: string) =>
    request<{ ok: boolean }>(`/api/ssh/sessions/${encodeURIComponent(id)}/disconnect`, {
      method: "POST",
    }),
};

export function sshConsoleUrl(sessionId: string, replay = 65536): string {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}/ws/ssh/${encodeURIComponent(sessionId)}?replay=${replay}`;
}

export function consoleUrl(sessionId: string, replay = 65536): string {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}/ws/console/${encodeURIComponent(sessionId)}?replay=${replay}`;
}
