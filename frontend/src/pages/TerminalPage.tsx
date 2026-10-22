import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  Circle,
  Download,
  ExternalLink,
  Keyboard,
  PanelRight,
  RefreshCw,
  Search,
  SquareTerminal,
  Trash2,
  Zap,
} from "lucide-react";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

import { Badge, StateBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatusPanel } from "@/components/StatusPanel";
import { api } from "@/lib/api";
import { useTheme } from "@/lib/theme";
import { b64ToBytes, cn, formatBytes } from "@/lib/utils";
import type { SessionStatus } from "@/lib/types";

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

/**
 * Full-page interactive terminal for the serial console.
 *
 * Raw RX bytes are rendered by xterm.js; every keystroke is written straight to
 * the session.  There is no local echo -- the device echoes, exactly like a
 * hardware terminal.  Reconnects resume from the last received cursor instead
 * of replaying a tail, so history is not duplicated.
 */
export function TerminalPage({
  sessions,
  session,
  selectedId,
  onSelect,
  refresh,
  notify,
  showSessionPicker = true,
}: {
  sessions: SessionStatus[];
  session?: SessionStatus;
  selectedId?: string;
  onSelect: (id: string) => void;
  refresh: () => Promise<void>;
  notify: (message: string, tone?: "info" | "error" | "success") => void;
  showSessionPicker?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const sessionRef = useRef<SessionStatus | undefined>(session);
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());
  const cursorRef = useRef<number | null>(null);
  const sessionKeyRef = useRef<string | undefined>(undefined);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [connected, setConnected] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [lastError, setLastError] = useState<string | null>(null);
  const [dropped, setDropped] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [busyBreak, setBusyBreak] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [infoOpen, setInfoOpen] = useState(true);
  const [received, setReceived] = useState(0);
  const autoScrollRef = useRef(true);
  const bytesRef = useRef(0);
  autoScrollRef.current = autoScroll;
  const { theme } = useTheme();
  const themeRef = useRef(theme);
  themeRef.current = theme;

  sessionRef.current = session;
  const canType = Boolean(session && session.state === "open" && session.control_owner === "human");
  const ttydUrl = session?.terminal?.control_url ?? session?.terminal?.view_url ?? null;

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !session) return;

    if (sessionKeyRef.current !== session.session_id) {
      sessionKeyRef.current = session.session_id;
      cursorRef.current = null;
      bytesRef.current = 0;
      setReceived(0);
      setDropped(0);
      setQuery("");
    }

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

    const send = (data: string) => {
      const current = sessionRef.current;
      if (!current || current.state !== "open" || current.control_owner !== "human") {
        setLastError("agent owns control - take control to type");
        return;
      }
      queueRef.current = queueRef.current
        .then(() => api.write(current.session_id, { text: data }))
        .catch((error) => {
          const failure = error as { code?: string; message?: string };
          setLastError(`${failure.code ?? "ERROR"}: ${failure.message ?? "write failed"}`);
        });
    };
    const disposable = term.onData(send);

    let disposed = false;
    let retry: number | undefined;
    const connect = () => {
      const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
      const cursor = cursorRef.current;
      const query = cursor == null ? "?replay=65536" : `?cursor=${cursor}`;
      const url = `${scheme}//${window.location.host}/ws/console/${encodeURIComponent(session.session_id)}${query}`;
      const socket = new WebSocket(url);
      socketRef.current = socket;
      socket.onopen = () => {
        if (!disposed) {
          setConnected(true);
          setLastError(null);
          fit.fit();
          term.focus();
        }
      };
      socket.onclose = () => {
        if (disposed) return;
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
          };
          if (message.type === "overflow") {
            setDropped((value) => value + (message.dropped ?? 0));
            return;
          }
          if ((message.type === "rx" || message.type === "replay") && message.data_b64) {
            const bytes = b64ToBytes(message.data_b64);
            term.write(bytes);
            bytesRef.current += bytes.length;
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

    const observer = new ResizeObserver(() => {
      if (host.clientWidth > 0 && host.clientHeight > 0) fit.fit();
    });
    observer.observe(host);

    return () => {
      disposed = true;
      if (retry) window.clearTimeout(retry);
      observer.disconnect();
      socketRef.current?.close();
      disposable.dispose();
      term.dispose();
      termRef.current = null;
      searchRef.current = null;
    };
  }, [session?.session_id, generation]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setReceived((value) => (value === bytesRef.current ? value : bytesRef.current));
    }, 400);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = theme === "light" ? LIGHT_TERM_THEME : DARK_TERM_THEME;
    }
  }, [theme]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setSearchOpen(true);
        window.setTimeout(() => searchInputRef.current?.focus(), 0);
      } else if (event.key === "Escape" && searchOpen) {
        setSearchOpen(false);
        termRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [searchOpen]);

  const find = useCallback(
    (backwards: boolean) => {
      const addon = searchRef.current;
      if (!addon || !query) return;
      if (backwards) addon.findPrevious(query);
      else addon.findNext(query);
    },
    [query],
  );

  const sendBreak = async () => {
    if (!session) return;
    setBusyBreak(true);
    try {
      await api.sendBreak(session.session_id);
      notify("BREAK sent (250 ms)", "success");
    } catch (error) {
      const failure = error as { code?: string; message?: string };
      notify(`${failure.code ?? "ERROR"}: ${failure.message ?? String(error)}`, "error");
    } finally {
      setBusyBreak(false);
    }
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-zinc-950">
      <header className="flex flex-wrap items-center gap-2 border-b border-zinc-800/80 bg-zinc-950/60 px-4 py-2">
        <div className="mr-1 flex items-center gap-2">
          <SquareTerminal className="h-4 w-4 text-emerald-400" />
          <span className="text-sm font-semibold text-zinc-100">Terminal</span>
        </div>
        {showSessionPicker ? (
          <>
            <select
              value={selectedId ?? ""}
              onChange={(event) => onSelect(event.target.value)}
              className="h-8 rounded-md border border-zinc-700 bg-zinc-950/60 px-2 text-xs text-zinc-200 focus:border-emerald-500/60 focus:outline-none"
            >
              {sessions.length === 0 ? <option value="">no sessions</option> : null}
              {sessions.map((item) => (
                <option key={item.session_id} value={item.session_id}>
                  {item.name} · {item.port}
                </option>
              ))}
            </select>
            {session ? <StateBadge state={session.state} /> : null}
            {session ? (
              <span className="font-mono text-[11px] text-zinc-500">
                {session.config.baudrate} {session.config.bytesize}
                {session.config.parity[0].toUpperCase()}
                {session.config.stopbits} ·{" "}
                {session.control_owner === "agent" ? "agent owns control" : "operator control"}
              </span>
            ) : null}
          </>
        ) : null}

        <div className="ml-auto flex items-center gap-1">
          {session && session.control_owner === "agent" ? (
            <Button
              size="sm"
              variant="primary"
              onClick={async () => {
                try {
                  await api.setControl(session.session_id, "human");
                  await refresh();
                  notify("control returned to human", "success");
                  termRef.current?.focus();
                } catch (error) {
                  const failure = error as { code?: string; message?: string };
                  notify(`${failure.code ?? "ERROR"}: ${failure.message ?? String(error)}`, "error");
                }
              }}
            >
              Take control
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            onClick={sendBreak}
            disabled={!session || session.state !== "open" || busyBreak}
            title="send a serial BREAK (250 ms framing break, not a byte)"
          >
            <Zap className="h-3.5 w-3.5" /> BREAK
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setSearchOpen((value) => !value);
              window.setTimeout(() => searchInputRef.current?.focus(), 0);
            }}
            title="search the scrollback (Ctrl+Shift+F)"
          >
            <Search className="h-3.5 w-3.5" /> Find
          </Button>
          <Button size="sm" variant="ghost" onClick={() => termRef.current?.clear()} title="clear the screen">
            <Trash2 className="h-3.5 w-3.5" /> Clear
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setGeneration((value) => value + 1)}
            title="resume the stream from the last received cursor"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Reconnect
          </Button>
          {session ? (
            <Button size="sm" variant="ghost" asChild title="download raw bytes with timestamps">
              <a href={`/api/sessions/${encodeURIComponent(session.session_id)}/export?format=txt`} download>
                <Download className="h-3.5 w-3.5" /> Log
              </a>
            </Button>
          ) : null}
          <Button
            size="sm"
            variant={keysOpen ? "outline" : "ghost"}
            onClick={() => setKeysOpen((value) => !value)}
            title="browser-reserved keys and alternatives"
          >
            <Keyboard className="h-3.5 w-3.5" /> Keys
          </Button>
          <Button
            size="sm"
            variant={infoOpen ? "outline" : "ghost"}
            onClick={() => setInfoOpen((value) => !value)}
            title="show the session status panel"
          >
            <PanelRight className="h-3.5 w-3.5" /> Info
          </Button>
          {ttydUrl ? (
            <Button size="sm" variant="ghost" asChild title="open the full ttyd terminal in its own browser tab">
              <a href={ttydUrl} target="_blank" rel="noreferrer">
                <ExternalLink className="h-3.5 w-3.5" /> Full
              </a>
            </Button>
          ) : null}
        </div>
      </header>

      {searchOpen ? (
        <div className="flex items-center gap-2 border-b border-zinc-800/80 bg-zinc-900/40 px-4 py-1.5">
          <Search className="h-3.5 w-3.5 text-zinc-500" />
          <input
            ref={searchInputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              if (event.target.value) searchRef.current?.findNext(event.target.value, { incremental: true });
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                find(event.shiftKey);
              } else if (event.key === "Escape") {
                setSearchOpen(false);
                termRef.current?.focus();
              }
            }}
            placeholder="search scrollback"
            className="h-7 w-64 rounded border border-zinc-700 bg-zinc-950 px-2 text-xs text-zinc-200 focus:border-emerald-500/60 focus:outline-none"
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
          <span className="text-[11px] text-zinc-500">Enter next · Shift+Enter previous</span>
        </div>
      ) : null}

      {keysOpen ? (
        <div className="absolute right-3 top-12 z-20 w-[27rem] rounded-md border border-zinc-700 bg-zinc-950/95 p-3 text-[11px] text-zinc-300 shadow-2xl">
          <p className="mb-2 font-semibold text-zinc-100">Browser-reserved keys</p>
          <p className="mb-2 text-zinc-400">
            These never reach the device in any browser terminal (ttyd included). Use the alternative or the
            full terminal.
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
                <td>new tab → transpose chars needs the full terminal</td>
              </tr>
              <tr>
                <td className="py-0.5 pr-2 font-mono text-amber-300">Ctrl+L</td>
                <td>address bar → type <span className="font-mono">clear</span></td>
              </tr>
              <tr>
                <td className="py-0.5 pr-2 font-mono text-amber-300">F5 / F11 / F12</td>
                <td>reload / fullscreen / devtools → full terminal still browser-bound</td>
              </tr>
              <tr>
                <td className="py-0.5 pr-2 font-mono text-emerald-300">Ctrl+Shift+F</td>
                <td>search this scrollback</td>
              </tr>
              <tr>
                <td className="py-0.5 pr-2 font-mono text-emerald-300">Ctrl+Shift+C / V</td>
                <td>copy / paste through the browser clipboard</td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="flex items-center gap-2 border-b border-zinc-800/80 bg-zinc-900/30 px-4 py-1.5">
        <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-widest text-zinc-400">
          <Circle
            className={cn(
              "h-2 w-2",
              connected ? "fill-emerald-400 text-emerald-400" : "fill-zinc-600 text-zinc-600",
            )}
          />
          live rx
        </span>
        <Badge>{formatBytes(received)}</Badge>
        {dropped > 0 ? <Badge tone="warn">{dropped} dropped</Badge> : null}
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => setAutoScroll((value) => !value)}
            className={cn(
              "inline-flex items-center gap-1 rounded px-1.5 py-1 text-[10px]",
              autoScroll ? "text-emerald-300" : "text-zinc-500 hover:text-zinc-300",
            )}
            title="toggle auto-scroll"
          >
            <ArrowDownToLine className="h-3 w-3" /> auto
          </button>
          <button
            type="button"
            onClick={() => termRef.current?.clear()}
            className="rounded px-1.5 py-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
            title="clear view (does not clear the buffer)"
          >
            <Trash2 className="h-3 w-3" />
          </button>
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

        {infoOpen && session ? (
          <aside className="hidden w-72 shrink-0 flex-col gap-2 overflow-y-auto border-l border-zinc-800/80 bg-zinc-950/40 p-3 md:flex">
            <StatusPanel session={session} />
            <div className="rounded-lg border border-zinc-800/70 bg-zinc-950/40 px-3 py-2 text-[11px] text-zinc-500">
              <p className="font-mono text-[10px] uppercase tracking-widest text-zinc-500">session</p>
              <p className="mt-1 text-zinc-300">{session.name}</p>
              <p className="mt-0.5 font-mono text-[10px] text-zinc-500">
                {session.session_id} · {session.config.baudrate} {session.config.bytesize}
                {session.config.parity[0].toUpperCase()}
                {session.config.stopbits} · {session.config.flow}
              </p>
              <p className="mt-2 text-[10px] text-zinc-500">
                Status refreshes with the session poll (3 s). DTR/RTS/CTS/DSR/CD/RI live in the card above.
              </p>
            </div>
          </aside>
        ) : null}
      </div>

      <footer className="flex items-center gap-3 border-t border-zinc-800/80 px-4 py-1.5 text-[11px] text-zinc-500">
        <span className={connected ? "text-emerald-400" : "text-amber-400"}>
          {connected ? "● live" : "○ disconnected"}
        </span>
        <span>raw serial · no local echo · keys go straight to the device</span>
        {!canType && session ? <span className="text-amber-300">input disabled: agent owns control</span> : null}
        {dropped > 0 ? <span className="text-red-400">dropped {dropped} bytes (slow reader)</span> : null}
        {lastError ? <span className="ml-auto text-red-400">{lastError}</span> : null}
      </footer>
    </div>
  );
}
