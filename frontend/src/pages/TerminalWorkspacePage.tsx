import { useCallback, useEffect, useState } from "react";
import { Cable, Loader2, Server, X } from "lucide-react";

import { SshTerminalPage } from "@/pages/SshTerminalPage";
import { TerminalPage } from "@/pages/TerminalPage";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { SessionStatus, SshSessionStatus } from "@/lib/types";

export type TerminalKind = "serial" | "ssh";

/**
 * One Terminal workspace for both transports.  The tab bar lists open serial
 * sessions and SSH sessions together; the body is the matching xterm view.
 */
export function TerminalWorkspacePage({
  initialKind,
  sessionId,
  sessions,
  selectedId,
  refresh,
  notify,
  onSelectSerial,
  onSelectSsh,
  onOpenSessions,
  onEmpty,
}: {
  initialKind: TerminalKind;
  sessionId?: string;
  sessions: SessionStatus[];
  selectedId?: string;
  refresh: () => Promise<void>;
  notify: (message: string, tone?: "info" | "error" | "success") => void;
  onSelectSerial: (id: string) => void;
  onSelectSsh: (id: string) => void;
  onOpenSessions: () => void;
  onEmpty: () => void;
}) {
  const [sshSessions, setSshSessions] = useState<SshSessionStatus[]>([]);
  const [closingId, setClosingId] = useState<string | null>(null);

  const loadSsh = useCallback(async () => {
    try {
      const result = await api.sshSessions();
      setSshSessions(result.sessions);
    } catch {
      /* the SSH manager may be empty; the serial side still works */
    }
  }, []);

  useEffect(() => {
    void loadSsh();
    const timer = window.setInterval(() => void loadSsh(), 3000);
    return () => window.clearInterval(timer);
  }, [loadSsh]);

  const serialCurrent =
    sessions.find((item) => item.session_id === sessionId) ??
    sessions.find((item) => item.session_id === selectedId) ??
    sessions[0];
  const sshCurrent =
    sshSessions.find((item) => item.session_id === sessionId) ?? sshSessions[0];

  let activeKind: TerminalKind | null = null;
  if (initialKind === "ssh" && sshCurrent) activeKind = "ssh";
  else if (initialKind === "serial" && serialCurrent) activeKind = "serial";
  else if (serialCurrent) activeKind = "serial";
  else if (sshCurrent) activeKind = "ssh";

  const activeId =
    activeKind === "ssh" ? sshCurrent?.session_id : serialCurrent?.session_id;

  const closeSshTab = async (id: string) => {
    setClosingId(id);
    try {
      await api.sshDisconnect(id);
    } catch (error) {
      notify(`${(error as { code?: string }).code ?? "ERROR"}: ${(error as Error).message}`, "error");
      setClosingId(null);
      return;
    }
    const remaining = sshSessions.filter((item) => item.session_id !== id);
    setSshSessions(remaining);
    setClosingId(null);
    if (activeKind === "ssh" && activeId === id) {
      if (remaining[0]) onSelectSsh(remaining[0].session_id);
      else if (serialCurrent) onSelectSerial(serialCurrent.session_id);
      else onEmpty();
    }
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-zinc-950">
      <div className="flex items-center gap-1 overflow-x-auto border-b border-zinc-800/80 bg-zinc-950/80 px-2 py-1">
        {sessions.map((item) => (
          <button
            key={`serial-${item.session_id}`}
            type="button"
            onClick={() => onSelectSerial(item.session_id)}
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-t border-b-2 px-2.5 py-1 text-[11px] transition-colors",
              activeKind === "serial" && activeId === item.session_id
                ? "border-emerald-400 bg-zinc-900 text-zinc-100"
                : "border-transparent text-zinc-500 hover:bg-zinc-900/60 hover:text-zinc-200",
            )}
            title={`serial ${item.port}`}
          >
            <Cable className="h-3 w-3 shrink-0" />
            <span className="max-w-[12rem] truncate">{item.name}</span>
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                item.state === "open"
                  ? "bg-emerald-400"
                  : item.state === "reconnecting"
                    ? "bg-amber-400"
                    : item.state === "error"
                      ? "bg-red-400"
                      : "bg-zinc-600",
              )}
            />
          </button>
        ))}
        {sshSessions.map((item) => (
          <div
            key={`ssh-${item.session_id}`}
            className={cn(
              "group flex shrink-0 items-center rounded-t border-b-2 transition-colors",
              activeKind === "ssh" && activeId === item.session_id
                ? "border-emerald-400 bg-zinc-900 text-zinc-100"
                : "border-transparent text-zinc-500 hover:bg-zinc-900/60 hover:text-zinc-200",
            )}
            title={`${item.username}@${item.host}:${item.port}`}
          >
            <button
              type="button"
              onClick={() => onSelectSsh(item.session_id)}
              className="flex items-center gap-1.5 py-1 pl-2.5 pr-1 text-[11px]"
            >
              <Server className="h-3 w-3 shrink-0" />
              <span className="max-w-[12rem] truncate">{item.name}</span>
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  item.state === "open"
                    ? "bg-emerald-400"
                    : item.state === "reconnecting" || item.state === "connecting"
                      ? "bg-amber-400"
                      : item.state === "error"
                        ? "bg-red-400"
                        : "bg-zinc-600",
                )}
              />
            </button>
            <button
              type="button"
              data-session-id={item.session_id}
              disabled={closingId === item.session_id}
              onClick={() => void closeSshTab(item.session_id)}
              className="mr-1 rounded p-0.5 text-zinc-500 hover:bg-zinc-700 hover:text-zinc-100 disabled:opacity-50"
              title="disconnect this SSH session and close its tab"
            >
              {closingId === item.session_id ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <X className="h-3 w-3" />
              )}
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={onOpenSessions}
          className="shrink-0 rounded px-2 py-1 text-[11px] text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200"
        >
          + session
        </button>
      </div>

      <div className="min-h-0 flex-1">
        {activeKind === "serial" && serialCurrent ? (
          <TerminalPage
            sessions={sessions}
            session={serialCurrent}
            selectedId={serialCurrent.session_id}
            onSelect={onSelectSerial}
            refresh={refresh}
            notify={notify}
            showSessionPicker={false}
          />
        ) : activeKind === "ssh" && sshCurrent ? (
          <SshTerminalPage
            sessionId={sshCurrent.session_id}
            onBack={onOpenSessions}
            onSelect={onSelectSsh}
            notify={notify}
            showSessionTabs={false}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-xs text-zinc-500">
            <p>No terminal session is open.</p>
            <button type="button" onClick={onOpenSessions} className="text-emerald-300 hover:underline">
              Open a serial or SSH session
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
