import { useCallback, useEffect, useState } from "react";
import {
  KeyRound,
  Loader2,
  Pencil,
  Play,
  Plus,
  Server,
  ShieldCheck,
  Square,
  Trash2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { ApiFailure, api } from "@/lib/api";
import type { SshHost, SshHostInput, SshSessionStatus } from "@/lib/types";
import { formatBytes, formatTime } from "@/lib/utils";

const EMPTY: SshHostInput = {
  name: "",
  host: "",
  port: 22,
  username: "root",
  auth: "password",
  key_file: "",
  known_hosts: "",
  term: "xterm-256color",
  connect_timeout_s: 10,
};

const STATE_TONE: Record<string, string> = {
  open: "text-emerald-300",
  connecting: "text-amber-300",
  closed: "text-zinc-500",
  error: "text-red-400",
};

export function ConnectionsPage({
  notify,
  onOpen,
}: {
  notify: (message: string, tone?: "info" | "error" | "success") => void;
  onOpen: (sessionId: string) => void;
}) {
  const [hosts, setHosts] = useState<SshHost[]>([]);
  const [sessions, setSessions] = useState<SshSessionStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<SshHost | null>(null);
  const [form, setForm] = useState<SshHostInput>(EMPTY);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [connectTarget, setConnectTarget] = useState<SshHost | null>(null);
  const [password, setPassword] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connectDetails, setConnectDetails] = useState<Record<string, unknown> | null>(null);
  const [connecting, setConnecting] = useState(false);

  const load = useCallback(async () => {
    try {
      const [hostsResult, sessionsResult] = await Promise.all([api.sshHosts(), api.sshSessions()]);
      setHosts(hostsResult.hosts);
      setSessions(sessionsResult.sessions);
    } catch (error) {
      if (!(error instanceof ApiFailure && error.status === 401)) {
        notify(`${(error as ApiFailure).code ?? "ERROR"}: ${(error as Error).message}`, "error");
      }
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 4000);
    return () => window.clearInterval(timer);
  }, [load]);

  const openCreate = () => {
    setEditing(null);
    setForm({ ...EMPTY });
    setFormError(null);
    setFormOpen(true);
  };

  const openEdit = (host: SshHost) => {
    setEditing(host);
    setForm({
      id: host.id,
      name: host.name,
      host: host.host,
      port: host.port,
      username: host.username,
      auth: host.auth,
      key_file: host.key_file,
      known_hosts: host.known_hosts,
      term: host.term,
      connect_timeout_s: host.connect_timeout_s,
    });
    setFormError(null);
    setFormOpen(true);
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      if (editing) {
        await api.updateSshHost(editing.id, form);
        notify(`SSH host ${editing.id} updated`, "success");
      } else {
        const created = await api.createSshHost(form);
        notify(`SSH host ${created.id} created`, "success");
      }
      setFormOpen(false);
      await load();
    } catch (error) {
      setFormError((error as ApiFailure).message ?? String(error));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (host: SshHost) => {
    if (!window.confirm(`Delete SSH host ${host.name}? Saved profiles contain no secrets.`)) return;
    try {
      await api.deleteSshHost(host.id);
      notify(`SSH host ${host.id} deleted`, "success");
      await load();
    } catch (error) {
      notify(`${(error as ApiFailure).code ?? "ERROR"}: ${(error as ApiFailure).message}`, "error");
    }
  };

  const startConnect = (host: SshHost) => {
    setConnectTarget(host);
    setPassword("");
    setPassphrase("");
    setConnectError(null);
    setConnectDetails(null);
  };

  const connect = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!connectTarget) return;
    if (connectTarget.auth === "password" && !password) {
      setConnectError("password is required");
      return;
    }
    setConnecting(true);
    setConnectError(null);
    try {
      const result = await api.sshConnect(connectTarget.id, {
        password: password || undefined,
        passphrase: passphrase || undefined,
        cols: 120,
        rows: 30,
      });
      setConnectTarget(null);
      notify(`connected to ${result.session.host}`, "success");
      await load();
      onOpen(result.session.session_id);
    } catch (error) {
      const failure = error as ApiFailure;
      setConnectError(failure.message ?? String(error));
      setConnectDetails(failure.details ?? null);
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = async (session: SshSessionStatus) => {
    try {
      await api.sshDisconnect(session.session_id);
      notify("SSH session disconnected", "success");
      await load();
    } catch (error) {
      notify(`${(error as ApiFailure).code ?? "ERROR"}: ${(error as ApiFailure).message}`, "error");
    }
  };

  return (
    <div className="mx-auto max-w-6xl px-5 py-6">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-zinc-100">SSH connections</h1>
          <p className="mt-1 max-w-2xl text-xs text-zinc-500">
            Saved hosts are configuration only — passwords and key passphrases are sent per connection and never
            stored. Host keys are checked strictly against known_hosts.
          </p>
        </div>
        <Button variant="primary" onClick={openCreate}>
          <Plus className="h-4 w-4" /> New SSH host
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <Loader2 className="h-4 w-4 animate-spin" /> loading…
        </div>
      ) : hosts.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
            <div className="flex h-11 w-11 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900">
              <Server className="h-5 w-5 text-zinc-400" />
            </div>
            <div>
              <p className="text-sm text-zinc-200">No SSH host yet</p>
              <p className="mt-1 text-xs text-zinc-500">
                Add a host, then connect from this page. The terminal opens in its own tab.
              </p>
            </div>
            <Button variant="primary" onClick={openCreate}>
              <Plus className="h-4 w-4" /> Add the first host
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {hosts.map((host) => (
            <Card key={host.id} className="border-zinc-800/80">
              <CardHeader className="flex flex-row items-start justify-between gap-3 pb-2">
                <div className="min-w-0">
                  <CardTitle className="flex items-center gap-2 text-sm text-zinc-100">
                    <Server className="h-4 w-4 text-emerald-400" />
                    <span className="truncate">{host.name}</span>
                  </CardTitle>
                  <p className="mt-1 truncate font-mono text-[11px] text-zinc-500">
                    {host.username}@{host.host}:{host.port}
                  </p>
                </div>
                <Badge tone={host.auth === "key" ? "accent" : "default"}>
                  {host.auth === "key" ? <KeyRound className="mr-1 h-3 w-3" /> : <ShieldCheck className="mr-1 h-3 w-3" />}
                  {host.auth}
                </Badge>
              </CardHeader>
              <CardContent className="space-y-2 pt-0">
                <div className="flex flex-wrap gap-1.5 text-[10px] text-zinc-500">
                  <span className="rounded border border-zinc-800 px-1.5 py-0.5 font-mono">{host.id}</span>
                  <span className="rounded border border-zinc-800 px-1.5 py-0.5 font-mono">{host.term}</span>
                  <span className="rounded border border-zinc-800 px-1.5 py-0.5">
                    known_hosts: {host.known_hosts || "~/.ssh/known_hosts"}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5 pt-1">
                  <Button size="sm" variant="primary" onClick={() => startConnect(host)}>
                    <Play className="h-3.5 w-3.5" /> Connect
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => openEdit(host)}>
                    <Pencil className="h-3.5 w-3.5" /> Edit
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void remove(host)}>
                    <Trash2 className="h-3.5 w-3.5" /> Delete
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <section className="mt-8">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-200">Open SSH sessions</h2>
          <span className="text-[11px] text-zinc-500">{sessions.length} total</span>
        </div>
        {sessions.length === 0 ? (
          <p className="rounded-lg border border-zinc-800/70 bg-zinc-950/40 px-3 py-4 text-xs text-zinc-500">
            No SSH session is open. Connections persist server-side until you disconnect, so the browser can
            reattach from this list.
          </p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-zinc-800/80">
            <table className="w-full text-left text-xs">
              <thead className="bg-zinc-950/60 text-[10px] uppercase tracking-widest text-zinc-500">
                <tr>
                  <th className="px-3 py-2">Host</th>
                  <th className="px-3 py-2">State</th>
                  <th className="px-3 py-2">RX/TX</th>
                  <th className="px-3 py-2">Opened</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/70">
                {sessions.map((session) => (
                  <tr key={session.session_id} className="text-zinc-300">
                    <td className="px-3 py-2">
                      <div className="font-medium text-zinc-100">{session.name}</div>
                      <div className="font-mono text-[10px] text-zinc-500">
                        {session.username}@{session.host}:{session.port}
                      </div>
                    </td>
                    <td className={`px-3 py-2 ${STATE_TONE[session.state] ?? "text-zinc-400"}`}>
                      {session.state}
                      {session.last_error ? (
                        <div className="max-w-xs truncate text-[10px] text-red-400">{session.last_error}</div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 font-mono text-[10px] text-zinc-400">
                      {formatBytes(session.rx_bytes)} / {formatBytes(session.tx_bytes)}
                    </td>
                    <td className="px-3 py-2 text-[10px] text-zinc-500">{formatTime(session.opened_at)}</td>
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="ghost" onClick={() => onOpen(session.session_id)}>
                          Open
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => void disconnect(session)}>
                          <Square className="h-3 w-3" /> Disconnect
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent
          title={editing ? `Edit ${editing.name}` : "New SSH host"}
          description="Stored on the server without secrets. The private key stays in its file."
        >
          <form className="space-y-3" onSubmit={save}>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Host id" hint="optional; generated from the name">
                <Input
                  value={form.id ?? ""}
                  disabled={Boolean(editing)}
                  onChange={(event) => setForm({ ...form, id: event.target.value })}
                  placeholder="pi"
                />
              </Field>
              <Field label="Name">
                <Input
                  value={form.name}
                  required
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                  placeholder="Raspberry Pi"
                />
              </Field>
              <Field label="Host">
                <Input
                  value={form.host}
                  required
                  onChange={(event) => setForm({ ...form, host: event.target.value })}
                  placeholder="192.168.124.23"
                />
              </Field>
              <Field label="Port">
                <Input
                  type="number"
                  min={1}
                  max={65535}
                  value={form.port}
                  onChange={(event) => setForm({ ...form, port: Number(event.target.value) })}
                />
              </Field>
              <Field label="Username">
                <Input
                  value={form.username}
                  required
                  onChange={(event) => setForm({ ...form, username: event.target.value })}
                />
              </Field>
              <Field label="Authentication">
                <Select
                  value={form.auth}
                  onChange={(event) => setForm({ ...form, auth: event.target.value as SshHostInput["auth"] })}
                >
                  <option value="password">password</option>
                  <option value="key">private key</option>
                </Select>
              </Field>
            </div>
            {form.auth === "key" ? (
              <Field label="Private key file" hint="path on the tio-server machine; never uploaded">
                <Input
                  value={form.key_file ?? ""}
                  required
                  onChange={(event) => setForm({ ...form, key_file: event.target.value })}
                  placeholder="C:\Users\PC\.ssh\id_ed25519"
                />
              </Field>
            ) : null}
            <Field label="known_hosts" hint="empty = ~/.ssh/known_hosts; strict verification">
              <Input
                value={form.known_hosts ?? ""}
                onChange={(event) => setForm({ ...form, known_hosts: event.target.value })}
                placeholder="C:\Users\PC\.ssh\known_hosts"
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="TERM">
                <Input
                  value={form.term ?? "xterm-256color"}
                  onChange={(event) => setForm({ ...form, term: event.target.value })}
                />
              </Field>
              <Field label="Connect timeout (s)">
                <Input
                  type="number"
                  min={1}
                  max={120}
                  value={form.connect_timeout_s ?? 10}
                  onChange={(event) =>
                    setForm({ ...form, connect_timeout_s: Number(event.target.value) })
                  }
                />
              </Field>
            </div>
            {formError ? <p className="text-xs text-red-400">{formError}</p> : null}
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="ghost" onClick={() => setFormOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={saving}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {editing ? "Save" : "Create"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(connectTarget)} onOpenChange={(open) => !open && setConnectTarget(null)}>
        <DialogContent
          title={connectTarget ? `Connect to ${connectTarget.name}` : "Connect"}
          description="Credentials are used for this connection only and are not written to disk."
        >
          {connectTarget ? (
            <form className="space-y-3" onSubmit={connect}>
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-2 font-mono text-[11px] text-zinc-400">
                {connectTarget.username}@{connectTarget.host}:{connectTarget.port} · {connectTarget.auth} ·{" "}
                {connectTarget.term}
              </div>
              {connectTarget.auth === "password" ? (
                <Field label="Password">
                  <Input
                    type="password"
                    autoFocus
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </Field>
              ) : (
                <Field label="Key passphrase" hint="leave empty if the key has no passphrase">
                  <Input
                    type="password"
                    autoFocus
                    value={passphrase}
                    onChange={(event) => setPassphrase(event.target.value)}
                  />
                </Field>
              )}
              <p className="text-[11px] text-zinc-500">
                The host key must already be present in{" "}
                <span className="font-mono">{connectTarget.known_hosts || "~/.ssh/known_hosts"}</span>. Unknown keys
                are rejected; the error reports the SHA256 fingerprint so you can verify it out of band.
              </p>
              {connectError ? <p className="text-xs text-red-400">{connectError}</p> : null}
              {connectDetails?.fingerprint ? (
                <p className="break-all rounded border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 font-mono text-[10px] text-amber-200">
                  SHA256: {String(connectDetails.fingerprint).replace(/^SHA256:/, "")}
                </p>
              ) : null}
              {connectDetails?.expected_fingerprint || connectDetails?.actual_fingerprint ? (
                <div className="space-y-1 rounded border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 font-mono text-[10px] text-amber-200">
                  <p className="break-all">expected: {String(connectDetails.expected_fingerprint)}</p>
                  <p className="break-all">actual: {String(connectDetails.actual_fingerprint)}</p>
                </div>
              ) : null}
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="ghost" onClick={() => setConnectTarget(null)}>
                  Cancel
                </Button>
                <Button type="submit" variant="primary" disabled={connecting}>
                  {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                  Connect
                </Button>
              </div>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
