import {
  Cpu,
  LayoutDashboard,
  LogOut,
  ScrollText,
  SlidersHorizontal,
  SquareTerminal,
  TerminalSquare,
  Waves,
} from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import type { SessionStatus, SystemInfo } from "@/lib/types";
import { StateBadge } from "@/components/ui/badge";

export type Page = "sessions" | "terminal" | "console" | "config" | "logs" | "system";

const NAV: { page: Page; label: string; icon: typeof Cpu }[] = [
  { page: "sessions", label: "Sessions", icon: LayoutDashboard },
  { page: "terminal", label: "Terminal", icon: SquareTerminal },
  { page: "console", label: "Chat console", icon: TerminalSquare },
  { page: "config", label: "Configuration", icon: SlidersHorizontal },
  { page: "logs", label: "Logs & audit", icon: ScrollText },
  { page: "system", label: "System", icon: Cpu },
];

export function Shell({
  page,
  onNavigate,
  onSelectSession,
  sessions,
  selectedId,
  system,
  username,
  onLogout,
  children,
}: {
  page: Page;
  onNavigate: (page: Page) => void;
  onSelectSession: (id: string) => void;
  sessions: SessionStatus[];
  selectedId?: string;
  system: SystemInfo | null;
  username: string;
  onLogout: () => void;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-screen">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-zinc-800/80 bg-zinc-950/60 md:flex">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-emerald-500/30 bg-emerald-500/10">
            <Waves className="h-4 w-4 text-emerald-400" />
          </div>
          <div>
            <div className="text-sm font-semibold tracking-tight text-zinc-100">tio-server</div>
            <div className="text-[10px] uppercase tracking-widest text-zinc-500">serial gateway</div>
          </div>
        </div>

        <nav className="mt-2 flex flex-col gap-1 px-3">
          {NAV.map((item) => {
            const Icon = item.icon;
            const active = page === item.page;
            return (
              <button
                key={item.page}
                type="button"
                onClick={() => onNavigate(item.page)}
                className={cn(
                  "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors",
                  active
                    ? "bg-emerald-500/10 text-emerald-200 ring-1 ring-inset ring-emerald-500/20"
                    : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100",
                )}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </button>
            );
          })}
        </nav>

        <div className="mt-6 flex-1 overflow-y-auto px-3">
          <div className="px-3 pb-2 text-[10px] font-medium uppercase tracking-widest text-zinc-600">
            Sessions
          </div>
          <div className="flex flex-col gap-1">
            {sessions.length === 0 ? (
              <p className="px-3 text-xs text-zinc-600">none configured</p>
            ) : null}
            {sessions.map((session) => (
              <button
                key={session.session_id}
                type="button"
                onClick={() => {
                  onSelectSession(session.session_id);
                  onNavigate("console");
                }}
                className={cn(
                  "flex flex-col gap-1 rounded-lg px-3 py-2 text-left transition-colors",
                  selectedId === session.session_id
                    ? "bg-zinc-900 ring-1 ring-inset ring-zinc-700"
                    : "hover:bg-zinc-900/70",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs font-medium text-zinc-200">{session.name}</span>
                  <span
                    className={cn(
                      "h-1.5 w-1.5 shrink-0 rounded-full",
                      session.state === "open"
                        ? "live-dot bg-emerald-400"
                        : session.state === "reconnecting"
                          ? "bg-amber-400"
                          : session.state === "error"
                            ? "bg-red-400"
                            : "bg-zinc-600",
                    )}
                  />
                </div>
                <span className="truncate font-mono text-[10px] text-zinc-500">{session.port}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="border-t border-zinc-800/80 px-4 py-3">
          <div className="flex items-center justify-between text-[11px] text-zinc-500">
            <span>{system ? `v${system.version}` : "—"}</span>
            <span className="inline-flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              {system?.health.sessions_open ?? 0} open
            </span>
          </div>
          <div className="mt-2 flex items-center justify-between">
            <span className="text-xs text-zinc-400">{username}</span>
            <button
              type="button"
              onClick={onLogout}
              className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[11px] text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200"
            >
              <LogOut className="h-3 w-3" /> sign out
            </button>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-zinc-800/80 bg-zinc-950/40 px-4 py-2.5 backdrop-blur md:hidden">
          <Waves className="h-4 w-4 text-emerald-400" />
          <span className="text-sm font-semibold">tio-server</span>
          <div className="ml-auto flex gap-1">
            {NAV.map((item) => (
              <button
                key={item.page}
                type="button"
                onClick={() => onNavigate(item.page)}
                className={cn(
                  "rounded px-2 py-1 text-[11px]",
                  page === item.page ? "bg-emerald-500/15 text-emerald-200" : "text-zinc-400",
                )}
              >
                {item.label.split(" ")[0]}
              </button>
            ))}
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}

export function SessionSelect({
  sessions,
  selectedId,
  onChange,
}: {
  sessions: SessionStatus[];
  selectedId?: string;
  onChange: (id: string) => void;
}) {
  if (sessions.length === 0) {
    return <span className="text-xs text-zinc-500">no sessions</span>;
  }
  return (
    <div className="flex items-center gap-2">
      <select
        value={selectedId ?? sessions[0].session_id}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 rounded-md border border-zinc-700 bg-zinc-950/60 px-2 text-xs text-zinc-200 focus:border-emerald-500/60 focus:outline-none"
      >
        {sessions.map((session) => (
          <option key={session.session_id} value={session.session_id}>
            {session.name} · {session.port}
          </option>
        ))}
      </select>
      {selectedId ? <SessionStateInline sessions={sessions} id={selectedId} /> : null}
    </div>
  );
}

function SessionStateInline({ sessions, id }: { sessions: SessionStatus[]; id: string }) {
  const session = sessions.find((item) => item.session_id === id);
  if (!session) return null;
  return <StateBadge state={session.state} />;
}
