import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronUp,
  Download,
  Eye,
  EyeOff,
  File as FileIcon,
  FolderOpen,
  FolderPlus,
  Keyboard,
  Loader2,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  Upload,
} from "lucide-react";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { TerminalSearchBar } from "@/components/TerminalSearchBar";
import { TerminalSettingsDialog } from "@/components/TerminalSettingsDialog";
import { api, sshConsoleUrl } from "@/lib/api";
import { useTheme } from "@/lib/theme";
import { terminalTheme } from "@/lib/termTheme";
import {
  applyTerminalSettings,
  attachTerminalEnhancements,
  terminalOptions,
  type Enhancements,
} from "@/lib/terminal-setup";
import { getTerminalSettings, subscribeTerminalSettings } from "@/lib/terminal-settings";
import { b64ToBytes, bytesToB64, cn, formatBytes, formatTime, isModalOpen } from "@/lib/utils";
import type { SshFileList, SshSessionStatus } from "@/lib/types";

export function SshTerminalPage({
  sessionId,
  onBack,
  onSelect,
  notify,
  showSessionTabs = true,
}: {
  sessionId: string;
  onBack: () => void;
  onSelect: (sessionId: string) => void;
  notify: (message: string, tone?: "info" | "error" | "success") => void;
  showSessionTabs?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const enhancementsRef = useRef<Enhancements | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const cursorRef = useRef<number | null>(null);
  const autoScrollRef = useRef(true);
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
  const [filesOpen, setFilesOpen] = useState(false);
  const [filesPath, setFilesPath] = useState("");
  const [filesDraft, setFilesDraft] = useState("");
  const [files, setFiles] = useState<SshFileList | null>(null);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
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
  const fileInputRef = useRef<HTMLInputElement | null>(null);
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

  const joinPath = (base: string, name: string) => (base === "/" ? `/${name}` : `${base.replace(/\/+$/, "")}/${name}`);
  const parentPath = (path: string) => {
    const trimmed = path.replace(/\/+$/, "");
    if (!trimmed || trimmed === "/") return "/";
    const parts = trimmed.split("/");
    parts.pop();
    return parts.join("/") || "/";
  };

  const loadFiles = useCallback(
    async (path: string) => {
      setFilesLoading(true);
      setFilesError(null);
      try {
        const result = await api.sshSftpList(sessionId, path);
        setFiles(result);
        setFilesPath(result.path);
        setFilesDraft(result.path);
      } catch (error) {
        setFilesError(`${(error as { code?: string }).code ?? "ERROR"}: ${(error as Error).message}`);
      } finally {
        setFilesLoading(false);
      }
    },
    [sessionId],
  );

  useEffect(() => {
    if (filesOpen && filesPath) void loadFiles(filesPath);
  }, [filesOpen, filesPath, loadFiles]);

  const openFiles = () => {
    const initial =
      status?.username === "root" ? "/root" : `/home/${status?.username || "root"}`;
    setFilesPath(initial);
    setFilesDraft(initial);
    setFiles(null);
    setFilesOpen(true);
  };

  const uploadFile = async (file: File) => {
    if (!filesPath) return;
    setUploading(true);
    setFilesError(null);
    try {
      await api.sshSftpUpload(sessionId, joinPath(filesPath, file.name), file);
      notify(`uploaded ${file.name}`, "success");
      await loadFiles(filesPath);
    } catch (error) {
      setFilesError(`${(error as { code?: string }).code ?? "ERROR"}: ${(error as Error).message}`);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const mkdir = async () => {
    const name = window.prompt("New directory name");
    if (!name) return;
    try {
      await api.sshSftpMkdir(sessionId, joinPath(filesPath, name));
      await loadFiles(filesPath);
    } catch (error) {
      setFilesError(`${(error as { code?: string }).code ?? "ERROR"}: ${(error as Error).message}`);
    }
  };

  const removeEntry = async (path: string, name: string) => {
    if (!window.confirm(`Delete ${name}? This cannot be undone.`)) return;
    try {
      await api.sshSftpDelete(sessionId, path);
      await loadFiles(filesPath);
    } catch (error) {
      setFilesError(`${(error as { code?: string }).code ?? "ERROR"}: ${(error as Error).message}`);
    }
  };

  const renameEntry = async (path: string, name: string) => {
    const next = window.prompt("New name", name);
    if (!next || next === name) return;
    try {
      await api.sshSftpRename(sessionId, path, joinPath(parentPath(path), next));
      await loadFiles(filesPath);
    } catch (error) {
      setFilesError(`${(error as { code?: string }).code ?? "ERROR"}: ${(error as Error).message}`);
    }
  };

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
      socket.send(JSON.stringify({ type: "input", data_b64: bytesToB64(data) }));
    };
    const disposable = term.onData(sendInput);
    enhancementsRef.current = attachTerminalEnhancements(term, host, notify, sendInput);

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
        setLastError(null);
        const term = termRef.current;
        if (term) socket.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      };
      socket.onclose = () => {
        if (closed) return;
        setConnected(false);
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
          >
            <Search className="h-3.5 w-3.5" /> Find
          </Button>
          <Button size="sm" variant="ghost" onClick={() => termRef.current?.clear()} title="clear the view">
            <Trash2 className="h-3.5 w-3.5" /> Clear
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setGeneration((value) => value + 1)}
            title="reconnect the browser WebSocket from the current cursor"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Reconnect
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
          <Button size="sm" variant="ghost" onClick={openFiles} title="browse, upload and download files over SFTP">
            <FolderOpen className="h-3.5 w-3.5" /> Files
          </Button>
          <Button size="sm" variant="ghost" asChild title="download raw bytes with timestamps">
            <a href={`/api/ssh/sessions/${encodeURIComponent(sessionId)}/export?format=txt`} download>
              <Download className="h-3.5 w-3.5" /> Log
            </a>
          </Button>
          <Button
            size="sm"
            variant={keysOpen ? "outline" : "ghost"}
            onClick={() => setKeysOpen((value) => !value)}
            title="browser-reserved keys and alternatives"
          >
            <Keyboard className="h-3.5 w-3.5" /> Keys
          </Button>
          <TerminalSettingsDialog />
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
                <td className="py-0.5 pr-2 font-mono text-emerald-300">Ctrl+Shift+C / V</td>
                <td>copy / paste via the browser clipboard (toggle in Settings ▸ Clipboard)</td>
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
            onClick={() => setAutoScroll((value) => !value)}
            className={cn(autoScroll ? "text-emerald-300" : "text-zinc-500 hover:text-zinc-300")}
          >
            auto-scroll
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

        <aside className="hidden w-80 shrink-0 flex-col gap-2 overflow-y-auto border-l border-zinc-800/80 bg-zinc-950/40 p-3 md:flex">
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
              <div className="flex justify-between gap-2">
                <dt>opened</dt>
                <dd className="text-zinc-300">{formatTime(status?.opened_at)}</dd>
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
              <div className="flex justify-between gap-2">
                <dt>capacity</dt>
                <dd className="font-mono text-zinc-300">{status ? formatBytes(status.buffer_bytes) : "—"}</dd>
              </div>
            </dl>
          </div>
          <p className="px-1 text-[10px] text-zinc-500">
            The SSH session lives on the server. Closing this tab does not disconnect it; reattach from SSH
            connections. Resize is sent to the remote PTY.
          </p>
        </aside>
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

      <Dialog open={filesOpen} onOpenChange={setFilesOpen}>
        <DialogContent
          className="w-[min(820px,94vw)]"
          title="SFTP files"
          description="Directory browsing, upload and download over the same SSH transport."
        >
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                const parent = parentPath(filesPath);
                setFilesDraft(parent);
                void loadFiles(parent);
              }}
            >
              <ChevronUp className="h-3.5 w-3.5" /> Up
            </Button>
            <Input
              value={filesDraft}
              onChange={(event) => setFilesDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void loadFiles(filesDraft);
              }}
              className="h-8 min-w-0 flex-1 font-mono text-xs"
            />
            <Button size="sm" variant="ghost" onClick={() => void loadFiles(filesDraft)}>
              <RefreshCw className="h-3.5 w-3.5" /> Go
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void mkdir()}>
              <FolderPlus className="h-3.5 w-3.5" /> New folder
            </Button>
            <Button size="sm" variant="secondary" disabled={uploading} onClick={() => fileInputRef.current?.click()}>
              {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
              Upload
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void uploadFile(file);
              }}
            />
          </div>
          {filesError ? <p className="mt-2 text-xs text-red-400">{filesError}</p> : null}
          <div className="mt-3 max-h-[55vh] overflow-y-auto rounded-lg border border-zinc-800">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-zinc-900 text-[10px] uppercase tracking-widest text-zinc-500">
                <tr>
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Size</th>
                  <th className="px-3 py-2">Mode</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/70">
                {filesLoading ? (
                  <tr>
                    <td colSpan={4} className="px-3 py-6 text-center text-zinc-500">
                      <Loader2 className="mx-auto h-4 w-4 animate-spin" />
                    </td>
                  </tr>
                ) : null}
                {!filesLoading && files && files.entries.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-3 py-6 text-center text-zinc-500">
                      empty directory
                    </td>
                  </tr>
                ) : null}
                {!filesLoading
                  ? files?.entries.map((entry) => (
                      <tr key={entry.path} className="text-zinc-300 hover:bg-zinc-900/50">
                        <td className="px-3 py-1.5">
                          <button
                            type="button"
                            className="flex max-w-[24rem] items-center gap-2 truncate text-left"
                            onClick={() => {
                              if (entry.is_dir) {
                                setFilesDraft(entry.path);
                                void loadFiles(entry.path);
                              }
                            }}
                          >
                            {entry.is_dir ? (
                              <FolderOpen className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                            ) : (
                              <FileIcon className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                            )}
                            <span className={entry.is_dir ? "truncate text-zinc-100" : "truncate"}>{entry.name}</span>
                            {entry.is_link ? <span className="text-[10px] text-amber-300">link</span> : null}
                          </button>
                        </td>
                        <td className="px-3 py-1.5 font-mono text-[10px] text-zinc-500">
                          {entry.is_dir ? "—" : formatBytes(entry.size)}
                        </td>
                        <td className="px-3 py-1.5 font-mono text-[10px] text-zinc-500">{entry.mode}</td>
                        <td className="px-3 py-1.5">
                          <div className="flex justify-end gap-1">
                            {!entry.is_dir ? (
                              <Button size="sm" variant="ghost" asChild title="download">
                                <a
                                  href={`/api/ssh/sessions/${encodeURIComponent(sessionId)}/sftp/download?path=${encodeURIComponent(entry.path)}`}
                                  download
                                >
                                  <Download className="h-3 w-3" />
                                </a>
                              </Button>
                            ) : null}
                            <Button
                              size="sm"
                              variant="ghost"
                              title="rename"
                              onClick={() => void renameEntry(entry.path, entry.name)}
                            >
                              <Pencil className="h-3 w-3" />
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              title="delete"
                              onClick={() => void removeEntry(entry.path, entry.name)}
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))
                  : null}
              </tbody>
            </table>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
