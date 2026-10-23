import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Download,
  Eye,
  EyeOff,
  FolderOpen,
  Info,
  Keyboard,
  Loader2,
  Power,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

import { Button } from "@/components/ui/button";
import { SshFilesPanel } from "@/components/SshFilesPanel";
import { TerminalSearchBar } from "@/components/TerminalSearchBar";
import { TerminalSettingsDialog } from "@/components/TerminalSettingsDialog";
import { api, sshConsoleUrl } from "@/lib/api";
import { useTheme } from "@/lib/theme";
import { terminalTheme } from "@/lib/termTheme";
import {
  applyTerminalSettings,
  attachScrollFollow,
  attachTerminalEnhancements,
  createOverflowResync,
  terminalOptions,
  type Enhancements,
} from "@/lib/terminal-setup";
import { getTerminalSettings, subscribeTerminalSettings } from "@/lib/terminal-settings";
import { petNoteCommandExit, petNoteLink, petNoteOutput, petNoteTyping } from "@/lib/pet-events";
import { b64ToBytes, bytesToB64, cn, formatBytes, isModalOpen } from "@/lib/utils";
import type { SshSessionStatus } from "@/lib/types";

export function SshTerminalPage({
  sessionId,
  onBack,
  onSelect,
  notify,
  showSessionTabs = true,
  active = true,
}: {
  sessionId: string;
  onBack: () => void;
  onSelect: (sessionId: string) => void;
  notify: (message: string, tone?: "info" | "error" | "success") => void;
  showSessionTabs?: boolean;
  /** false while this terminal is kept alive but hidden behind another tab */
  active?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const enhancementsRef = useRef<Enhancements | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const cursorRef = useRef<number | null>(null);
  const autoScrollRef = useRef(true);
  const shouldResyncRef = useRef(createOverflowResync());
  const activeRef = useRef(active);
  activeRef.current = active;
  const [status, setStatus] = useState<SshSessionStatus | null>(null);
  const [openSessions, setOpenSessions] = useState<SshSessionStatus[]>([]);
  const [connected, setConnected] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [dropped, setDropped] = useState(0);
  const [received, setReceived] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [generation, setGeneration] = useState(0);
  /** Right-hand panel: starts collapsed; the toolbar buttons open it. */
  const [panel, setPanel] = useState<"files" | "details" | null>(null);
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentPulse, setAgentPulse] = useState<{
    action: string;
    source: string;
    at: string;
    command?: string | null;
    output?: string | null;
    output_truncated?: boolean;
    exit_code?: number | null;
    elapsed_ms?: number | null;
  } | null>(null);
  const agentTimerRef = useRef<number | undefined>(undefined);
  const { theme } = useTheme();
  const themeRef = useRef(theme);
  themeRef.current = theme;
  autoScrollRef.current = autoScroll;

  const refreshStatus = useCallback(async () => {
    try {
      const [next, sessions] = await Promise.all([api.sshSession(sessionId), api.sshSessions()]);
      setStatus(next);
      setOpenSessions(sessions.sessions);
      setLastError(next.last_error);
    } catch (error) {
      const failure = error as { code?: string; message?: string };
      if (failure.code === "NOT_FOUND") {
        setLastError("SSH session no longer exists");
      }
    }
  }, [sessionId]);

  useEffect(() => {
    void refreshStatus();
    const timer = window.setInterval(() => void refreshStatus(), 2500);
    return () => window.clearInterval(timer);
  }, [refreshStatus]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal(terminalOptions(getTerminalSettings(), terminalTheme(themeRef.current)));
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.open(host);
    fit.fit();
    term.focus();
    termRef.current = term;
    searchRef.current = search;

    const sendInput = (data: string) => {
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      petNoteTyping();
      socket.send(JSON.stringify({ type: "input", data_b64: bytesToB64(data) }));
    };
    const disposable = term.onData(sendInput);
    enhancementsRef.current = attachTerminalEnhancements(term, host, notify, sendInput);
    const follow = attachScrollFollow(term, setAutoScroll);

    const sendResize = () => {
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    };
    const observer = new ResizeObserver(() => {
      if (host.clientWidth > 0 && host.clientHeight > 0) {
        fit.fit();
        sendResize();
      }
    });
    observer.observe(host);
    const onKey = (event: KeyboardEvent) => {
      if (!activeRef.current) return; // hidden keep-alive terminals never steal shortcuts
      if (isModalOpen()) return; // dialogs own Escape/shortcuts; never steal focus behind them
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setSearchOpen(true);
      } else if (event.key === "Escape") {
        setSearchOpen(false);
        term.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    const refreshTimer = window.setInterval(() => {
      setReceived((value) => {
        const next = term.buffer.active.length;
        return next === value ? value : next;
      });
    }, 500);

    return () => {
      window.clearInterval(refreshTimer);
      window.removeEventListener("keydown", onKey);
      observer.disconnect();
      follow.dispose();
      enhancementsRef.current?.dispose();
      enhancementsRef.current = null;
      disposable.dispose();
      term.dispose();
      termRef.current = null;
      searchRef.current = null;
    };
  }, [sessionId]);

  useEffect(() => {
    return subscribeTerminalSettings(() => {
      const term = termRef.current;
      if (term) applyTerminalSettings(term, getTerminalSettings());
    });
  }, []);

  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = terminalTheme(theme);
    }
  }, [theme]);

  // reclaim keyboard focus when this terminal becomes the visible tab again
  useEffect(() => {
    if (active) termRef.current?.focus();
  }, [active]);

  useEffect(() => {
    return () => {
      if (agentTimerRef.current) window.clearTimeout(agentTimerRef.current);
    };
  }, []);

  useEffect(() => {
    cursorRef.current = null;
    setDropped(0);
    setReceived(0);
    let closed = false;
    let retry: number | undefined;
    const connect = () => {
      const cursor = cursorRef.current;
      const url =
        cursor == null
          ? sshConsoleUrl(sessionId, 65536)
          : `${sshConsoleUrl(sessionId, 0).split("?")[0]}?cursor=${cursor}`;
      const socket = new WebSocket(url);
      socketRef.current = socket;
      socket.onopen = () => {
        if (closed) return;
        setConnected(true);
        petNoteLink(true);
        setLastError(null);
        const term = termRef.current;
        if (term) socket.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      };
      socket.onclose = () => {
        if (closed) return;
        setConnected(false);
        petNoteLink(false);
        retry = window.setTimeout(connect, 1500);
      };
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as {
            type: string;
            data_b64?: string;
            offset?: number;
            dropped?: number;
            status?: SshSessionStatus;
            action?: string;
            source?: string;
            at?: string;
            command?: string | null;
            output?: string | null;
            output_truncated?: boolean;
            exit_code?: number | null;
            elapsed_ms?: number | null;
            error?: { message?: string };
          };
          if (message.type === "status" && message.status) {
            setStatus(message.status);
            setLastError(message.status.last_error);
            return;
          }
          if (message.type === "agent" && message.action && message.source === "agent") {
            if (message.action === "command" && message.exit_code !== null && message.exit_code !== undefined) {
              petNoteCommandExit(message.exit_code);
            }
            setAgentPulse({
              action: message.action,
              source: message.source ?? "agent",
              at: message.at ?? new Date().toISOString(),
              command: message.command,
              output: message.output,
              output_truncated: message.output_truncated,
              exit_code: message.exit_code,
              elapsed_ms: message.elapsed_ms,
            });
            if (agentTimerRef.current) window.clearTimeout(agentTimerRef.current);
            agentTimerRef.current = window.setTimeout(() => setAgentPulse(null), 5000);
            return;
          }
          if (message.type === "overflow") {
            setDropped((value) => value + (message.dropped ?? 0));
            // the frames were dropped server-side but still live in the ring;
            // reconnecting with the cursor replays the missing bytes
            if (shouldResyncRef.current()) socketRef.current?.close();
            return;
          }
          if (message.type === "error") {
            setLastError(message.error?.message ?? "SSH terminal error");
            return;
          }
          if ((message.type === "rx" || message.type === "replay") && message.data_b64) {
            const bytes = b64ToBytes(message.data_b64);
            const term = termRef.current;
            if (!term) return;
            term.write(bytes);
            if (message.type === "rx") petNoteOutput(bytes.length);
            if (autoScrollRef.current) term.scrollToBottom();
            cursorRef.current =
              typeof message.offset === "number"
                ? message.offset + bytes.length
                : (cursorRef.current ?? 0) + bytes.length;
          }
        } catch {
          /* ignore malformed frames */
        }
      };
    };
    connect();
    return () => {
      closed = true;
      if (retry) window.clearTimeout(retry);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [sessionId, generation]);

  const disconnectSession = async () => {
    if (!window.confirm(`Disconnect ${status?.name ?? sessionId}? The remote shell, SFTP and the SSH transport are closed.`)) return;
    try {
      await api.sshDisconnect(sessionId);
      notify("SSH session disconnected, remote resources released", "success");
      onBack();
    } catch (error) {
      notify(`${(error as { code?: string }).code ?? "ERROR"}: ${(error as Error).message}`, "error");
    }
  };

  const toggleAgent = async () => {
    setAgentBusy(true);
    try {
      const enabled = !(status?.agent_visible ?? false);
      await api.sshSetAgentVisible(sessionId, enabled);
      await refreshStatus();
      notify(
        enabled ? "SSH session is now visible to agents" : "SSH session hidden from agents",
        "success",
      );
    } catch (error) {
      notify(`${(error as { code?: string }).code ?? "ERROR"}: ${(error as Error).message}`, "error");
    } finally {
      setAgentBusy(false);
    }
  };

  const stateTone =
    status?.state === "open"
      ? "text-emerald-300"
      : status?.state === "reconnecting" || status?.state === "connecting"
        ? "text-amber-300"
        : status?.state === "error"
          ? "text-red-400"
          : "text-zinc-500";
  const tabs =
    openSessions.length > 0 ? openSessions : status ? [status] : [];

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-zinc-950">
      <header className="flex flex-wrap items-center gap-2 border-b border-zinc-800/80 bg-zinc-950/60 px-4 py-2">
        <Button size="sm" variant="ghost" onClick={onBack} title="back to SSH connections">
          <ArrowLeft className="h-3.5 w-3.5" /> Connections
        </Button>
        <span className="mx-1 h-4 w-px bg-zinc-800" />
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-semibold text-zinc-100">{status?.name ?? sessionId}</span>
          <span className={cn("text-[11px] font-medium", stateTone)}>{status?.state ?? "…"}</span>
          {status ? (
            <span className="truncate font-mono text-[11px] text-zinc-500">
              {status.username}@{status.host}:{status.port}
            </span>
          ) : null}
          {agentPulse ? (
            <span className="inline-flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-300">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-300" />
              agent {agentPulse.action}
            </span>
          ) : null}
        </div>
        <div className="ml-auto flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setSearchOpen((value) => !value)}
            title="search scrollback (Ctrl+Shift+F)"
            aria-label="Find"
          >
            <Search className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="ghost" onClick={() => termRef.current?.clear()} title="clear the view" aria-label="Clear">
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setGeneration((value) => value + 1)}
            title="reconnect the browser WebSocket from the current cursor"
            aria-label="Reconnect"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="sm"
            variant={status?.agent_visible ? "outline" : "ghost"}
            onClick={() => void toggleAgent()}
            disabled={agentBusy}
            title={
              status?.agent_visible
                ? "visible in MCP ssh_sessions; click to hide from agents"
                : "hidden from agents; click to allow MCP access"
            }
          >
            {agentBusy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : status?.agent_visible ? (
              <Eye className="h-3.5 w-3.5 text-emerald-300" />
            ) : (
              <EyeOff className="h-3.5 w-3.5" />
            )}
            {status?.agent_visible ? "Agent" : "Private"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void disconnectSession()}
            title="disconnect this session: closes the remote shell, SFTP and the SSH transport"
            aria-label="Disconnect"
          >
            <Power className="h-3.5 w-3.5 text-red-400" />
          </Button>
          <Button
            size="sm"
            variant={panel === "files" ? "outline" : "ghost"}
            onClick={() => setPanel((value) => (value === "files" ? null : "files"))}
            title="toggle the SFTP file panel"
            aria-label="Files"
          >
            <FolderOpen className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="ghost" asChild title="download raw bytes with timestamps">
            <a href={`/api/ssh/sessions/${encodeURIComponent(sessionId)}/export?format=txt`} download>
              <Download className="h-3.5 w-3.5" />
            </a>
          </Button>
          <Button
            size="sm"
            variant={keysOpen ? "outline" : "ghost"}
            onClick={() => setKeysOpen((value) => !value)}
            title="browser-reserved keys and alternatives"
            aria-label="Keys"
          >
            <Keyboard className="h-3.5 w-3.5" />
          </Button>
          <TerminalSettingsDialog notify={notify} />
        </div>
      </header>

      {showSessionTabs ? (
        <div className="flex items-center gap-1 overflow-x-auto border-b border-zinc-800/80 bg-zinc-950/70 px-2 py-1">
          {tabs.map((item) => (
            <button
              key={item.session_id}
              type="button"
              onClick={() => {
                if (item.session_id !== sessionId) onSelect(item.session_id);
              }}
              className={cn(
                "flex shrink-0 items-center gap-1.5 rounded-t border-b-2 px-2.5 py-1 text-[11px] transition-colors",
                item.session_id === sessionId
                  ? "border-emerald-400 bg-zinc-900 text-zinc-100"
                  : "border-transparent text-zinc-500 hover:bg-zinc-900/60 hover:text-zinc-200",
              )}
              title={`${item.username}@${item.host}:${item.port}`}
            >
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
              <span className="max-w-[12rem] truncate">{item.name}</span>
              {item.state === "reconnecting" ? <span className="text-amber-300">retry</span> : null}
            </button>
          ))}
          <button
            type="button"
            onClick={onBack}
            className="shrink-0 rounded px-2 py-1 text-[11px] text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200"
          >
            + connection
          </button>
        </div>
      ) : null}

      {searchOpen ? (
        <TerminalSearchBar
          searchRef={searchRef}
          onClose={() => {
            setSearchOpen(false);
            termRef.current?.focus();
          }}
        />
      ) : null}

      {keysOpen ? (
        <div className="absolute right-3 top-12 z-20 w-[27rem] rounded-md border border-zinc-700 bg-zinc-950/95 p-3 text-[11px] text-zinc-300 shadow-2xl">
          <p className="mb-2 font-semibold text-zinc-100">Browser keys vs this terminal</p>
          <p className="mb-2 text-zinc-400">
            Some keys are eaten by the browser. Where Settings ▸ Keyboard capture offers a fix, it is listed
            below; everything else needs a native terminal.
          </p>
          <table className="w-full">
            <tbody className="align-top">
              <tr>
                <td className="py-0.5 pr-2 font-mono text-amber-300">Ctrl+W</td>
                <td>closes the tab → <span className="font-mono">Alt+Backspace</span> deletes a word</td>
              </tr>
              <tr>
                <td className="py-0.5 pr-2 font-mono text-amber-300">Ctrl+N / Ctrl+P</td>
                <td>new window / print → use ↓ / ↑ for history</td>
              </tr>
              <tr>
                <td className="py-0.5 pr-2 font-mono text-amber-300">Ctrl+T</td>
                <td>new tab → transpose chars needs a native terminal</td>
              </tr>
              <tr>
                <td className="py-0.5 pr-2 font-mono text-amber-300">Ctrl+L</td>
                <td>address bar → type <span className="font-mono">clear</span></td>
              </tr>
              <tr>
                <td className="py-0.5 pr-2 font-mono text-amber-300">F5 / F11 / F12</td>
                <td>reload / fullscreen / devtools → add to capture keys in Settings if needed</td>
              </tr>
              <tr>
                <td className="py-0.5 pr-2 font-mono text-emerald-300">Ctrl+Shift+F</td>
                <td>search this scrollback (case / regex / whole word)</td>
              </tr>
              <tr>
                <td className="py-0.5 pr-2 font-mono text-emerald-300">Ctrl+V / Ctrl+Shift+V</td>
                <td>paste (Ctrl+Shift+C copies; also right-click — Settings ▸ Clipboard)</td>
              </tr>
              <tr>
                <td className="py-0.5 pr-2 font-mono text-emerald-300">Escape</td>
                <td>enable <span className="font-mono">Capture Escape</span> in Settings if vi loses it</td>
              </tr>
              <tr>
                <td className="py-0.5 pr-2 font-mono text-emerald-300">Ctrl+B</td>
                <td>enable <span className="font-mono">Capture Ctrl+B</span> for the tmux prefix</td>
              </tr>
              <tr>
                <td className="py-0.5 pr-2 font-mono text-emerald-300">Shift+Enter</td>
                <td>optionally sends ESC+CR (newline) for TUIs — Settings ▸ Keyboard capture</td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="flex items-center gap-2 border-b border-zinc-800/80 bg-zinc-900/30 px-4 py-1.5 text-[11px]">
        <span className={cn("font-medium", connected ? "text-emerald-300" : "text-amber-300")}>
          {connected ? "● live" : "○ browser link down"}
        </span>
        <span className="text-zinc-500">
          {status ? `${formatBytes(status.rx_bytes)} rx · ${formatBytes(status.tx_bytes)} tx` : "no status"}
        </span>
        {status?.agent_last_action ? (
          <span className="inline-flex items-center gap-1 text-amber-300">
            agent: {status.agent_last_action}
            {status.agent_last_action === "exec" && status.last_exec_exit_code != null
              ? ` exit ${status.last_exec_exit_code}`
              : ""}
            {status.last_exec_elapsed_ms != null ? ` · ${status.last_exec_elapsed_ms}ms` : ""}
          </span>
        ) : null}
        {dropped > 0 ? <span className="text-amber-300">{dropped} dropped</span> : null}
        <div className="ml-auto flex items-center gap-2 text-zinc-500">
          <button
            type="button"
            onClick={() => {
              termRef.current?.scrollToBottom();
              setAutoScroll(true);
            }}
            className={cn(autoScroll ? "text-emerald-300" : "text-zinc-500 hover:text-zinc-300")}
          >
            {autoScroll ? "auto-scroll" : "follow live ↓"}
          </button>
          <span>scrollback {received}</span>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <div ref={hostRef} className="h-full w-full px-2 py-1" />
          {!connected ? (
            <div className="pointer-events-none absolute right-3 top-2 rounded bg-amber-500/10 px-2 py-1 text-[11px] text-amber-300">
              reconnecting…
            </div>
          ) : null}
        </div>

        {panel ? (
        <aside className="hidden w-80 shrink-0 flex-col border-l border-zinc-800/80 bg-zinc-950/40 md:flex">
          <div className="flex items-center gap-1 border-b border-zinc-800/80 px-2 py-1.5">
            <Button
              size="sm"
              variant={panel === "files" ? "outline" : "ghost"}
              title="remote files (drag & drop to upload)"
              aria-label="Files panel"
              onClick={() => setPanel("files")}
            >
              <FolderOpen className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="sm"
              variant={panel === "details" ? "outline" : "ghost"}
              title="connection details"
              aria-label="Details panel"
              onClick={() => setPanel("details")}
            >
              <Info className="h-3.5 w-3.5" />
            </Button>
            <span className="ml-auto font-mono text-[10px] text-zinc-600">{panel}</span>
          </div>
          {panel === "files" ? (
            <div className="min-h-0 flex-1">
              <SshFilesPanel sessionId={sessionId} username={status?.username} notify={notify} />
            </div>
          ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
          <div className="rounded-lg border border-zinc-800/70 bg-zinc-950/40 px-3 py-2">
            <p className="font-mono text-[10px] uppercase tracking-widest text-zinc-500">host key</p>
            <p className="mt-1 break-all font-mono text-[10px] text-zinc-300">
              {status?.host_key_fingerprint ?? "—"}
            </p>
            <p className="mt-1 text-[10px] text-zinc-500">{status?.host_key_type ?? ""}</p>
          </div>
          <div className="rounded-lg border border-zinc-800/70 bg-zinc-950/40 px-3 py-2 text-[11px]">
            <p className="font-mono text-[10px] uppercase tracking-widest text-zinc-500">transport</p>
            <dl className="mt-1 space-y-1 text-zinc-400">
              <div className="flex justify-between gap-2">
                <dt>cipher</dt>
                <dd className="truncate font-mono text-zinc-300">{status?.cipher ?? "—"}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt>mac</dt>
                <dd className="truncate font-mono text-zinc-300">{status?.mac ?? "—"}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt>remote</dt>
                <dd className="truncate font-mono text-zinc-300">{status?.remote_version ?? "—"}</dd>
              </div>
            </dl>
          </div>
          <div className="rounded-lg border border-zinc-800/70 bg-zinc-950/40 px-3 py-2 text-[11px]">
            <p className="font-mono text-[10px] uppercase tracking-widest text-zinc-500">agent activity</p>
            <dl className="mt-1 space-y-1 text-zinc-400">
              <div className="flex justify-between gap-2">
                <dt>last writer</dt>
                <dd className="font-mono text-zinc-300">{status?.last_write_source ?? "—"}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt>last action</dt>
                <dd className={status?.agent_last_action ? "text-amber-300" : "text-zinc-300"}>
                  {status?.agent_last_action ?? "none"}
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt>agent writes</dt>
                <dd className="font-mono text-zinc-300">{status?.agent_action_count ?? 0}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt>last exec</dt>
                <dd className="font-mono text-zinc-300">
                  {status?.last_exec_exit_code == null
                    ? "—"
                    : `exit ${status.last_exec_exit_code} · ${status.last_exec_elapsed_ms ?? "?"}ms`}
                </dd>
              </div>
            </dl>
          </div>
          <div className="rounded-lg border border-zinc-800/70 bg-zinc-950/40 px-3 py-2 text-[11px]">
            <p className="font-mono text-[10px] uppercase tracking-widest text-zinc-500">buffer</p>
            <dl className="mt-1 space-y-1 text-zinc-400">
              <div className="flex justify-between gap-2">
                <dt>rx / tx</dt>
                <dd className="font-mono text-zinc-300">
                  {status ? `${formatBytes(status.rx_bytes)} / ${formatBytes(status.tx_bytes)}` : "—"}
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt>cursor</dt>
                <dd className="font-mono text-zinc-300">
                  {status ? `${status.rx_start}..${status.rx_head}` : "—"}
                </dd>
              </div>
            </dl>
          </div>
          <p className="px-1 text-[10px] text-zinc-500" title="The SSH session lives on the server; closing this tab does not disconnect it.">
            session lives on the server · resize follows the window
          </p>
          </div>
          )}
        </aside>
        ) : null}
      </div>

      <footer className="flex items-center gap-3 border-t border-zinc-800/80 px-4 py-1.5 text-[11px] text-zinc-500">
        <span className={connected ? "text-emerald-400" : "text-amber-400"}>
          {connected ? "● live" : "○ reconnecting"}
        </span>
        <span>SSH PTY · strict known_hosts · no local echo</span>
        {status?.state && status.state !== "open" ? (
          <span className="text-amber-300">session state: {status.state}</span>
        ) : null}
        {lastError ? <span className="ml-auto max-w-[50%] truncate text-red-400">{lastError}</span> : null}
      </footer>

    </div>
  );
}
