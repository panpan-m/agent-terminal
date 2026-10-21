import { useEffect, useState } from "react";
import { Save, Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Field, Input, Label, Select } from "@/components/ui/input";
import { Switch } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import type { SessionInput, SessionStatus } from "@/lib/types";

const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600, 1500000];

function fromSession(session: SessionStatus): SessionInput {
  return {
    id: session.session_id,
    name: session.name,
    port: session.port,
    baudrate: session.config.baudrate,
    bytesize: session.config.bytesize,
    parity: session.config.parity,
    stopbits: session.config.stopbits,
    flow: session.config.flow,
    open_mode: session.config.open_mode,
    auto_open: session.state === "open",
    auto_reconnect: session.auto_reconnect,
    buffer_bytes: session.buffer_bytes,
    agent_permissions: [...session.agent_permissions],
    transcript: true,
  };
}

export function ConfigPage({
  sessions,
  session,
  selectedId,
  onSelect,
  onSave,
  notify,
}: {
  sessions: SessionStatus[];
  session?: SessionStatus;
  selectedId?: string;
  onSelect: (id: string) => void;
  onSave: (id: string, input: SessionInput) => Promise<void>;
  notify: (message: string, tone?: "info" | "error" | "success") => void;
}) {
  const [form, setForm] = useState<SessionInput | null>(session ? fromSession(session) : null);
  const [steps, setSteps] = useState<{ dtr: boolean; rts: boolean; delay_ms: number }[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!session) {
      setForm(null);
      return;
    }
    setForm(fromSession(session));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.session_id, session?.config_revision]);

  if (!session || !form) {
    return (
      <div className="mx-auto max-w-3xl px-5 py-10 text-center text-sm text-zinc-500">
        No session selected. Create one on the Sessions page.
        <div className="mt-3 flex justify-center">
          <select
            value={selectedId ?? ""}
            onChange={(event) => onSelect(event.target.value)}
            className="h-8 rounded-md border border-zinc-700 bg-zinc-950/60 px-2 text-xs text-zinc-200"
          >
            {sessions.map((item) => (
              <option key={item.session_id} value={item.session_id}>
                {item.name}
              </option>
            ))}
          </select>
        </div>
      </div>
    );
  }

  const update = <K extends keyof SessionInput>(key: K, value: SessionInput[K]) =>
    setForm((previous) => (previous ? { ...previous, [key]: value } : previous));

  const togglePermission = (permission: string, enabled: boolean) => {
    const current = new Set(form.agent_permissions ?? []);
    if (enabled) current.add(permission);
    else current.delete(permission);
    update("agent_permissions", Array.from(current));
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await onSave(session.session_id, { ...form, reset_sequence: steps });
      await api.setPermissions(session.session_id, form.agent_permissions ?? []);
      notify("configuration applied", "success");
    } catch (error) {
      const failure = error as { code?: string; message?: string };
      notify(`${failure.code ?? "ERROR"}: ${failure.message ?? String(error)}`, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl px-5 py-6">
      <div className="mb-5 flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-zinc-100">Configuration</h1>
          <p className="mt-1 text-xs text-zinc-500">
            Changes close and reopen an open session atomically; runtime counters are kept.
          </p>
        </div>
        <select
          value={selectedId ?? session.session_id}
          onChange={(event) => onSelect(event.target.value)}
          className="h-8 rounded-md border border-zinc-700 bg-zinc-950/60 px-2 text-xs text-zinc-200"
        >
          {sessions.map((item) => (
            <option key={item.session_id} value={item.session_id}>
              {item.name}
            </option>
          ))}
        </select>
      </div>

      <form onSubmit={save} className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Serial port</CardTitle>
            <CardDescription>Exact framing matters: set it to what the board expects.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2">
            <Field label="Session id" hint="immutable; used by MCP tools">
              <Input value={form.id} disabled className="font-mono text-xs" />
            </Field>
            <Field label="Display name">
              <Input value={form.name} onChange={(event) => update("name", event.target.value)} />
            </Field>
            <Field label="Port" className="md:col-span-2" hint="Prefer /dev/serial/by-id on Linux">
              <Input
                value={form.port}
                onChange={(event) => update("port", event.target.value)}
                className="font-mono text-xs"
              />
            </Field>
            <Field label="Baud rate">
              <Select
                value={String(form.baudrate)}
                onChange={(event) => update("baudrate", Number(event.target.value))}
              >
                {Array.from(new Set([...BAUD_RATES, form.baudrate ?? 115200]))
                  .sort((a, b) => a - b)
                  .map((rate) => (
                    <option key={rate} value={rate}>
                      {rate}
                    </option>
                  ))}
              </Select>
            </Field>
            <div className="grid grid-cols-3 gap-2">
              <Field label="Bits">
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
              <Field label="Stop">
                <Select value={String(form.stopbits)} onChange={(event) => update("stopbits", Number(event.target.value))}>
                  <option value="1">1</option>
                  <option value="1.5">1.5</option>
                  <option value="2">2</option>
                </Select>
              </Field>
            </div>
            <Field label="Flow control">
              <Select value={form.flow} onChange={(event) => update("flow", event.target.value)}>
                {["none", "hard", "soft"].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Open behaviour" hint="preserve avoids touching DTR/RTS on open">
              <Select value={form.open_mode} onChange={(event) => update("open_mode", event.target.value)}>
                <option value="preserve">preserve</option>
                <option value="assert">assert DTR/RTS</option>
                <option value="deassert">deassert DTR/RTS</option>
              </Select>
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Behaviour</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <label className="flex items-center gap-2 text-xs text-zinc-300">
              <Switch checked={form.auto_open ?? false} onCheckedChange={(value) => update("auto_open", value)} />
              Open when the server starts
            </label>
            <label className="flex items-center gap-2 text-xs text-zinc-300">
              <Switch
                checked={form.auto_reconnect ?? true}
                onCheckedChange={(value) => update("auto_reconnect", value)}
              />
              Reconnect after unplug
            </label>
            <label className="flex items-center gap-2 text-xs text-zinc-300">
              <Switch checked={form.transcript ?? true} onCheckedChange={(value) => update("transcript", value)} />
              Write transcript (JSONL)
            </label>
            <Field label="Ring buffer" hint="older bytes are dropped and reported as gap">
              <Select
                value={String((form.buffer_bytes ?? 8388608) / 1024 / 1024)}
                onChange={(event) => update("buffer_bytes", Number(event.target.value) * 1024 * 1024)}
              >
                {[1, 2, 4, 8, 16, 32, 64].map((mb) => (
                  <option key={mb} value={mb}>
                    {mb} MiB
                  </option>
                ))}
              </Select>
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Agent permissions</CardTitle>
            <CardDescription>
              Capabilities the MCP tools may use. Write also requires handing control to the agent.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-5">
            {["read", "write", "command"].map((permission) => (
              <label key={permission} className="flex items-center gap-2 text-xs text-zinc-300">
                <Switch
                  checked={(form.agent_permissions ?? []).includes(permission)}
                  onCheckedChange={(value) => togglePermission(permission, value)}
                />
                {permission}
              </label>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <div>
              <CardTitle>Reset sequence</CardTitle>
              <CardDescription>Applied by the admin Reset button (DTR/RTS, then delay).</CardDescription>
            </div>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => setSteps((previous) => [...previous, { dtr: false, rts: true, delay_ms: 100 }])}
            >
              <Plus className="h-3.5 w-3.5" /> step
            </Button>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {steps.length === 0 ? (
              <p className="text-xs text-zinc-500">No custom sequence — the built-in 3-step pulse is used.</p>
            ) : null}
            {steps.map((step, index) => (
              <div key={index} className="flex items-end gap-2">
                <Field label="DTR">
                  <Select
                    value={step.dtr ? "1" : "0"}
                    onChange={(event) =>
                      setSteps((previous) =>
                        previous.map((item, i) => (i === index ? { ...item, dtr: event.target.value === "1" } : item)),
                      )
                    }
                  >
                    <option value="1">assert</option>
                    <option value="0">deassert</option>
                  </Select>
                </Field>
                <Field label="RTS">
                  <Select
                    value={step.rts ? "1" : "0"}
                    onChange={(event) =>
                      setSteps((previous) =>
                        previous.map((item, i) => (i === index ? { ...item, rts: event.target.value === "1" } : item)),
                      )
                    }
                  >
                    <option value="1">assert</option>
                    <option value="0">deassert</option>
                  </Select>
                </Field>
                <Field label="Delay (ms)">
                  <Input
                    type="number"
                    value={step.delay_ms}
                    onChange={(event) =>
                      setSteps((previous) =>
                        previous.map((item, i) =>
                          i === index ? { ...item, delay_ms: Number(event.target.value) } : item,
                        ),
                      )
                    }
                  />
                </Field>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => setSteps((previous) => previous.filter((_, i) => i !== index))}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>

        <div className="flex items-center justify-between pb-8">
          <Label className="text-zinc-500">
            Saving reopens the session if it is currently open.
          </Label>
          <Button type="submit" variant="primary" disabled={busy}>
            <Save className="h-4 w-4" /> Save configuration
          </Button>
        </div>
      </form>
    </div>
  );
}
