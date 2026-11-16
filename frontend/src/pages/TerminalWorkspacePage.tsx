import { useEffect, useMemo, useState } from "react";
import {
  Cable,
  Maximize,
  Pencil,
  Pin,
  PinOff,
  Save,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

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
import type { SessionStatus } from "@/lib/types";

interface TabRef {
  id: string;
}

/**
 * The terminal workspace: a tab bar over the configured serial sessions.  Every
 * terminal that has ever been active stays mounted (hidden via CSS), so tab
 * switches never destroy xterm state.
 */
export function TerminalWorkspacePage({
  sessionId,
  sessions,
  selectedId,
  refresh,
  notify,
  onSelectSerial,
  onOpenSessions,
}: {
  sessionId?: string;
  sessions: SessionStatus[];
  selectedId?: string;
  refresh: () => Promise<void>;
  notify: (message: string, tone?: "info" | "error" | "success") => void;
  onSelectSerial: (id: string) => void;
  onOpenSessions: () => void;
}) {
  // keep-alive registry: every terminal that was active stays mounted so tab
  // switches preserve scrollback and the WebSocket feed
  const [alive, setAlive] = useState<Record<string, string>>({});
  // per-session UI accents (color dot, pin) persisted in localStorage
  const [appearance, setAppearance] = useState<Record<string, SessionAppearance>>(() => loadAppearances());
  const [menu, setMenu] = useState<{ x: number; y: number } & TabRef | null>(null);

  const current =
    sessions.find((item) => item.session_id === sessionId) ??
    sessions.find((item) => item.session_id === selectedId) ??
    sessions[0];
  const activeId = current?.session_id ?? null;

  useEffect(() => {
    if (!activeId) return;
    setAlive((previous) => (previous[activeId] ? previous : { ...previous, [activeId]: activeId }));
  }, [activeId]);

  // drop keep-alive entries whose session was deleted on the Sessions page
  useEffect(() => {
    setAlive((previous) => {
      const next: typeof previous = {};
      let changed = false;
      for (const [key, id] of Object.entries(previous)) {
        if (sessions.some((entry) => entry.session_id === id)) next[key] = id;
        else changed = true;
      }
      return changed ? next : previous;
    });
  }, [sessions]);

  // pinned tabs float to the front
  const tabs = useMemo(
    () =>
      [...sessions].sort((a, b) => {
        const pa = appearance[a.session_id]?.pinned ? 0 : 1;
        const pb = appearance[b.session_id]?.pinned ? 0 : 1;
        return pa - pb;
      }),
    [sessions, appearance],
  );

  const patch = (id: string, delta: Partial<SessionAppearance>) =>
    setAppearance(patchAppearance(id, delta));

  /** Closing a serial tab releases the port; the session stays configured. */
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
        await api.closeSession(target.id);
      } catch {
        failures += 1;
      }
    }
    await refresh();
    if (failures > 0) notify(`${failures} session(s) failed to close`, "error");
  };

  const renameSession = async (id: string) => {
    const serial = sessions.find((item) => item.session_id === id);
    const next = window.prompt("Session name", serial?.name ?? "");
    if (!next || next === serial?.name || !serial) return;
    try {
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
      notify(`session renamed to ${next}`, "success");
    } catch (error) {
      notify(`${(error as { code?: string }).code ?? "ERROR"}: ${(error as Error).message}`, "error");
    }
  };

  const saveOutput = async (id: string) => {
    const serial = sessions.find((item) => item.session_id === id);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/export?format=txt`, {
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `${(serial?.name ?? id).replace(/[^\w.-]+/g, "_")}-output.log`;
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
    const name = sessions.find((item) => item.session_id === tab.id)?.name ?? tab.id;
    const acc = appearance[tab.id];
    const ordered: TabRef[] = tabs.map((item) => ({ id: item.session_id }));
    const index = ordered.findIndex((item) => item.id === tab.id);
    const notPinned = (item: TabRef) => !(appearance[item.id]?.pinned ?? false);
    const left = ordered.slice(0, index).filter(notPinned);
    const right = ordered.slice(index + 1).filter(notPinned);
    const close = (targets: TabRef[]) => () => void closeTabs(targets);

    return [
      {
        key: "rename",
        label: "Rename session",
        icon: <Pencil className="h-3.5 w-3.5" />,
        onSelect: () => void renameSession(tab.id),
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
      { key: "sep-close", separator: true },
      {
        key: "close",
        label: `Close ${name}`,
        icon: <X className="h-3.5 w-3.5" />,
        danger: true,
        onSelect: () => void closeSerialTab(tab.id),
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
        onSelect: () => void saveOutput(tab.id),
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
        {tabs.map((item) => {
          const acc = appearance[item.session_id];
          const isActive = activeId === item.session_id;
          return (
            <button
              key={item.session_id}
              type="button"
              onClick={() => onSelectSerial(item.session_id)}
              onContextMenu={(event) => openMenu(event, { id: item.session_id })}
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
        <button
          type="button"
          onClick={onOpenSessions}
          className="shrink-0 rounded px-2 py-1 text-[11px] text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200"
        >
          + session
        </button>
      </div>

      <div className="relative min-h-0 flex-1">
        {Object.entries(alive).map(([key, id]) => {
          const active = key === activeId;
          return (
            <div key={key} className={cn("absolute inset-0", active ? "block" : "hidden")}>
              <TerminalPage
                sessions={sessions}
                session={sessions.find((entry) => entry.session_id === id)}
                selectedId={id}
                onSelect={onSelectSerial}
                refresh={refresh}
                notify={notify}
                showSessionPicker={false}
                active={active}
              />
            </div>
          );
        })}
        {Object.keys(alive).length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-xs text-zinc-500">
            <p>No terminal session is open.</p>
            <button type="button" onClick={onOpenSessions} className="text-emerald-300 hover:underline">
              Open a serial session
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
