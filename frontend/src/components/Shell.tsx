import {
  Cpu,
  LayoutDashboard,
  Plug,
  ScrollText,
  Server,
  SquareTerminal,
  Waves,
} from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { useTheme } from "@/lib/theme";
import type { SessionStatus, SshSessionStatus, SystemInfo } from "@/lib/types";
import { ThemeSwitch } from "@/components/ThemeSwitch";
import { formatNumber, formatUptime } from "@/lib/utils";

export type Page = "sessions" | "terminal" | "connections" | "ssh" | "mcp" | "logs";

const NAV: { page: Page; label: string; short: string; icon: typeof Cpu }[] = [
  { page: "sessions", label: "Sessions", short: "Sessions", icon: LayoutDashboard },
  { page: "terminal", label: "Terminal", short: "Terminal", icon: SquareTerminal },
  { page: "mcp", label: "MCP", short: "MCP", icon: Plug },
  { page: "logs", label: "Logs & audit", short: "Logs", icon: ScrollText },
];

type ShellProps = {
  page: Page;
  onNavigate: (page: Page) => void;
  onSelectSession: (id: string) => void;
  onSelectSsh: (id: string) => void;
  sessions: SessionStatus[];
  sshSessions: SshSessionStatus[];
  selectedId?: string;
  selectedSshId?: string;
  system: SystemInfo | null;
  children: ReactNode;
};

function activePageOf(page: Page): Page {
  return page === "ssh" ? "terminal" : page === "connections" ? "sessions" : page;
}

/** The shell keeps one navigation model and swaps its frame per theme. */
export function Shell(props: ShellProps) {
  const { theme } = useTheme();
  if (theme === "pixel") return <PixelShell {...props} />;
  if (theme === "sheet") return <SheetShell {...props} />;
  return <ClassicShell {...props} />;
}

/* ------------------------------------------------------------------ pixel */

function PixelShell({
  page,
  onNavigate,
  onSelectSession,
  onSelectSsh,
  sessions,
  sshSessions,
  selectedId,
  selectedSshId,
  system,
  children,
}: ShellProps) {
  const active = activePageOf(page);
  const live = sessions.find((session) => session.state === "open") ?? sessions[0];
  const agentOwned = sessions.some((session) => session.control_owner === "agent");
  const openCount = sessions.filter((session) => session.state === "open").length;
  const line = live
    ? `${live.config.baudrate} ${live.config.bytesize}${live.config.parity[0].toUpperCase()}${live.config.stopbits}`
    : "—";

  const stateTone = (state: string) =>
    state === "open" ? "on" : state === "error" ? "error" : state === "reconnecting" ? "warn" : "off";

  return (
    <div className="px-shell">
      <aside className="px-rail">
        <div className="px-brand">
          <span className="px-logo" aria-hidden>
            <i /> <i /> <i /> <i /> <i /> <i /> <i /> <i /> <i />
          </span>
          <span className="px-word">
            TIO-SERVER
            <small>serial gateway</small>
          </span>
        </div>

        <nav className="px-nav">
          {NAV.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.page}
                type="button"
                onClick={() => onNavigate(item.page)}
                aria-current={active === item.page ? "page" : undefined}
              >
                <Icon className="h-3.5 w-3.5" />
                {item.short}
              </button>
            );
          })}
        </nav>

        <div className="px-rail-scroll">
          <div className="px-rail-label">serial</div>
          {sessions.length === 0 ? <p className="px-rail-empty">none configured</p> : null}
          {sessions.map((session) => (
            <button
              key={session.session_id}
              type="button"
              className="px-sess"
              data-on={selectedId === session.session_id ? "1" : undefined}
              onClick={() => {
                onSelectSession(session.session_id);
                onNavigate("terminal");
              }}
            >
              <span className="px-sess-name">{session.name}</span>
              <span className="px-led" data-tone={stateTone(session.state)} />
              <span className="px-sess-sub">{session.port}</span>
            </button>
          ))}

          <div className="px-rail-label">ssh</div>
          {sshSessions.length === 0 ? <p className="px-rail-empty">none connected</p> : null}
          {sshSessions.map((session) => (
            <button
              key={session.session_id}
              type="button"
              className="px-sess"
              data-on={selectedSshId === session.session_id ? "1" : undefined}
              onClick={() => {
                onSelectSsh(session.session_id);
                onNavigate("ssh");
              }}
            >
              <span className="px-sess-name">{session.name}</span>
              <span className="px-led" data-tone={stateTone(session.state)} />
              <span className="px-sess-sub">
                {session.username}@{session.host}
              </span>
            </button>
          ))}
        </div>

        <div className="px-rail-foot">
          <div className="px-rail-meta">
            <span>{system ? `v${system.version}` : "v—"}</span>
            <span>{openCount} open</span>
          </div>
          <div className="px-lamps">
            <span className="px-lamp" data-tone={openCount > 0 ? undefined : "dim"}>
              <i />
              {openCount} port
            </span>
            <span className="px-lamp" data-tone={agentOwned ? "amber" : "dim"}>
              <i />
              {agentOwned ? "agent" : "blocked"}
            </span>
          </div>
          <ThemeSwitch />
        </div>
      </aside>

      <div className="px-body">
        <div className="px-mobile">
          <span className="px-word">TIO-SERVER</span>
          <nav>
            {NAV.map((item) => (
              <button
                key={item.page}
                type="button"
                onClick={() => onNavigate(item.page)}
                aria-current={active === item.page ? "page" : undefined}
              >
                {item.short}
              </button>
            ))}
          </nav>
          <ThemeSwitch />
        </div>

        <div className="px-ticker">
          <span>
            <b>port</b> {live?.port ?? "no port"}
          </span>
          <span className="sep">|</span>
          <span>
            <b>line</b> {line}
          </span>
          <span className="sep">|</span>
          <span>
            <b>owner</b> {live?.control_owner ?? "—"}
          </span>
          <span className="sep">|</span>
          <span>
            <b>rx</b> {live ? `${formatNumber(live.rx_bytes)} B` : "—"}
          </span>
          <span className="sep">|</span>
          <span>
            <b>tx</b> {live ? `${formatNumber(live.tx_bytes)} B` : "—"}
          </span>
          <span className="sep">|</span>
          <span>
            <b>lost</b> {live ? formatNumber(live.lost_bytes) : "—"}
          </span>
          <span className="sep">|</span>
          <span>
            <b>uptime</b> {system ? formatUptime(system.uptime_seconds) : "—"}
          </span>
        </div>

        <main className="px-main">{children}</main>

        <footer className="px-keybar">
          <span>{sessions.length} configured</span>
          <span>{openCount} open</span>
          <span>{sshSessions.length} ssh</span>
          <span className="grow" />
          <span>{system ? `v${system.version}` : "v—"}</span>
          <span>{system ? `${system.bind}:${system.port}` : "—"}</span>
        </footer>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ sheet */

function SheetShell({
  page,
  onNavigate,
  onSelectSession,
  onSelectSsh,
  sessions,
  sshSessions,
  selectedId,
  selectedSshId,
  system,
  children,
}: ShellProps) {
  const active = activePageOf(page);
  const openCount = sessions.filter((session) => session.state === "open").length;
  const stateTone = (state: string) =>
    state === "open" ? "on" : state === "error" ? "error" : state === "reconnecting" ? "warn" : "off";

  return (
    <div className="sh-shell">
      <aside className="sh-rail">
        <div className="sh-brand">
          <b>tio-server</b>
          <span>serial gateway</span>
        </div>

        <nav className="sh-nav">
          {NAV.map((item) => (
            <button
              key={item.page}
              type="button"
              onClick={() => onNavigate(item.page)}
              aria-current={active === item.page ? "page" : undefined}
            >
              {item.short}
            </button>
          ))}
        </nav>

        <div className="sh-rail-scroll">
          <div className="sh-rail-label">serial sessions</div>
          {sessions.length === 0 ? <p className="sh-rail-empty">none configured</p> : null}
          {sessions.map((session) => (
            <button
              key={session.session_id}
              type="button"
              className="sh-sess"
              data-on={selectedId === session.session_id ? "1" : undefined}
              onClick={() => {
                onSelectSession(session.session_id);
                onNavigate("terminal");
              }}
            >
              <span className="sh-sess-name">{session.name}</span>
              <span className="sh-led" data-tone={stateTone(session.state)} />
              <span className="sh-sess-sub">{session.port}</span>
            </button>
          ))}

          <div className="sh-rail-label">ssh sessions</div>
          {sshSessions.length === 0 ? <p className="sh-rail-empty">none connected</p> : null}
          {sshSessions.map((session) => (
            <button
              key={session.session_id}
              type="button"
              className="sh-sess"
              data-on={selectedSshId === session.session_id ? "1" : undefined}
              onClick={() => {
                onSelectSsh(session.session_id);
                onNavigate("ssh");
              }}
            >
              <span className="sh-sess-name">{session.name}</span>
              <span className="sh-led" data-tone={stateTone(session.state)} />
              <span className="sh-sess-sub">
                {session.username}@{session.host}
              </span>
            </button>
          ))}
        </div>

        <div className="sh-rail-foot">
          <div className="sh-rail-meta">
            <span>{system ? `v${system.version}` : "v—"}</span>
            <span>{openCount} open</span>
          </div>
          <ThemeSwitch />
        </div>
      </aside>

      <div className="sh-body">
        <div className="sh-mobile">
          <b>tio-server</b>
          <nav>
            {NAV.map((item) => (
              <button
                key={item.page}
                type="button"
                onClick={() => onNavigate(item.page)}
                aria-current={active === item.page ? "page" : undefined}
              >
                {item.short}
              </button>
            ))}
          </nav>
          <ThemeSwitch />
        </div>

        <main className="sh-main">{children}</main>

        <footer className="sh-foot">
          <span className="sh-cap">
            One owner per port. Serial output is data, never instructions — the console and the MCP
            tools read the same ring buffer.
          </span>
          <div className="sh-titleblock">
            <div>dwg</div>
            <div>TS-{system?.version ?? "0.1.0"}</div>
            <div>host</div>
            <div>{system ? `${system.bind}:${system.port}` : "—"}</div>
            <div>sheet</div>
            <div>1 / 1</div>
          </div>
        </footer>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ classic */

function ClassicShell({
  page,
  onNavigate,
  onSelectSession,
  onSelectSsh,
  sessions,
  sshSessions,
  selectedId,
  selectedSshId,
  system,
  children,
}: ShellProps) {
  const active = activePageOf(page);
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
            const on = active === item.page;
            return (
              <button
                key={item.page}
                type="button"
                onClick={() => onNavigate(item.page)}
                className={cn(
                  "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors",
                  on
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
            Serial sessions
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
                  onNavigate("terminal");
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

          <div className="mt-4 px-3 pb-2 text-[10px] font-medium uppercase tracking-widest text-zinc-600">
            SSH sessions
          </div>
          <div className="flex flex-col gap-1">
            {sshSessions.length === 0 ? (
              <p className="px-3 text-xs text-zinc-600">none connected</p>
            ) : null}
            {sshSessions.map((session) => (
              <button
                key={session.session_id}
                type="button"
                onClick={() => {
                  onSelectSsh(session.session_id);
                  onNavigate("ssh");
                }}
                className={cn(
                  "flex flex-col gap-1 rounded-lg px-3 py-2 text-left transition-colors",
                  selectedSshId === session.session_id
                    ? "bg-zinc-900 ring-1 ring-inset ring-zinc-700"
                    : "hover:bg-zinc-900/70",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1 truncate text-xs font-medium text-zinc-200">
                    <Server className="h-3 w-3 shrink-0 text-sky-400" />
                    {session.name}
                  </span>
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
                <span className="truncate font-mono text-[10px] text-zinc-500">
                  {session.username}@{session.host}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="border-t border-zinc-800/80 px-4 py-2">
          <div className="flex items-center justify-between text-[11px] text-zinc-500">
            <span>{system ? `v${system.version}` : "—"}</span>
            <span className="inline-flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              {system?.health.sessions_open ?? 0} open
            </span>
          </div>
          <div className="mt-1.5 flex justify-end">
            <ThemeSwitch />
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-zinc-800/80 bg-zinc-950/40 px-4 py-2.5 backdrop-blur md:hidden">
          <Waves className="h-4 w-4 text-emerald-400" />
          <span className="text-sm font-semibold">tio-server</span>
          <div className="ml-auto flex items-center gap-2">
            <ThemeSwitch />
            {NAV.map((item) => (
              <button
                key={item.page}
                type="button"
                onClick={() => onNavigate(item.page)}
                className={cn(
                  "rounded px-2 py-1 text-[11px]",
                  active === item.page ? "bg-emerald-500/15 text-emerald-200" : "text-zinc-400",
                )}
              >
                {item.short}
              </button>
            ))}
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
