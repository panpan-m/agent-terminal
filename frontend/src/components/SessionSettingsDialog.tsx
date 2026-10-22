import { useEffect, useState } from "react";
import { Plus, Save, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger, Switch } from "@/components/ui/dialog";
import { Field, Input, Label, Select } from "@/components/ui/input";
import { api } from "@/lib/api";
import type { SessionInput, SessionStatus } from "@/lib/types";

const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600, 1500000];

type ResetStep = { dtr: boolean | null; rts: boolean | null; delay_ms: number };

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

/** Edit an existing serial session in place of the old Configuration tab. */
export function SessionSettingsDialog({
  session,
  onUpdate,
  trigger,
}: {
  session: SessionStatus;
  onUpdate: (id: string, input: SessionInput) => Promise<void>;
  trigger: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<SessionInput>(fromSession(session));
  const [steps, setSteps] = useState<ResetStep[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setForm(fromSession(session));
      setSteps(((session as unknown as { reset_sequence?: ResetStep[] }).reset_sequence ?? []).map((s) => ({ ...s })));
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, session.config_revision]);

  const update = <K extends keyof SessionInput>(key: K, value: SessionInput[K]) =>
    setForm((previous) => ({ ...previous, [key]: value }));

  const togglePermission = (permission: string, enabled: boolean) => {
    const current = new Set(form.agent_permissions ?? []);
    if (enabled) current.add(permission);
    else current.delete(permission);
    update("agent_permissions", Array.from(current));
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onUpdate(session.session_id, { ...form, reset_sequence: steps });
      await api.setPermissions(session.session_id, form.agent_permissions ?? []);
      setOpen(false);
    } catch (failure) {
      const detail = failure as { code?: string; message?: string };
      setError(`${detail.code ?? "ERROR"}: ${detail.message ?? String(failure)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent
        title={`Configure ${session.name}`}
        description="Saving closes and reopens an open session atomically; runtime counters are kept."
      >
        <form onSubmit={save} className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Session id" hint="immutable; used by MCP tools">
              <Input value={form.id ?? ""} disabled className="font-mono text-xs" />
            </Field>
            <Field label="Display name">
              <Input value={form.name ?? ""} onChange={(event) => update("name", event.target.value)} />
            </Field>
          </div>

          <Field label="Port" hint="prefer /dev/serial/by-id on Linux">
            <Input
              value={form.port}
              onChange={(event) => update("port", event.target.value)}
              className="font-mono text-xs"
            />
          </Field>

          <div className="grid grid-cols-4 gap-3">
            <Field label="Baud rate">
              <Select value={String(form.baudrate)} onChange={(event) => update("baudrate", Number(event.target.value))}>
                {Array.from(new Set([...BAUD_RATES, form.baudrate ?? 115200]))
                  .sort((a, b) => a - b)
                  .map((rate) => (
                    <option key={rate} value={rate}>
                      {rate}
                    </option>
                  ))}
              </Select>
            </Field>
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
            <Field label="Open behaviour" hint="preserve avoids touching DTR/RTS">
              <Select value={form.open_mode} onChange={(event) => update("open_mode", event.target.value)}>
                <option value="preserve">preserve</option>
                <option value="assert">assert DTR/RTS</option>
                <option value="deassert">deassert DTR/RTS</option>
              </Select>
            </Field>
          </div>

          <div className="flex flex-wrap items-center gap-5 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2.5">
            <label className="flex items-center gap-2 text-xs text-zinc-300">
              <Switch checked={form.auto_open ?? false} onCheckedChange={(value) => update("auto_open", value)} />
              Open on start
            </label>
            <label className="flex items-center gap-2 text-xs text-zinc-300">
              <Switch
                checked={form.auto_reconnect ?? true}
                onCheckedChange={(value) => update("auto_reconnect", value)}
              />
              Auto reconnect
            </label>
            <label className="flex items-center gap-2 text-xs text-zinc-300">
              <Switch checked={form.transcript ?? true} onCheckedChange={(value) => update("transcript", value)} />
              Transcript
            </label>
            <div className="ml-auto flex items-center gap-2 text-[11px] text-zinc-500">
              <Label htmlFor={`buffer-${session.session_id}`}>Buffer</Label>
              <Select
                id={`buffer-${session.session_id}`}
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

          <div className="flex flex-wrap gap-5 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2.5">
            <span className="text-[10px] uppercase tracking-widest text-zinc-500">Agent permissions</span>
            {["read", "write", "command"].map((permission) => (
              <label key={permission} className="flex items-center gap-2 text-xs text-zinc-300">
                <Switch
                  checked={(form.agent_permissions ?? []).includes(permission)}
                  onCheckedChange={(value) => togglePermission(permission, value)}
                />
                {permission}
              </label>
            ))}
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <Label className="text-zinc-500">Reset sequence (DTR/RTS, then delay)</Label>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => setSteps((previous) => [...previous, { dtr: false, rts: true, delay_ms: 100 }])}
              >
                <Plus className="h-3.5 w-3.5" /> step
              </Button>
            </div>
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
                        previous.map((item, i) => (i === index ? { ...item, delay_ms: Number(event.target.value) } : item)),
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
          </div>

          {error ? (
            <p className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</p>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy}>
              <Save className="h-4 w-4" /> Save configuration
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
