import {
  Cpu,
  LayoutDashboard,
  Plug,
  ScrollText,
  SquareTerminal,
} from "lucide-react";
import type { ReactNode } from "react";

import { LANGS, useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useTheme } from "@/lib/theme";
import type { SessionStatus, SystemInfo } from "@/lib/types";
import { BrandMark } from "@/components/BrandMark";
import { TerminalSettingsDialog } from "@/components/TerminalSettingsDialog";

export type Page = "sessions" | "terminal" | "mcp" | "logs";

const NAV: { page: Page; label: string; short: string; icon: typeof Cpu }[] = [
  { page: "sessions", label: "Sessions", short: "Sessions", icon: LayoutDashboard },
  { page: "terminal", label: "Terminal", short: "Terminal", icon: SquareTerminal },
  { page: "mcp", label: "MCP", short: "MCP", icon: Plug },
  { page: "logs", label: "Logs", short: "Logs", icon: ScrollText },
];

type ShellProps = {
  page: Page;
  onNavigate: (page: Page) => void;
  onSelectSession: (id: string) => void;
  sessions: SessionStatus[];
  selectedId?: string;
  system: SystemInfo | null;
  children: ReactNode;
};

/**
 * One shell for every theme.  Themes are pure data (see lib/themeSpecs.ts):
 * they restyle this layout through CSS custom properties and never change it.
 */
export function Shell({
  page,
  onNavigate,
  onSelectSession,
  sessions,
  selectedId,
  system,
  children,
}: ShellProps) {
  useTheme(); // the shell re-renders on theme switches; the layout never changes
  const { lang, setLang, t } = useI18n();
  const active = page;
  const stateDot = (state: string) =>
    state === "open"
      ? "live-dot bg-emerald-400"
      : state === "reconnecting" || state === "connecting"
        ? "bg-amber-400"
        : state === "error"
          ? "bg-red-400"
          : "bg-zinc-600";

  return (
    <div className="flex h-full min-h-screen">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-zinc-800/80 bg-zinc-950/60 md:flex">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <BrandMark className="h-8 w-8 rounded-lg" />
          <div>
            <div className="text-sm font-semibold tracking-tight text-zinc-100">agent-terminal</div>
            <div className="text-[10px] uppercase tracking-widest text-zinc-500">serial · mcp</div>
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
                {t(item.label)}
              </button>
            );
          })}
        </nav>

        <div className="mt-6 flex-1 overflow-y-auto px-3">
          <div className="px-3 pb-2 text-[10px] font-medium uppercase tracking-widest text-zinc-600">
            {t("Serial sessions")}
          </div>
          <div className="flex flex-col gap-1">
            {sessions.length === 0 ? (
              <p className="px-3 text-xs text-zinc-600">{t("none configured")}</p>
            ) : null}
            {sessions.map((session) => (
              <button
                key={session.session_id}
                type="button"
                onClick={() => onSelectSession(session.session_id)}
                className={cn(
                  "flex flex-col gap-1 rounded-lg px-3 py-2 text-left transition-colors",
                  selectedId === session.session_id
                    ? "bg-zinc-900 ring-1 ring-inset ring-zinc-700"
                    : "hover:bg-zinc-900/70",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs font-medium text-zinc-200">{session.name}</span>
                  <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", stateDot(session.state))} />
                </div>
                <span className="truncate font-mono text-[10px] text-zinc-500">{session.port}</span>
              </button>
            ))}
          </div>

        </div>

        <div className="border-t border-zinc-800/80 px-4 py-2">
          <div className="flex items-center justify-between text-[11px] text-zinc-500">
            <span>{system ? `v${system.version}` : "—"}</span>
            <span className="inline-flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              {t("{n} open", { n: system?.health.sessions_open ?? 0 })}
            </span>
          </div>
          <div className="mt-1.5 flex items-center justify-between gap-2">
            <LanguageSwitch lang={lang} onSelect={setLang} />
            <TerminalSettingsDialog />
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-zinc-800/80 bg-zinc-950/40 px-4 py-2.5 backdrop-blur md:hidden">
          <BrandMark className="h-5 w-5 rounded" />
          <span className="text-sm font-semibold">agent-terminal</span>
          <div className="ml-auto flex items-center gap-2">
            <LanguageSwitch lang={lang} onSelect={setLang} />
            <TerminalSettingsDialog />
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
                {t(item.short)}
              </button>
            ))}
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}

/** EN / 中 toggle. Kept tiny so it fits the sidebar footer and the mobile bar. */
function LanguageSwitch({
  lang,
  onSelect,
}: {
  lang: string;
  onSelect: (next: "en" | "zh") => void;
}) {
  return (
    <div className="inline-flex overflow-hidden rounded border border-zinc-800" role="group">
      {LANGS.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => onSelect(item.id)}
          aria-pressed={lang === item.id}
          title={item.label}
          className={cn(
            "px-1.5 py-0.5 text-[10px] transition-colors",
            lang === item.id
              ? "bg-emerald-500/15 text-emerald-200"
              : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200",
          )}
        >
          {item.short}
        </button>
      ))}
    </div>
  );
}
