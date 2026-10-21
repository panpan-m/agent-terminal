import { useEffect, useRef, useState } from "react";
import { ExternalLink, RefreshCw, SquareTerminal, Trash2 } from "lucide-react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

import { StateBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api, consoleUrl } from "@/lib/api";
import { b64ToBytes } from "@/lib/utils";
import type { SessionStatus } from "@/lib/types";

/**
 * Full-page interactive terminal for the serial console.
 *
 * Raw RX bytes are rendered by xterm.js; every keystroke is written straight to
 * the session.  There is no local echo -- the device echoes, exactly like a
 * hardware terminal.  ttyd stays available as a separate "new tab" entry for
 * full PTY features (resize, scrollback search), but it is not on this path.
 */
export function TerminalPage({
  sessions,
  session,
  selectedId,
  onSelect,
  refresh,
  notify,
}: {
  sessions: SessionStatus[];
  session?: SessionStatus;
  selectedId?: string;
  onSelect: (id: string) => void;
  refresh: () => Promise<void>;
  notify: (message: string, tone?: "info" | "error" | "success") => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const sessionRef = useRef<SessionStatus | undefined>(session);
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());
  const [connected, setConnected] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [lastError, setLastError] = useState<string | null>(null);

  sessionRef.current = session;
  const canType = Boolean(session && session.state === "open" && session.control_owner === "human");
  const ttydUrl = session?.terminal?.control_url ?? session?.terminal?.view_url ?? null;

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !session) return;

    const term = new Terminal({
      cursorBlink: true,
      convertEol: false,
      fontFamily: '"JetBrains Mono", "Cascadia Mono", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 5000,
      theme: {
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
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    term.focus();
    termRef.current = term;

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
      const url = consoleUrl(session.session_id, 65536);
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
          const message = JSON.parse(event.data) as { type: string; data_b64?: string };
          if ((message.type === "rx" || message.type === "replay") && message.data_b64) {
            term.write(b64ToBytes(message.data_b64));
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
    };
  }, [session?.session_id, generation]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-zinc-950">
      <header className="flex flex-wrap items-center gap-3 border-b border-zinc-800/80 bg-zinc-950/60 px-4 py-2">
        <div className="mr-1 flex items-center gap-2">
          <SquareTerminal className="h-4 w-4 text-emerald-400" />
          <span className="text-sm font-semibold text-zinc-100">Terminal</span>
        </div>
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

        <div className="ml-auto flex items-center gap-1.5">
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
          <Button size="sm" variant="ghost" onClick={() => termRef.current?.clear()} title="clear the screen">
            <Trash2 className="h-3.5 w-3.5" /> Clear
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setGeneration((value) => value + 1)}
            title="reconnect the terminal stream"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Reconnect
          </Button>
          {ttydUrl ? (
            <Button size="sm" variant="ghost" asChild title="open the full ttyd terminal in its own browser tab">
              <a href={ttydUrl} target="_blank" rel="noreferrer">
                <ExternalLink className="h-3.5 w-3.5" /> Full terminal
              </a>
            </Button>
          ) : null}
        </div>
      </header>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div ref={hostRef} className="h-full w-full px-2 py-1" />
        {!connected ? (
          <div className="pointer-events-none absolute right-3 top-2 rounded bg-amber-500/10 px-2 py-1 text-[11px] text-amber-300">
            reconnecting…
          </div>
        ) : null}
      </div>

      <footer className="flex items-center gap-3 border-t border-zinc-800/80 px-4 py-1.5 text-[11px] text-zinc-500">
        <span className={connected ? "text-emerald-400" : "text-amber-400"}>
          {connected ? "● live" : "○ disconnected"}
        </span>
        <span>raw serial · no local echo · keys go straight to the device</span>
        {!canType && session ? <span className="text-amber-300">input disabled: agent owns control</span> : null}
        {lastError ? <span className="ml-auto text-red-400">{lastError}</span> : null}
      </footer>
    </div>
  );
}
