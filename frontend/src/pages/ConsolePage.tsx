import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownToLine, Circle, Power, RotateCcw, SlidersHorizontal, Trash2 } from "lucide-react";

import { SessionThread } from "@/components/assistant-ui/thread";
import { Badge, StateBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api, consoleUrl } from "@/lib/api";
import type { SessionStatus } from "@/lib/types";
import { b64ToBytes, cn, decodeBytes, formatBytes, formatNumber } from "@/lib/utils";

const MAX_RX_CHARS = 200_000;

function useRxStream(sessionId: string | undefined) {
  const [text, setText] = useState("");
  const [connected, setConnected] = useState(false);
  const [dropped, setDropped] = useState(0);
  const [autoScroll, setAutoScroll] = useState(true);
  const viewportRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    let disposed = false;
    let retryTimer: number | undefined;
    let socket: WebSocket | null = null;

    const connect = () => {
      const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = consoleUrl(sessionId, 65536) || `${scheme}//${window.location.host}/ws/console/${sessionId}`;
      socket = new WebSocket(url);
      socket.onopen = () => {
        if (!disposed) setConnected(true);
      };
      socket.onclose = () => {
        if (disposed) return;
        setConnected(false);
        retryTimer = window.setTimeout(connect, 1500);
      };
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as {
            type: string;
            data_b64?: string;
            dropped?: number;
          };
          if ((message.type === "rx" || message.type === "replay") && message.data_b64) {
            const chunk = decodeBytes(b64ToBytes(message.data_b64));
            setText((previous) => {
              const next = previous + chunk;
              return next.length > MAX_RX_CHARS ? next.slice(-MAX_RX_CHARS) : next;
            });
          } else if (message.type === "overflow") {
            setDropped((value) => value + (message.dropped ?? 0));
          }
        } catch {
          /* ignore malformed frames */
        }
      };
    };

    connect();
    return () => {
      disposed = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      socket?.close();
    };
  }, [sessionId]);

  useEffect(() => {
    if (!autoScroll) return;
    const node = viewportRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [text, autoScroll]);

  return {
    text,
    connected,
    dropped,
    autoScroll,
    setAutoScroll,
    viewportRef,
    clear: () => setText(""),
  };
}

export function ConsolePage({
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
  const rx = useRxStream(session?.session_id);
  const [busy, setBusy] = useState(false);
  const canWrite = Boolean(session && session.state === "open" && session.control_owner === "human");

  const run = useCallback(
    async (action: () => Promise<unknown>, success: string) => {
      setBusy(true);
      try {
        await action();
        await refresh();
        notify(success, "success");
      } catch (error) {
        const failure = error as { code?: string; message?: string };
        notify(`${failure.code ?? "ERROR"}: ${failure.message ?? String(error)}`, "error");
      } finally {
        setBusy(false);
      }
    },
    [notify, refresh],
  );

  const config = useMemo(() => {
    if (!session) return null;
    const c = session.config;
    return `${c.baudrate} ${c.bytesize}${c.parity[0].toUpperCase()}${c.stopbits} · ${c.flow} flow`;
  }, [session]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-zinc-800/80 px-5 py-3">
        <div className="mr-2">
          <h1 className="text-sm font-semibold text-zinc-100">Console</h1>
          <p className="text-[11px] text-zinc-500">{config ?? "select a session"}</p>
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

        <div className="ml-auto flex items-center gap-1.5">
          {session ? (
            <>
              <Button
                size="sm"
                variant={session.control_owner === "agent" ? "outline" : "primary"}
                disabled={busy || session.state !== "open"}
                onClick={() =>
                  run(
                    () => api.setControl(session.session_id, session.control_owner === "agent" ? "human" : "agent"),
                    session.control_owner === "agent" ? "control returned to human" : "control handed to agent",
                  )
                }
              >
                {session.control_owner === "agent" ? "Take control" : "Hand to agent"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  run(
                    () =>
                      session.state === "open"
                        ? api.closeSession(session.session_id)
                        : api.openSession(session.session_id),
                    session.state === "open" ? "session closed" : "session opened",
                  )
                }
              >
                <Power className="h-3.5 w-3.5" /> {session.state === "open" ? "Close" : "Open"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || session.state !== "open"}
                onClick={() => run(() => api.resetSession(session.session_id), "reset sequence applied")}
                title="DTR/RTS reset"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </Button>
              <a
                href={`#/config/${session.session_id}`}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                title="configuration"
              >
                <SlidersHorizontal className="h-4 w-4" />
              </a>
            </>
          ) : null}
        </div>
      </header>

      {!session ? (
        <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">
          No session configured — create one on the Sessions page.
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_400px]">
          <section className="flex min-h-0 flex-col border-r border-zinc-800/60">
            <SessionThread key={session.session_id + session.control_owner} session={session} canWrite={canWrite} />
          </section>

          <aside className="flex min-h-0 flex-col">
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex items-center gap-2 border-b border-zinc-800/60 px-4 py-2">
                <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-widest text-zinc-400">
                  <Circle className={cn("h-2 w-2", rx.connected ? "fill-emerald-400 text-emerald-400" : "fill-zinc-600 text-zinc-600")} />
                  live rx
                </span>
                <Badge>{formatBytes(session.rx_head)}</Badge>
                {rx.dropped > 0 ? <Badge tone="warn">{rx.dropped} dropped</Badge> : null}
                <div className="ml-auto flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => rx.setAutoScroll(!rx.autoScroll)}
                    className={cn(
                      "inline-flex items-center gap-1 rounded px-1.5 py-1 text-[10px]",
                      rx.autoScroll ? "text-emerald-300" : "text-zinc-500 hover:text-zinc-300",
                    )}
                    title="toggle auto-scroll"
                  >
                    <ArrowDownToLine className="h-3 w-3" /> auto
                  </button>
                  <button
                    type="button"
                    onClick={rx.clear}
                    className="rounded px-1.5 py-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
                    title="clear view (does not clear the buffer)"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              </div>
              <pre
                ref={rx.viewportRef}
                className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words bg-zinc-950/50 px-4 py-3 font-mono text-[11.5px] leading-relaxed text-zinc-300"
              >
                {rx.text || "waiting for device output…"}
              </pre>
            </div>

            <StatusPanel session={session} />
          </aside>
        </div>
      )}
    </div>
  );
}

function StatusPanel({ session }: { session: SessionStatus }) {
  const rows: [string, string][] = [
    ["port", session.port],
    ["state", session.state],
    ["control", session.control_owner],
    ["rx / tx", `${formatNumber(session.rx_bytes)} / ${formatNumber(session.tx_bytes)}`],
    ["buffer", `${formatBytes(session.buffer_bytes)} (${formatBytes(session.lost_bytes)} lost)`],
    ["reconnects", String(session.reconnect_count)],
    ["opened", session.opened_at ? new Date(session.opened_at).toLocaleTimeString() : "—"],
    ["last error", session.last_error ?? "none"],
  ];
  const lineKeys: ("dtr" | "rts" | "cts" | "dsr" | "cd" | "ri")[] = ["dtr", "rts", "cts", "dsr", "cd", "ri"];

  return (
    <Card className="m-3 mt-0 rounded-lg">
      <CardHeader className="px-4 py-2.5">
        <CardTitle className="text-[11px] uppercase tracking-widest text-zinc-400">status</CardTitle>
      </CardHeader>
      <CardContent className="px-4 py-3">
        <dl className="grid grid-cols-1 gap-1 text-[11px]">
          {rows.map(([key, value]) => (
            <div key={key} className="flex items-center justify-between gap-3">
              <dt className="text-zinc-500">{key}</dt>
              <dd className="truncate font-mono text-zinc-300">{value}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {lineKeys.map((key) => {
            const value = session.lines?.[key];
            return (
              <span
                key={key}
                className={cn(
                  "rounded border px-1.5 py-0.5 font-mono text-[10px]",
                  value
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                    : "border-zinc-700 bg-zinc-900 text-zinc-500",
                )}
              >
                {key.toUpperCase()} {value ? 1 : 0}
              </span>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
