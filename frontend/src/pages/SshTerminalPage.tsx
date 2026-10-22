import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Loader2, RefreshCw, Search, Square, Trash2 } from "lucide-react";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, sshConsoleUrl } from "@/lib/api";
import { useTheme } from "@/lib/theme";
import { b64ToBytes, bytesToB64, cn, formatBytes, formatTime } from "@/lib/utils";
import type { SshSessionStatus } from "@/lib/types";

const DARK_TERM_THEME: ITheme = {
  background: "#09090b",
  foreground: "#e4e4e7",
  cursor: "#34d399",
  selectionBackground: "#3f3f46",
  black: "#18181b",
  red: "#f87171",
  green: "#4ade80",
  yellow: "#facc15",
  blue: "#60a5fa",
  magenta: "#c084fc",
  cyan: "#22d3ee",
  white: "#f4f4f5",
};

const LIGHT_TERM_THEME: ITheme = {
  background: "#ffffff",
  foreground: "#18181b",
  cursor: "#047857",
  cursorAccent: "#ffffff",
  selectionBackground: "#bfdbfe",
  black: "#18181b",
  red: "#b91c1c",
  green: "#15803d",
  yellow: "#a16207",
  blue: "#1d4ed8",
  magenta: "#7e22ce",
  cyan: "#0e7490",
  white: "#e4e4e7",
  brightBlack: "#52525b",
  brightRed: "#dc2626",
  brightGreen: "#16a34a",
  brightYellow: "#ca8a04",
  brightBlue: "#2563eb",
  brightMagenta: "#9333ea",
  brightCyan: "#0891b2",
  brightWhite: "#18181b",
};

export function SshTerminalPage({
  sessionId,
  onBack,
  notify,
}: {
  sessionId: string;
  onBack: () => void;
  notify: (message: string, tone?: "info" | "error" | "success") => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const cursorRef = useRef<number | null>(null);
  const autoScrollRef = useRef(true);
  const [status, setStatus] = useState<SshSessionStatus | null>(null);
  const [connected, setConnected] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [dropped, setDropped] = useState(0);
  const [received, setReceived] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [generation, setGeneration] = useState(0);
  const [busy, setBusy] = useState(false);
  const { theme } = useTheme();
  const themeRef = useRef(theme);
  themeRef.current = theme;
  autoScrollRef.current = autoScroll;

  const refreshStatus = useCallback(async () => {
    try {
      const next = await api.sshSession(sessionId);
      setStatus(next);
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
    const term = new Terminal({
      cursorBlink: true,
      convertEol: false,
      fontFamily: '"JetBrains Mono", "Cascadia Mono", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 5000,
      theme: themeRef.current === "light" ? LIGHT_TERM_THEME : DARK_TERM_THEME,
    });
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
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setSearchOpen(true);
        window.setTimeout(() => searchInputRef.current?.focus(), 0);
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
      disposable.dispose();
      term.dispose();
      termRef.current = null;
      searchRef.current = null;
    };
  }, [sessionId]);

  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = theme === "light" ? LIGHT_TERM_THEME : DARK_TERM_THEME;
    }
  }, [theme]);

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
            error?: { message?: string };
          };
          if (message.type === "status" && message.status) {
            setStatus(message.status);
            setLastError(message.status.last_error);
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

  const find = (backwards: boolean) => {
    if (!query) return;
    if (backwards) searchRef.current?.findPrevious(query);
    else searchRef.current?.findNext(query, { incremental: true });
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await api.sshDisconnect(sessionId);
      notify("SSH session disconnected", "success");
      onBack();
    } catch (error) {
      notify(`${(error as { code?: string }).code ?? "ERROR"}: ${(error as Error).message}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const stateTone =
    status?.state === "open"
      ? "text-emerald-300"
      : status?.state === "connecting"
        ? "text-amber-300"
        : status?.state === "error"
          ? "text-red-400"
          : "text-zinc-500";

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
        </div>
        <div className="ml-auto flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setSearchOpen((value) => !value);
              window.setTimeout(() => searchInputRef.current?.focus(), 0);
            }}
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
          <Button size="sm" variant="danger" onClick={() => void disconnect()} disabled={busy}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" />}
            Disconnect
          </Button>
        </div>
      </header>

      {searchOpen ? (
        <div className="flex items-center gap-2 border-b border-zinc-800/80 bg-zinc-900/40 px-4 py-1.5">
          <Search className="h-3.5 w-3.5 text-zinc-500" />
          <Input
            ref={searchInputRef}
            value={query}
            autoFocus
            onChange={(event) => {
              setQuery(event.target.value);
              if (event.target.value) searchRef.current?.findNext(event.target.value, { incremental: true });
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") find(event.shiftKey);
              if (event.key === "Escape") {
                setSearchOpen(false);
                termRef.current?.focus();
              }
            }}
            placeholder="search scrollback"
            className="h-7 w-64 text-xs"
          />
          <Button size="sm" variant="ghost" onClick={() => find(false)} disabled={!query}>
            Next
          </Button>
          <Button size="sm" variant="ghost" onClick={() => find(true)} disabled={!query}>
            Prev
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSearchOpen(false)}>
            Close
          </Button>
        </div>
      ) : null}

      <div className="flex items-center gap-2 border-b border-zinc-800/80 bg-zinc-900/30 px-4 py-1.5 text-[11px]">
        <span className={cn("font-medium", connected ? "text-emerald-300" : "text-amber-300")}>
          {connected ? "● live" : "○ browser link down"}
        </span>
        <span className="text-zinc-500">
          {status ? `${formatBytes(status.rx_bytes)} rx · ${formatBytes(status.tx_bytes)} tx` : "no status"}
        </span>
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
    </div>
  );
}
