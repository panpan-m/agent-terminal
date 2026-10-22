import { useEffect, useState } from "react";
import {
  Cable,
  ChevronRight,
  CircleSlash,
  Monitor,
  Pencil,
  Plus,
  Power,
  RotateCcw,
  Trash2,
  UserRound,
} from "lucide-react";

import { Badge, StateBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogTrigger, Switch } from "@/components/ui/dialog";
import { Field, Input, Select, Label } from "@/components/ui/input";
import { SessionSettingsDialog } from "@/components/SessionSettingsDialog";
import { api } from "@/lib/api";
import type { PortInfo, SessionInput, SessionStatus, SystemInfo } from "@/lib/types";
import { formatBytes, formatNumber, formatUptime } from "@/lib/utils";

const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600, 1500000];

export function OverviewPage({
  sessions,
  system,
  refresh,
  notify,
  onCreate,
  onUpdate,
  onTerminal,
  onControl,
  onOpenSession,
  onCloseSession,
  onDelete,
  onReset,
}: {
  sessions: SessionStatus[];
  system: SystemInfo | null;
  refresh: () => Promise<void>;
  notify: (message: string, tone?: "info" | "error" | "success") => void;
  onCreate: (input: SessionInput) => Promise<void>;
  onUpdate: (id: string, input: SessionInput) => Promise<void>;
  onTerminal: (id: string) => void;
  onControl: (id: string, owner: "human" | "agent") => Promise<boolean>;
  onOpenSession: (id: string) => Promise<boolean>;
  onCloseSession: (id: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
  onReset: (id: string) => Promise<boolean>;
}) {
  const openCount = sessions.filter((session) => session.state === "open").length;
  const agentOwned = sessions.filter((session) => session.control_owner === "agent").length;

  return (
    <div className="mx-auto max-w-6xl px-5 py-6">
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-zinc-100">Serial sessions</h1>
          <p className="mt-1 text-xs text-zinc-500">
            One owner per port. Open a device, hand control to an agent, watch it in the console.
          </p>
        </div>
        <NewSessionDialog onCreate={onCreate} />
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Configured" value={String(sessions.length)} hint="max 4" />
        <Stat label="Open" value={String(openCount)} hint="serial ports held" accent />
        <Stat label="Agent control" value={String(agentOwned)} hint="writable by MCP" />
        <Stat
          label="Uptime"
          value={system ? formatUptime(system.uptime_seconds) : "—"}
          hint={system ? `v${system.version} · ${system.platform}` : ""}
        />
      </div>

      {sessions.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
            <div className="flex h-11 w-11 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900">
              <Cable className="h-5 w-5 text-zinc-400" />
            </div>
            <div>
              <p className="text-sm text-zinc-200">No serial session yet</p>
              <p className="mt-1 text-xs text-zinc-500">
                Pick a port and open it. The server becomes the only process that touches the device.
              </p>
            </div>
            <NewSessionDialog onCreate={onCreate} />
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {sessions.map((session) => (
            <SessionCard
              key={session.session_id}
              session={session}
              onTerminal={() => onTerminal(session.session_id)}
              onControl={onControl}
              onUpdate={onUpdate}
              onOpenSession={onOpenSession}
              onCloseSession={onCloseSession}
              onDelete={onDelete}
              onReset={onReset}
              refresh={refresh}
              notify={notify}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, hint, accent }: { label: string; value: string; hint?: string; accent?: boolean }) {
  return (
    <Card>
      <CardContent className="py-3.5">
        <p className="text-[10px] uppercase tracking-widest text-zinc-500">{label}</p>
        <p className={`mt-1 text-2xl font-semibold ${accent ? "text-emerald-300" : "text-zinc-100"}`}>{value}</p>
        {hint ? <p className="mt-0.5 text-[11px] text-zinc-500">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}

function SessionCard({
  session,
  onTerminal,
  onControl,
  onUpdate,
  onOpenSession,
  onCloseSession,
  onDelete,
  onReset,
  refresh,
  notify,
}: {
  session: SessionStatus;
  onTerminal: () => void;
  onControl: (id: string, owner: "human" | "agent") => Promise<boolean>;
  onUpdate: (id: string, input: SessionInput) => Promise<void>;
  onOpenSession: (id: string) => Promise<boolean>;
  onCloseSession: (id: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
  onReset: (id: string) => Promise<boolean>;
  refresh: () => Promise<void>;
  notify: (message: string, tone?: "info" | "error" | "success") => void;
}) {
  const [busy, setBusy] = useState(false);
  const isOpen = session.state === "open";
  const agentOwns = session.control_owner === "agent";

  const run = async (action: () => Promise<boolean>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  return (
    <Card className="flex flex-col">
      <CardHeader className="flex-row items-start justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <CardTitle className="truncate">{session.name}</CardTitle>
            <StateBadge state={session.state} />
          </div>
          <p className="mt-1 truncate font-mono text-[11px] text-zinc-500">{session.port}</p>
        </div>
        <div className="flex items-center gap-1">
          <SessionSettingsDialog
            session={session}
            onUpdate={onUpdate}
            trigger={
              <button
                type="button"
                className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-40"
                title="configure session"
                disabled={busy}
              >
                <Pencil className="h-4 w-4" />
              </button>
            }
          />
          <button
            type="button"
            className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-red-300 disabled:opacity-40"
            title="delete session"
            disabled={busy}
            onClick={async () => {
              if (window.confirm(`Delete session "${session.name}"? The transcript stays on disk.`)) {
                await run(() => onDelete(session.session_id));
              }
            }}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </CardHeader>

      <CardContent className="flex flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge>
            {session.config.baudrate} {session.config.bytesize}
            {session.config.parity[0].toUpperCase()}
            {session.config.stopbits}
          </Badge>
          <Badge>{session.config.flow} flow</Badge>
          <Badge tone={agentOwns ? "accent" : "default"}>
            {agentOwns ? <UserRound className="mr-1 h-3 w-3" /> : null}
            {session.control_owner}
          </Badge>
          {session.lost_bytes > 0 ? <Badge tone="warn">{formatBytes(session.lost_bytes)} lost</Badge> : null}
          {session.reconnect_count > 0 ? <Badge tone="warn">{session.reconnect_count} reconnects</Badge> : null}
        </div>

        <div className="grid grid-cols-3 gap-2 text-[11px]">
          <Metric label="RX" value={formatNumber(session.rx_bytes)} />
          <Metric label="TX" value={formatNumber(session.tx_bytes)} />
          <Metric
            label="Buffer"
            value={formatBytes(session.buffer_bytes)}
            hint={`${Math.round((session.rx_head - session.rx_start) / session.buffer_bytes * 100)}% used`}
          />
        </div>

        {session.last_error ? (
          <p className="rounded-md border border-red-500/25 bg-red-500/10 px-2.5 py-1.5 text-[11px] text-red-300">
            {session.last_error}
          </p>
        ) : null}

        <div className="flex items-center gap-3 text-[11px] text-zinc-500">
          <span className="inline-flex items-center gap-1">
            <CircleSlash className="h-3 w-3" />
            DTR {session.lines?.dtr ? "on" : "off"}
          </span>
          <span>CTS {session.lines?.cts ? "on" : "off"}</span>
          <span>DSR {session.lines?.dsr ? "on" : "off"}</span>
          <span className="ml-auto">last rx {session.last_rx_at ? new Date(session.last_rx_at).toLocaleTimeString() : "—"}</span>
        </div>
      </CardContent>

      <CardFooter className="flex-wrap">
        <Button size="sm" variant="primary" onClick={onTerminal} disabled={!isOpen} title="open the interactive terminal tab">
          <Monitor className="h-3.5 w-3.5" /> Terminal <ChevronRight className="h-3 w-3" />
        </Button>
        <Button
          size="sm"
          variant={agentOwns ? "outline" : "primary"}
          disabled={busy || !isOpen}
          onClick={() => run(() => onControl(session.session_id, agentOwns ? "human" : "agent"))}
        >
          {agentOwns ? "Take control" : "Hand to agent"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => run(() => (isOpen ? onCloseSession(session.session_id) : onOpenSession(session.session_id)))}
        >
          <Power className="h-3.5 w-3.5" /> {isOpen ? "Close" : "Open"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={async () => {
            const ok = await onReset(session.session_id);
            if (ok) notify("reset sequence applied", "success");
          }}
          title="apply the configured DTR/RTS reset sequence"
        >
          <RotateCcw className="h-3.5 w-3.5" /> Reset
        </Button>
      </CardFooter>
    </Card>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950/40 px-2.5 py-1.5">
      <p className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</p>
      <p className="font-mono text-xs text-zinc-200">{value}</p>
      {hint ? <p className="text-[10px] text-zinc-600">{hint}</p> : null}
    </div>
  );
}

function NewSessionDialog({ onCreate }: { onCreate: (input: SessionInput) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [loadingPorts, setLoadingPorts] = useState(false);
  const [form, setForm] = useState<SessionInput>({
    id: "",
    name: "",
    port: "",
    baudrate: 115200,
    bytesize: 8,
    parity: "none",
    stopbits: 1,
    flow: "none",
    auto_open: true,
    auto_reconnect: true,
    buffer_bytes: 8 * 1024 * 1024,
    agent_permissions: ["read", "write", "command"],
    transcript: true,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoadingPorts(true);
    api
      .ports()
      .then((result) => {
        setPorts(result.ports);
        if (!form.port && result.ports.length > 0) {
          setForm((prev) => ({ ...prev, port: result.ports[0].by_id ?? result.ports[0].port }));
        }
      })
      .catch(() => setPorts([]))
      .finally(() => setLoadingPorts(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const update = <K extends keyof SessionInput>(key: K, value: SessionInput[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!form.id || !form.port) {
      setError("Session id and port are required.");
      return;
    }
    setBusy(true);
    try {
      await onCreate({ ...form, name: form.name || form.id });
      setOpen(false);
      setForm((prev) => ({ ...prev, id: "", name: "", port: "" }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="primary" size="sm">
          <Plus className="h-4 w-4" /> New session
        </Button>
      </DialogTrigger>
      <DialogContent title="New serial session" description="The server will keep the only handle to this port.">
        <form onSubmit={submit} className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Session id" hint="lowercase, used by MCP">
              <Input
                value={form.id}
                placeholder="board-a"
                onChange={(event) => update("id", event.target.value.replace(/[^a-z0-9_-]/g, ""))}
              />
            </Field>
            <Field label="Display name">
              <Input
                value={form.name}
                placeholder="Board A"
                onChange={(event) => update("name", event.target.value)}
              />
            </Field>
          </div>

          <Field label="Port" hint={loadingPorts ? "scanning ports…" : "use by-id where possible"}>
            <div className="flex gap-2">
              <Select
                value={ports.some((port) => (port.by_id ?? port.port) === form.port) ? form.port : "__custom"}
                onChange={(event) => {
                  if (event.target.value !== "__custom") update("port", event.target.value);
                }}
                className="flex-1"
              >
                <option value="__custom">custom / not listed</option>
                {ports.map((port) => (
                  <option key={port.port} value={port.by_id ?? port.port}>
                    {port.by_id ?? port.port} — {port.description || "serial"}
                  </option>
                ))}
              </Select>
              <Input
                className="flex-1 font-mono text-xs"
                value={form.port}
                placeholder="COM5 or /dev/serial/by-id/…"
                onChange={(event) => update("port", event.target.value)}
              />
            </div>
          </Field>

          <div className="grid grid-cols-4 gap-3">
            <Field label="Baud">
              <Select
                value={String(form.baudrate)}
                onChange={(event) => update("baudrate", Number(event.target.value))}
              >
                {BAUD_RATES.map((rate) => (
                  <option key={rate} value={rate}>
                    {rate}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Data bits">
              <Select value={String(form.bytesize)} onChange={(event) => update("bytesize", Number(event.target.value))}>
                {[8, 7, 6, 5].map((bits) => (
                  <option key={bits} value={bits}>
                    {bits}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Parity">
              <Select value={form.parity} onChange={(event) => update("parity", event.target.value)}>
                {["none", "even", "odd", "mark", "space"].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Stop bits">
              <Select value={String(form.stopbits)} onChange={(event) => update("stopbits", Number(event.target.value))}>
                <option value="1">1</option>
                <option value="1.5">1.5</option>
                <option value="2">2</option>
              </Select>
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Flow control">
              <Select value={form.flow} onChange={(event) => update("flow", event.target.value)}>
                {["none", "hard", "soft"].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Open behaviour">
              <Select value={form.open_mode} onChange={(event) => update("open_mode", event.target.value)}>
                <option value="preserve">preserve (do not touch DTR/RTS)</option>
                <option value="assert">assert DTR/RTS</option>
                <option value="deassert">deassert DTR/RTS</option>
              </Select>
            </Field>
          </div>

          <div className="flex flex-wrap items-center gap-5 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2.5">
            <Toggle label="Open on start" checked={form.auto_open ?? false} onChange={(v) => update("auto_open", v)} />
            <Toggle
              label="Auto reconnect"
              checked={form.auto_reconnect ?? true}
              onChange={(v) => update("auto_reconnect", v)}
            />
            <Toggle label="Transcript" checked={form.transcript ?? true} onChange={(v) => update("transcript", v)} />
            <div className="ml-auto flex items-center gap-2 text-[11px] text-zinc-500">
              <Label htmlFor="buffer">Buffer</Label>
              <Select
                id="buffer"
                className="h-7 w-24 text-xs"
                value={String((form.buffer_bytes ?? 8388608) / 1024 / 1024)}
                onChange={(event) => update("buffer_bytes", Number(event.target.value) * 1024 * 1024)}
              >
                {[1, 2, 4, 8, 16, 32, 64].map((mb) => (
                  <option key={mb} value={mb}>
                    {mb} MiB
                  </option>
                ))}
              </Select>
            </div>
          </div>

          {error ? (
            <p className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</p>
          ) : null}

          <div className="mt-1 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy}>
              Create & open
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-zinc-300">
      <Switch checked={checked} onCheckedChange={onChange} />
      {label}
    </label>
  );
}
