import { useCallback, useEffect, useState } from "react";
import {
  Cable,
  Copy,
  Loader2,
  Maximize,
  Pencil,
  Pin,
  PinOff,
  Save,
  Server,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

import { SshTerminalPage } from "@/pages/SshTerminalPage";
import { TerminalPage } from "@/pages/TerminalPage";
import { ContextMenu, type ContextMenuEntry } from "@/components/ui/context-menu";
import { api } from "@/lib/api";
import {
  SESSION_COLORS,
  loadAppearances,
  patchAppearance,
  type SessionAppearance,
} from "@/lib/session-appearance";
import { getTerminalSettings, updateTerminalSettings } from "@/lib/terminal-settings";
import { cn } from "@/lib/utils";
import type { SessionStatus, SshSessionStatus } from "@/lib/types";

export type TerminalKind = "serial" | "ssh";

interface TabRef {
  kind: TerminalKind;
  id: string;
}

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
  // keep-alive registry: every terminal that has ever been active stays
  // mounted (hidden via CSS), so tab switches never destroy xterm state
  const [alive, setAlive] = useState<Record<string, { kind: TerminalKind; id: string }>>({});
  // per-session UI accents (color dot, pin) persisted in localStorage
  const [appearance, setAppearance] = useState<Record<string, SessionAppearance>>(() => loadAppearances());
  const [menu, setMenu] = useState<{ x: number; y: number } & TabRef | null>(null);

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

  const activeKey =
    activeKind && activeId ? `${activeKind}:${activeId}` : null;

  useEffect(() => {
    if (!activeKey || !activeKind || !activeId) return;
    setAlive((previous) =>
      previous[activeKey]
        ? previous
        : { ...previous, [activeKey]: { kind: activeKind, id: activeId } },
    );
  }, [activeKey, activeKind, activeId]);

  // drop keep-alive entries whose session disappeared (SSH disconnects,
  // serial sessions deleted on the Sessions page)
  useEffect(() => {
    setAlive((previous) => {
      const next: typeof previous = {};
      let changed = false;
      for (const [key, item] of Object.entries(previous)) {
        const exists =
          item.kind === "ssh"
            ? sshSessions.some((entry) => entry.session_id === item.id)
            : sessions.some((entry) => entry.session_id === item.id);
        if (exists) next[key] = item;
        else changed = true;
      }
      return changed ? next : previous;
    });
  }, [sshSessions, sessions]);

  // pinned tabs float to the front of their group
  const pinnedFirst = <T,>(list: T[], idOf: (item: T) => string) =>
    [...list].sort((a, b) => {
      const pa = appearance[idOf(a)]?.pinned ? 0 : 1;
      const pb = appearance[idOf(b)]?.pinned ? 0 : 1;
      return pa - pb;
    });
  const serialTabs = pinnedFirst(sessions, (item) => item.session_id);
  const sshTabs = pinnedFirst(sshSessions, (item) => item.session_id);

  const patch = (id: string, delta: Partial<SessionAppearance>) =>
    setAppearance(patchAppearance(id, delta));

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

  /** Serial "close" = release the port; the configured session stays listed. */
  const closeSerialTab = async (id: string) => {
    try {
      await api.closeSession(id);
      await refresh();
      notify("serial port closed", "success");
    } catch (error) {
      notify(`${(error as { code?: string }).code ?? "ERROR"}: ${(error as Error).message}`, "error");
    }
  };

  const closeTabs = async (targets: TabRef[]) => {
    if (targets.length === 0) return;
    let failures = 0;
    for (const target of targets) {
      try {
        if (target.kind === "ssh") await api.sshDisconnect(target.id);
        else await api.closeSession(target.id);
      } catch {
        failures += 1;
      }
    }
    await Promise.all([loadSsh(), refresh()]);
    if (failures > 0) notify(`${failures} session(s) failed to close`, "error");
  };

  const renameSession = async (kind: TerminalKind, id: string) => {
    const serial = kind === "serial" ? sessions.find((item) => item.session_id === id) : undefined;
    const ssh = kind === "ssh" ? sshSessions.find((item) => item.session_id === id) : undefined;
    const current = ssh ?? serial;
    const next = window.prompt("Session name", current?.name ?? "");
    if (!next || next === current?.name) return;
    try {
      if (kind === "ssh") {
        await api.sshRenameSession(id, next);
        await loadSsh();
      } else if (serial) {
        await api.updateSession(id, {
          name: next,
          port: serial.port,
          baudrate: serial.config.baudrate,
          bytesize: serial.config.bytesize,
          parity: serial.config.parity,
          stopbits: serial.config.stopbits,
          flow: serial.config.flow,
          open_mode: serial.config.open_mode,
          auto_reconnect: serial.auto_reconnect,
        });
        await refresh();
      }
      notify(`session renamed to ${next}`, "success");
    } catch (error) {
      notify(`${(error as { code?: string }).code ?? "ERROR"}: ${(error as Error).message}`, "error");
    }
  };

  /** Open a second SSH connection to the same host profile. */
  const duplicateSsh = async (id: string) => {
    const current = sshSessions.find((item) => item.session_id === id);
    if (!current) return;
    try {
      const result = await api.sshConnect(current.host_id, { use_saved: true });
      await loadSsh();
      onSelectSsh(result.session.session_id);
      notify(`duplicated ${current.name} — new session opened`, "success");
    } catch (error) {
      notify(
        `duplicate failed (${(error as { code?: string }).code ?? "ERROR"}) — saved credentials required; connect once from the Connections page with "remember"`,
        "error",
      );
    }
  };

  const saveOutput = async (kind: TerminalKind, id: string) => {
    const current =
      kind === "ssh"
        ? sshSessions.find((item) => item.session_id === id)
        : sessions.find((item) => item.session_id === id);
    const url =
      kind === "ssh"
        ? `/api/ssh/sessions/${encodeURIComponent(id)}/export?format=txt`
        : `/api/sessions/${encodeURIComponent(id)}/export?format=txt`;
    try {
      const response = await fetch(url, { credentials: "same-origin" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `${(current?.name ?? id).replace(/[^\w.-]+/g, "_")}-output.log`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(link.href), 30_000);
      notify("terminal output saved", "success");
    } catch (error) {
      notify(`export failed: ${(error as Error).message}`, "error");
    }
  };

  const changeFontSize = (delta: number) => {
    const next = Math.min(72, Math.max(8, getTerminalSettings().fontSize + delta));
    updateTerminalSettings({ fontSize: next });
    notify(`terminal font size: ${next}px`, "info");
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      document.documentElement.requestFullscreen().catch(() => notify("fullscreen unavailable", "error"));
    }
  };

  const openMenu = (event: React.MouseEvent, tab: TabRef) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, ...tab });
  };

  const menuEntries = (tab: TabRef): ContextMenuEntry[] => {
    const ssh = tab.kind === "ssh" ? sshSessions.find((item) => item.session_id === tab.id) : undefined;
    const name = ssh?.name ?? sessions.find((item) => item.session_id === tab.id)?.name ?? tab.id;
    const acc = appearance[tab.id];
    const ordered: TabRef[] = [
      ...serialTabs.map((item) => ({ kind: "serial" as const, id: item.session_id })),
      ...sshTabs.map((item) => ({ kind: "ssh" as const, id: item.session_id })),
    ];
    const index = ordered.findIndex((item) => item.kind === tab.kind && item.id === tab.id);
    const notPinned = (item: TabRef) => !(appearance[item.id]?.pinned ?? false);
    const left = ordered.slice(0, index).filter(notPinned);
    const right = ordered.slice(index + 1).filter(notPinned);
    const close = (targets: TabRef[]) => () => void closeTabs(targets);

    return [
      {
        key: "rename",
        label: "Rename session",
        icon: <Pencil className="h-3.5 w-3.5" />,
        onSelect: () => void renameSession(tab.kind, tab.id),
      },
      {
        key: "color",
        content: (
          <div className="flex items-center gap-1.5 py-0.5">
            <span className="mr-0.5 text-[11px] text-zinc-500">color</span>
            {SESSION_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                aria-label={`tab color ${color}`}
                onClick={() => patch(tab.id, { color })}
                className={cn(
                  "h-3.5 w-3.5 rounded-full border transition-transform hover:scale-110",
                  acc?.color === color ? "border-zinc-100" : "border-transparent",
                )}
                style={{ background: color }}
              />
            ))}
            <button
              type="button"
              aria-label="clear tab color"
              onClick={() => patch(tab.id, { color: null })}
              className={cn(
                "rounded px-1 text-[10px] text-zinc-500 hover:text-zinc-200",
                !acc?.color && "text-zinc-300",
              )}
            >
              none
            </button>
          </div>
        ),
      },
      ...(tab.kind === "ssh"
        ? [
            {
              key: "duplicate",
              label: "Duplicate session",
              icon: <Copy className="h-3.5 w-3.5" />,
              onSelect: () => void duplicateSsh(tab.id),
            },
          ]
        : []),
      { key: "sep-close", separator: true },
      {
        key: "close",
        label: `Close ${name}`,
        icon: <X className="h-3.5 w-3.5" />,
        danger: true,
        onSelect:
          tab.kind === "ssh"
            ? () => void closeSshTab(tab.id)
            : () => void closeSerialTab(tab.id),
      },
      {
        key: "close-left",
        label: `Close ${left.length} tab${left.length === 1 ? "" : "s"} to the left`,
        disabled: left.length === 0,
        icon: <X className="h-3.5 w-3.5" />,
        onSelect: close(left),
      },
      {
        key: "close-right",
        label: `Close ${right.length} tab${right.length === 1 ? "" : "s"} to the right`,
        disabled: right.length === 0,
        icon: <X className="h-3.5 w-3.5" />,
        onSelect: close(right),
      },
      {
        key: "close-others",
        label: `Close ${left.length + right.length} other tab${left.length + right.length === 1 ? "" : "s"}`,
        disabled: left.length + right.length === 0,
        icon: <X className="h-3.5 w-3.5" />,
        onSelect: close([...left, ...right]),
      },
      { key: "sep-pin", separator: true },
      {
        key: "pin",
        label: acc?.pinned ? "Unpin tab" : "Pin tab",
        icon: acc?.pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />,
        onSelect: () => patch(tab.id, { pinned: !acc?.pinned }),
      },
      {
        key: "save",
        label: "Save terminal output",
        icon: <Save className="h-3.5 w-3.5" />,
        onSelect: () => void saveOutput(tab.kind, tab.id),
      },
      { key: "sep-view", separator: true },
      {
        key: "font-up",
        label: "Increase font size",
        hint: `${getTerminalSettings().fontSize}px`,
        icon: <ZoomIn className="h-3.5 w-3.5" />,
        onSelect: () => changeFontSize(1),
      },
      {
        key: "font-down",
        label: "Decrease font size",
        icon: <ZoomOut className="h-3.5 w-3.5" />,
        onSelect: () => changeFontSize(-1),
      },
      {
        key: "fullscreen",
        label: document.fullscreenElement ? "Exit fullscreen" : "Fullscreen",
        icon: <Maximize className="h-3.5 w-3.5" />,
        onSelect: toggleFullscreen,
      },
    ];
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-zinc-950">
      <div className="flex items-center gap-1 overflow-x-auto border-b border-zinc-800/80 bg-zinc-950/80 px-2 py-1">
        {serialTabs.map((item) => {
          const acc = appearance[item.session_id];
          const isActive = activeKind === "serial" && activeId === item.session_id;
          return (
            <button
              key={`serial-${item.session_id}`}
              type="button"
              onClick={() => onSelectSerial(item.session_id)}
              onContextMenu={(event) => openMenu(event, { kind: "serial", id: item.session_id })}
              className={cn(
                "flex shrink-0 items-center gap-1.5 rounded-t border-b-2 px-2.5 py-1 text-[11px] transition-colors",
                isActive
                  ? "bg-zinc-900 text-zinc-100"
                  : "border-transparent text-zinc-500 hover:bg-zinc-900/60 hover:text-zinc-200",
              )}
              style={isActive ? { borderBottomColor: acc?.color ?? "#34d399" } : undefined}
              title={`serial ${item.port}`}
            >
              <Cable className="h-3 w-3 shrink-0" />
              <span className="max-w-[12rem] truncate">{item.name}</span>
              {acc?.pinned ? <Pin className="h-2.5 w-2.5 shrink-0 text-zinc-500" /> : null}
              {acc?.color ? (
                <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: acc.color }} />
              ) : (
                <span
                  className={cn(
                    "h-1.5 w-1.5 shrink-0 rounded-full",
                    item.state === "open"
                      ? "bg-emerald-400"
                      : item.state === "reconnecting"
                        ? "bg-amber-400"
                        : item.state === "error"
                          ? "bg-red-400"
                          : "bg-zinc-600",
                  )}
                />
              )}
            </button>
          );
        })}
        {sshTabs.map((item) => {
          const acc = appearance[item.session_id];
          const isActive = activeKind === "ssh" && activeId === item.session_id;
          return (
            <div
              key={`ssh-${item.session_id}`}
              className={cn(
                "group flex shrink-0 items-center rounded-t border-b-2 transition-colors",
                isActive
                  ? "bg-zinc-900 text-zinc-100"
                  : "border-transparent text-zinc-500 hover:bg-zinc-900/60 hover:text-zinc-200",
              )}
              style={isActive ? { borderBottomColor: acc?.color ?? "#34d399" } : undefined}
              title={`${item.username}@${item.host}:${item.port}`}
              onContextMenu={(event) => openMenu(event, { kind: "ssh", id: item.session_id })}
            >
              <button
                type="button"
                onClick={() => onSelectSsh(item.session_id)}
                className="flex items-center gap-1.5 py-1 pl-2.5 pr-1 text-[11px]"
              >
                <Server className="h-3 w-3 shrink-0" />
                <span className="max-w-[12rem] truncate">{item.name}</span>
                {acc?.pinned ? <Pin className="h-2.5 w-2.5 shrink-0 text-zinc-500" /> : null}
                {acc?.color ? (
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: acc.color }} />
                ) : (
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
                )}
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
          );
        })}
        <button
          type="button"
          onClick={onOpenSessions}
          className="shrink-0 rounded px-2 py-1 text-[11px] text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200"
        >
          + session
        </button>
      </div>

      <div className="relative min-h-0 flex-1">
        {Object.entries(alive).map(([key, item]) => {
          const active = key === activeKey;
          return (
            <div key={key} className={cn("absolute inset-0", active ? "block" : "hidden")}>
              {item.kind === "serial" ? (
                <TerminalPage
                  sessions={sessions}
                  session={sessions.find((entry) => entry.session_id === item.id)}
                  selectedId={item.id}
                  onSelect={onSelectSerial}
                  refresh={refresh}
                  notify={notify}
                  showSessionPicker={false}
                  active={active}
                />
              ) : (
                <SshTerminalPage
                  sessionId={item.id}
                  onBack={onOpenSessions}
                  onSelect={onSelectSsh}
                  notify={notify}
                  showSessionTabs={false}
                  active={active}
                />
              )}
            </div>
          );
        })}
        {Object.keys(alive).length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-xs text-zinc-500">
            <p>No terminal session is open.</p>
            <button type="button" onClick={onOpenSessions} className="text-emerald-300 hover:underline">
              Open a serial or SSH session
            </button>
          </div>
        ) : null}
      </div>

      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          width={250}
          onClose={() => setMenu(null)}
          entries={menuEntries(menu)}
        />
      ) : null}
    </div>
  );
}
