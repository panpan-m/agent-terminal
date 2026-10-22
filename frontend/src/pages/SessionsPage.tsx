import { useEffect, useState } from "react";
import { Cable, Server } from "lucide-react";

import { ConnectionsPage } from "@/pages/ConnectionsPage";
import { OverviewPage } from "@/pages/OverviewPage";
import { cn } from "@/lib/utils";
import type { SessionInput, SessionStatus, SystemInfo } from "@/lib/types";

export type SessionKind = "serial" | "ssh";

const STORAGE_KEY = "tio-session-kind";

/**
 * One Sessions entry point for both transports.  Serial and SSH share the
 * session concept and the open/close/terminal flow, but keep transport-specific
 * configuration forms.
 */
export function SessionsPage({
  initialKind,
  sessions,
  system,
  refresh,
  notify,
  onCreate,
  onUpdate,
  onTerminal,
  onControl,
  onOpenSession,
  onCloseSession,
  onDelete,
  onReset,
  onOpenSsh,
}: {
  initialKind?: SessionKind;
  sessions: SessionStatus[];
  system: SystemInfo | null;
  refresh: () => Promise<void>;
  notify: (message: string, tone?: "info" | "error" | "success") => void;
  onCreate: (input: SessionInput) => Promise<void>;
  onUpdate: (id: string, input: SessionInput) => Promise<void>;
  onTerminal: (id: string) => void;
  onControl: (id: string, owner: "human" | "agent") => Promise<boolean>;
  onOpenSession: (id: string) => Promise<boolean>;
  onCloseSession: (id: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
  onReset: (id: string) => Promise<boolean>;
  onOpenSsh: (sessionId: string) => void;
}) {
  const [kind, setKind] = useState<SessionKind>(() => {
    if (initialKind) return initialKind;
    const saved = window.localStorage.getItem(STORAGE_KEY);
    return saved === "ssh" ? "ssh" : "serial";
  });

  useEffect(() => {
    if (initialKind) setKind(initialKind);
  }, [initialKind]);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, kind);
  }, [kind]);

  return (
    <div className="min-h-0">
      <div className="mx-auto max-w-6xl px-5 pt-5">
        <div className="inline-flex rounded-lg border border-zinc-800 bg-zinc-950/60 p-0.5" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={kind === "serial"}
            onClick={() => setKind("serial")}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs transition-colors",
              kind === "serial"
                ? "bg-emerald-500/15 text-emerald-200 ring-1 ring-inset ring-emerald-500/30"
                : "text-zinc-400 hover:text-zinc-200",
            )}
          >
            <Cable className="h-3.5 w-3.5" /> Serial
            <span className="text-[10px] text-zinc-500">{sessions.length}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={kind === "ssh"}
            onClick={() => setKind("ssh")}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs transition-colors",
              kind === "ssh"
                ? "bg-emerald-500/15 text-emerald-200 ring-1 ring-inset ring-emerald-500/30"
                : "text-zinc-400 hover:text-zinc-200",
            )}
          >
            <Server className="h-3.5 w-3.5" /> SSH
          </button>
        </div>
      </div>

      {kind === "serial" ? (
        <OverviewPage
          sessions={sessions}
          system={system}
          refresh={refresh}
          notify={notify}
          onCreate={onCreate}
          onUpdate={onUpdate}
          onTerminal={onTerminal}
          onControl={onControl}
          onOpenSession={onOpenSession}
          onCloseSession={onCloseSession}
          onDelete={onDelete}
          onReset={onReset}
        />
      ) : (
        <ConnectionsPage notify={notify} onOpen={onOpenSsh} />
      )}
    </div>
  );
}
