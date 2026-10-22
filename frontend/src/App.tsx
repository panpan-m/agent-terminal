import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";

import { Shell, type Page } from "@/components/Shell";
import { LoginPage } from "@/pages/LoginPage";
import { TerminalPage } from "@/pages/TerminalPage";
import { McpPage } from "@/pages/McpPage";
import { ConfigPage } from "@/pages/ConfigPage";
import { SessionsPage } from "@/pages/SessionsPage";
import { SshTerminalPage } from "@/pages/SshTerminalPage";
import { LogsPage } from "@/pages/LogsPage";
import { SystemPage } from "@/pages/SystemPage";
import { ApiFailure, api } from "@/lib/api";
import type { SessionInput, SessionStatus, SystemInfo } from "@/lib/types";

const PAGES: Page[] = ["sessions", "terminal", "connections", "ssh", "mcp", "config", "logs", "system"];

interface Toast {
  id: number;
  message: string;
  tone: "info" | "error" | "success";
}

function parseHash(): { page: Page; sessionId?: string } {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [pageRaw, id] = raw.split("/");
  const normalized = pageRaw === "console" ? "terminal" : pageRaw; // old chat links
  const page = (PAGES as string[]).includes(normalized) ? (normalized as Page) : "sessions";
  return { page, sessionId: id || undefined };
}

export default function App() {
  const [me, setMe] = useState<{ username: string } | null>(null);
  const [booting, setBooting] = useState(true);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [route, setRoute] = useState(parseHash());
  const [sessions, setSessions] = useState<SessionStatus[]>([]);
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
    api
      .me()
      .then((value) => setMe({ username: value.username }))
      .catch(() => setMe(null))
      .finally(() => setBooting(false));
  }, []);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [sessionList, sys] = await Promise.all([api.sessions(), api.system()]);
      setSessions(sessionList.sessions);
      setSystem(sys);
    } catch (error) {
      if (error instanceof ApiFailure && error.status === 401) {
        setMe(null);
      }
    }
  }, []);

  useEffect(() => {
    if (!me) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [me, refresh]);

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

  const selected = sessions.find((session) => session.session_id === selectedId);

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

  const login = async (username: string, password: string) => {
    setLoginError(null);
    try {
      const result = await api.login(username, password);
      setMe({ username: result.username });
      void refresh();
    } catch (error) {
      const failure = error as ApiFailure;
      setLoginError(failure.message || "login failed");
    }
  };

  const logout = async () => {
    try {
      await api.logout();
    } finally {
      setMe(null);
      setSessions([]);
      setSystem(null);
    }
  };

  if (booting) {
    return (
      <div className="flex min-h-screen items-center justify-center gap-2 text-sm text-zinc-500">
        <Loader2 className="h-4 w-4 animate-spin" /> connecting…
      </div>
    );
  }

  if (!me) {
    return <LoginPage onSubmit={login} error={loginError} />;
  }

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
        sessions={sessions}
        selectedId={selectedId}
        system={system}
        username={me.username}
        onLogout={logout}
      >
        {route.page === "sessions" || route.page === "connections" ? (
          <SessionsPage
            initialKind={route.page === "connections" ? "ssh" : undefined}
            sessions={sessions}
            system={system}
            refresh={refresh}
            notify={notify}
            onCreate={createSession}
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
          <TerminalPage
            sessions={sessions}
            session={selected}
            selectedId={selectedId}
            onSelect={(id) => navigate("terminal", id)}
            refresh={refresh}
            notify={notify}
          />
        ) : null}

        {route.page === "mcp" ? <McpPage notify={notify} /> : null}

        {route.page === "ssh" && route.sessionId ? (
          <SshTerminalPage
            sessionId={route.sessionId}
            onBack={() => navigate("connections")}
            onSelect={(id) => navigate("ssh", id)}
            notify={notify}
          />
        ) : null}

        {route.page === "ssh" && !route.sessionId ? (
          <SessionsPage
            initialKind="ssh"
            sessions={sessions}
            system={system}
            refresh={refresh}
            notify={notify}
            onCreate={createSession}
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

        {route.page === "config" ? (
          <ConfigPage
            sessions={sessions}
            session={selected}
            selectedId={selectedId}
            onSelect={(id) => navigate("config", id)}
            onSave={updateSession}
            notify={notify}
          />
        ) : null}

        {route.page === "logs" ? (
          <LogsPage
            sessions={sessions}
            session={selected}
            selectedId={selectedId}
            onSelect={(id) => navigate("logs", id)}
          />
        ) : null}

        {route.page === "system" ? <SystemPage system={system} sessions={sessions} refresh={refresh} /> : null}
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
