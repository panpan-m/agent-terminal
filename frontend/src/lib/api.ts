import type {
  CommandResponse,
  McpAuditEvent,
  McpBindings,
  McpStatus,
  PortInfo,
  SessionInput,
  SessionStatus,
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
  mcpBindings: () =>
    request<McpBindings>("/api/mcp/bindings"),
  setMcpBindings: (body: { serial_session_id: string | null }) =>
    request<{ serial_session_id: string | null }>("/api/mcp/bindings", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
};


export function consoleUrl(sessionId: string, replay = 65536): string {
  const query = replay > 0 ? `?replay=${replay}` : "";
  return wsUrl(`/ws/console/${encodeURIComponent(sessionId)}${query}`);
}
