import { useCallback, useEffect, useMemo, useState } from "react";

import { Shell, type Page } from "@/components/Shell";
import { TerminalWorkspacePage } from "@/pages/TerminalWorkspacePage";
import { McpPage } from "@/pages/McpPage";
import { SessionsPage } from "@/pages/SessionsPage";
import { LogsPage } from "@/pages/LogsPage";
import { ApiFailure, api } from "@/lib/api";
import type { SessionInput, SessionStatus, SshSessionStatus, SystemInfo } from "@/lib/types";

const PAGES: Page[] = ["sessions", "terminal", "connections", "ssh", "mcp", "logs"];

interface Toast {
  id: number;
  message: string;
  tone: "info" | "error" | "success";
}

function parseHash(): { page: Page; sessionId?: string } {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [pageRaw, id] = raw.split("/");
  const normalized = pageRaw === "console" ? "terminal" : pageRaw; // old chat links
  const legacy = pageRaw === "config" ? "sessions" : pageRaw === "system" ? "sessions" : normalized;
  const page = (PAGES as string[]).includes(legacy) ? (legacy as Page) : "sessions";
  return { page, sessionId: id || undefined };
}

export default function App() {
  const [route, setRoute] = useState(parseHash());
  const [sessions, setSessions] = useState<SessionStatus[]>([]);
  const [sshSessions, setSshSessions] = useState<SshSessionStatus[]>([]);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);

  const notify = useCallback((message: string, tone: Toast["tone"] = "info") => {
    setToast({ id: Date.now(), message, tone });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), toast.tone === "error" ? 7000 : 3500);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [sessionList, sshList, sys] = await Promise.all([
        api.sessions(),
        api.sshSessions().catch(() => ({ sessions: [] })),
        api.system(),
      ]);
      setSessions(sessionList.sessions);
      setSshSessions(sshList.sessions);
      setSystem(sys);
    } catch {
      // server restarting; keep the last known state
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [refresh]);

  const navigate = useCallback((page: Page, sessionId?: string) => {
    const target = sessionId ? `#/${page}/${sessionId}` : `#/${page}`;
    if (window.location.hash !== target) {
      window.location.hash = target;
    }
    setRoute({ page, sessionId });
  }, []);

  const selectedId = useMemo(() => {
    if (route.sessionId && sessions.some((session) => session.session_id === route.sessionId)) {
      return route.sessionId;
    }
    return sessions[0]?.session_id;
  }, [route.sessionId, sessions]);

  const selectedSshId = useMemo(() => {
    if (route.sessionId && sshSessions.some((session) => session.session_id === route.sessionId)) {
      return route.sessionId;
    }
    return sshSessions[0]?.session_id;
  }, [route.sessionId, sshSessions]);

  const guard = useCallback(
    async (action: () => Promise<unknown>, success?: string) => {
      try {
        await action();
        await refresh();
        if (success) notify(success, "success");
        return true;
      } catch (error) {
        const failure = error as ApiFailure;
        notify(`${failure.code ?? "ERROR"}: ${failure.message ?? String(error)}`, "error");
        return false;
      }
    },
    [notify, refresh],
  );

  const createSession = async (input: SessionInput) => {
    const ok = await guard(() => api.createSession(input), `session ${input.id} created`);
    if (ok && input.id) navigate("terminal", input.id);
  };

  const updateSession = async (id: string, input: SessionInput) => {
    await guard(() => api.updateSession(id, input), "configuration saved");
  };

  return (
    <>
      <Shell
        page={route.page}
        onNavigate={navigate}
        onSelectSession={(id) => navigate("terminal", id)}
        onSelectSsh={(id) => navigate("ssh", id)}
        sessions={sessions}
        sshSessions={sshSessions}
        selectedId={route.page === "terminal" ? selectedId : undefined}
        selectedSshId={route.page === "ssh" ? selectedSshId : undefined}
        system={system}
      >
        {route.page === "sessions" || route.page === "connections" ? (
          <SessionsPage
            initialKind={route.page === "connections" ? "ssh" : undefined}
            sessions={sessions}
            system={system}
            refresh={refresh}
            notify={notify}
            onCreate={createSession}
            onUpdate={updateSession}
            onTerminal={(id) => navigate("terminal", id)}
            onControl={(id, owner) => guard(() => api.setControl(id, owner), `control → ${owner}`)}
            onOpenSession={(id) => guard(() => api.openSession(id), "session opened")}
            onCloseSession={(id) => guard(() => api.closeSession(id), "session closed")}
            onDelete={(id) => guard(() => api.deleteSession(id), "session deleted")}
            onReset={(id) =>
              guard(async () => {
                const result = await api.resetSession(id);
                notify(`reset applied (${result.steps} steps)`, "success");
              })
            }
            onOpenSsh={(id) => navigate("ssh", id)}
          />
        ) : null}

        {route.page === "terminal" ? (
          <TerminalWorkspacePage
            initialKind="serial"
            sessionId={route.sessionId}
            sessions={sessions}
            selectedId={selectedId}
            refresh={refresh}
            notify={notify}
            onSelectSerial={(id) => navigate("terminal", id)}
            onSelectSsh={(id) => navigate("ssh", id)}
            onOpenSessions={() => navigate("sessions")}
            onEmpty={() => navigate("terminal")}
          />
        ) : null}

        {route.page === "mcp" ? <McpPage notify={notify} /> : null}

        {route.page === "ssh" ? (
          <TerminalWorkspacePage
            initialKind="ssh"
            sessionId={route.sessionId}
            sessions={sessions}
            selectedId={selectedId}
            refresh={refresh}
            notify={notify}
            onSelectSerial={(id) => navigate("terminal", id)}
            onSelectSsh={(id) => navigate("ssh", id)}
            onOpenSessions={() => navigate("connections")}
            onEmpty={() => navigate("terminal")}
          />
        ) : null}

        {route.page === "logs" ? (
          <LogsPage
            sessions={sessions}
            sshSessions={sshSessions}
            selectedId={selectedId}
          />
        ) : null}
      </Shell>

      {toast ? (
        <div
          className={`fixed bottom-5 right-5 z-50 max-w-sm rounded-lg border px-4 py-3 text-xs shadow-xl backdrop-blur ${
            toast.tone === "error"
              ? "border-red-500/40 bg-red-950/80 text-red-200"
              : toast.tone === "success"
                ? "border-emerald-500/40 bg-emerald-950/80 text-emerald-200"
                : "border-zinc-700 bg-zinc-900/90 text-zinc-200"
          }`}
          onClick={() => setToast(null)}
          role="status"
        >
          {toast.message}
        </div>
      ) : null}
    </>
  );
}
