import { useCallback, useEffect, useState } from "react";
import { Download, RefreshCw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";
import type { SessionStatus, SshSessionStatus, TranscriptEvent } from "@/lib/types";
import { b64ToBytes, decodeBytes, formatNumber } from "@/lib/utils";

type Tab = "transcript" | "audit";
type Selection = { kind: "serial" | "ssh"; id: string; name: string };

function preview(event: TranscriptEvent): string {
  if (event.data_b64) {
    try {
      const text = decodeBytes(b64ToBytes(event.data_b64));
      return text
        .replace(/\r/g, "␍")
        .replace(/\n/g, "␊")
        .replace(/[^\x20-\x7E␍␊°-￿]/g, "·")
        .slice(0, 160);
    } catch {
      return "…";
    }
  }
  const { ts: _ts, session: _session, ...rest } = event;
  return JSON.stringify(rest);
}

export function LogsPage({
  sessions,
  sshSessions,
  selectedId,
}: {
  sessions: SessionStatus[];
  sshSessions: SshSessionStatus[];
  selectedId?: string;
}) {
  const [tab, setTab] = useState<Tab>("transcript");
  const [events, setEvents] = useState<TranscriptEvent[]>([]);
  const [audit, setAudit] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Selection>(() => {
    const serial = sessions.find((session) => session.session_id === selectedId) ?? sessions[0];
    if (serial) return { kind: "serial", id: serial.session_id, name: serial.name };
    const ssh = sshSessions[0];
    if (ssh) return { kind: "ssh", id: ssh.session_id, name: ssh.name };
    return { kind: "serial", id: "", name: "" };
  });

  useEffect(() => {
    if (selected.kind === "serial") return;
    if (!sshSessions.some((session) => session.session_id === selected.id)) {
      const serial = sessions[0];
      const ssh = sshSessions[0];
      if (serial) setSelected({ kind: "serial", id: serial.session_id, name: serial.name });
      else if (ssh) setSelected({ kind: "ssh", id: ssh.session_id, name: ssh.name });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sshSessions, sessions]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (tab === "transcript" && selected.id) {
        const result =
          selected.kind === "serial"
            ? await api.transcript(selected.id, 300)
            : await api.sshTranscript(selected.id, 300);
        setEvents(result.events);
      } else if (tab === "audit") {
        const result = await api.audit(300);
        setAudit(result.events);
      }
    } catch {
      setEvents([]);
      setAudit([]);
    } finally {
      setLoading(false);
    }
  }, [tab, selected]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [load]);

  const download = () => {
    const payload = tab === "transcript" ? events : audit;
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(blob);
    anchor.download = `${tab}-${selected.id || "all"}.json`;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  };

  const rows = tab === "transcript" ? events : audit;

  return (
    <div className="mx-auto max-w-6xl px-5 py-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-zinc-100">Logs &amp; audit</h1>
          <p className="mt-1 text-xs text-zinc-500">One JSONL transcript per session · global audit log.</p>
        </div>
        <div className="flex items-center gap-2">
          {tab === "transcript" ? (
            <Select
              value={`${selected.kind}:${selected.id}`}
              onChange={(event) => {
                const [kind, id] = event.target.value.split(":");
                const name =
                  kind === "serial"
                    ? sessions.find((s) => s.session_id === id)?.name ?? id
                    : sshSessions.find((s) => s.session_id === id)?.name ?? id;
                setSelected({ kind, id, name } as Selection);
              }}
              className="h-8 w-auto px-2 text-xs"
            >
              <optgroup label="Serial">
                {sessions.map((item) => (
                  <option key={item.session_id} value={`serial:${item.session_id}`}>
                    {item.name}
                  </option>
                ))}
              </optgroup>
              {sshSessions.length > 0 ? (
                <optgroup label="SSH">
                  {sshSessions.map((item) => (
                    <option key={item.session_id} value={`ssh:${item.session_id}`}>
                      {item.name}
                    </option>
                  ))}
                </optgroup>
              ) : null}
            </Select>
          ) : null}
          <Button size="sm" variant="secondary" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
          </Button>
          <Button size="sm" variant="ghost" onClick={download} disabled={rows.length === 0}>
            <Download className="h-3.5 w-3.5" /> Export
          </Button>
        </div>
      </div>

      <div className="mb-3 flex gap-1 rounded-lg border border-zinc-800 bg-zinc-900/50 p-1 text-xs">
        {(["transcript", "audit"] as Tab[]).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={`rounded-md px-3 py-1.5 capitalize ${
              tab === value ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            {value}
          </button>
        ))}
        <span className="ml-auto self-center pr-2 text-[11px] text-zinc-500">
          {formatNumber(rows.length)} events
        </span>
      </div>

      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-[11px] uppercase tracking-widest text-zinc-400">
            {tab === "transcript"
              ? `transcript · ${selected.kind} · ${selected.name || "—"}`
              : "audit log"}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {rows.length === 0 ? (
            <p className="px-5 py-10 text-center text-xs text-zinc-500">
              {loading ? "loading…" : "No events yet."}
            </p>
          ) : (
            <div className="max-h-[65vh] overflow-y-auto">
              <table className="w-full border-collapse text-left text-[11px]">
                <thead className="sticky top-0 bg-zinc-900/95 text-zinc-500">
                  <tr>
                    <th className="px-4 py-2 font-medium">time</th>
                    <th className="px-4 py-2 font-medium">kind</th>
                    <th className="px-4 py-2 font-medium">detail</th>
                  </tr>
                </thead>
                <tbody>
                  {rows
                    .slice()
                    .reverse()
                    .map((event, index) => {
                      const record = event as TranscriptEvent;
                      const isAudit = tab === "audit";
                      return (
                        <tr key={index} className="border-t border-zinc-800/60 hover:bg-zinc-900/40">
                          <td className="whitespace-nowrap px-4 py-1.5 font-mono text-zinc-500">
                            {new Date(String(record.ts)).toLocaleTimeString()}
                          </td>
                          <td className="whitespace-nowrap px-4 py-1.5">
                            {isAudit ? (
                              <Badge tone="warn">{String(record.event)}</Badge>
                            ) : record.event ? (
                              <Badge>{record.event}</Badge>
                            ) : (
                              <Badge tone={record.dir === "rx" ? "accent" : "default"}>
                                {record.dir?.toUpperCase()} · {record.len ?? 0}B
                              </Badge>
                            )}
                          </td>
                          <td className="px-4 py-1.5 font-mono text-zinc-400">
                            {isAudit
                              ? JSON.stringify(
                                  Object.fromEntries(Object.entries(record).filter(([key]) => key !== "ts")),
                                ).slice(0, 200)
                              : preview(record)}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
