import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  FileInput,
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
import { Dialog, DialogContent, Switch } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { ApiFailure, api } from "@/lib/api";
import type { SshConfigCandidate, SshHost, SshHostInput, SshSessionStatus, SshTestResult } from "@/lib/types";
import { formatBytes, formatTime } from "@/lib/utils";

const EMPTY: SshHostInput = {
  name: "",
  host: "",
  port: 22,
  username: "root",
  auth: "password",
  key_file: "",
  known_hosts: "",
  jump_host_id: "",
  auto_reconnect: true,
  term: "xterm-256color",
  connect_timeout_s: 10,
};

const STATE_TONE: Record<string, string> = {
  open: "text-emerald-300",
  connecting: "text-amber-300",
  reconnecting: "text-amber-300",
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
  const [jumpPassword, setJumpPassword] = useState("");
  const [jumpPassphrase, setJumpPassphrase] = useState("");
  const [responsesText, setResponsesText] = useState("");
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connectDetails, setConnectDetails] = useState<Record<string, unknown> | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<SshTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importPath, setImportPath] = useState("");
  const [candidates, setCandidates] = useState<SshConfigCandidate[]>([]);
  const [selectedCandidates, setSelectedCandidates] = useState<Set<string>>(new Set());
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

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
      jump_host_id: host.jump_host_id,
      auto_reconnect: host.auto_reconnect,
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
    setJumpPassword("");
    setJumpPassphrase("");
    setResponsesText("");
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
        jump_password: jumpPassword || undefined,
        jump_passphrase: jumpPassphrase || undefined,
        responses: responsesText
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
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

  const testHost = async (host: SshHost) => {
    setTestingId(host.id);
    setTestResult(null);
    setTestError(null);
    try {
      setTestResult(await api.sshTestHost(host.id));
    } catch (error) {
      const failure = error as ApiFailure;
      setTestError(`${failure.code ?? "ERROR"}: ${failure.message}`);
    } finally {
      setTestingId(null);
    }
  };

  const openImport = async () => {
    setImportOpen(true);
    setImportError(null);
    setCandidates([]);
    try {
      const result = await api.sshConfigCandidates();
      setImportPath(result.path);
      const existing = new Set(hosts.map((host) => host.id));
      const available = result.hosts.filter((host) => !existing.has(host.id));
      setCandidates(available);
      setSelectedCandidates(new Set(available.map((host) => host.id)));
    } catch (error) {
      setImportError((error as Error).message);
    }
  };

  const importSelected = async () => {
    setImportBusy(true);
    setImportError(null);
    let imported = 0;
    const failures: string[] = [];
    for (const candidate of candidates) {
      if (!selectedCandidates.has(candidate.id)) continue;
      try {
        await api.createSshHost({
          id: candidate.id,
          name: candidate.name,
          host: candidate.host,
          port: candidate.port,
          username: candidate.username,
          auth: candidate.auth,
          key_file: candidate.key_file,
          known_hosts: "",
          jump_host_id: "",
          auto_reconnect: true,
          term: "xterm-256color",
          connect_timeout_s: 10,
        });
        imported += 1;
      } catch (error) {
        failures.push(`${candidate.name}: ${(error as ApiFailure).message}`);
      }
    }
    setImportBusy(false);
    await load();
    if (imported) notify(`imported ${imported} SSH host(s)`, "success");
    if (failures.length) setImportError(failures.join("; "));
    else setImportOpen(false);
  };

  const connectJump = connectTarget
    ? hosts.find((host) => host.id === connectTarget.jump_host_id)
    : undefined;

  return (
    <div className="mx-auto max-w-6xl px-5 py-6">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-zinc-100">SSH sessions</h1>
          <p className="mt-1 max-w-2xl text-xs text-zinc-500">
            Saved hosts are configuration only — passwords and key passphrases are sent per connection and never
            stored. Host keys are checked strictly against known_hosts.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" onClick={() => void openImport()}>
            <FileInput className="h-4 w-4" /> Import ~/.ssh/config
          </Button>
          <Button variant="primary" onClick={openCreate}>
            <Plus className="h-4 w-4" /> New SSH host
          </Button>
        </div>
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
                  {host.jump_host_id ? (
                    <span className="rounded border border-sky-500/30 px-1.5 py-0.5 text-sky-300">
                      via {host.jump_host_id}
                    </span>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-1.5 pt-1">
                  <Button size="sm" variant="primary" onClick={() => startConnect(host)}>
                    <Play className="h-3.5 w-3.5" /> Connect
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void testHost(host)}
                    disabled={testingId === host.id}
                  >
                    {testingId === host.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Activity className="h-3.5 w-3.5" />
                    )}
                    Test
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
                  <option value="agent">ssh agent</option>
                  <option value="interactive">keyboard-interactive / 2FA</option>
                </Select>
              </Field>
              <Field label="Jump host" hint="optional; another saved SSH host">
                <Select
                  value={form.jump_host_id ?? ""}
                  onChange={(event) => setForm({ ...form, jump_host_id: event.target.value })}
                >
                  <option value="">direct connection</option>
                  {hosts
                    .filter((host) => host.id !== (editing?.id ?? form.id))
                    .map((host) => (
                      <option key={host.id} value={host.id}>
                        {host.name} ({host.username}@{host.host})
                      </option>
                    ))}
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
            <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2">
              <div>
                <p className="text-xs text-zinc-300">Auto reconnect</p>
                <p className="text-[11px] text-zinc-500">
                  Keep credentials in memory and retry the SSH transport after a drop.
                </p>
              </div>
              <Switch
                checked={form.auto_reconnect ?? true}
                onCheckedChange={(checked) => setForm({ ...form, auto_reconnect: checked })}
              />
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
              {connectTarget.auth === "interactive" ? (
                <Field
                  label="Interactive responses"
                  hint="one per prompt, in order (e.g. password, then OTP); leave blank to see the server prompts"
                >
                  <textarea
                    value={responsesText}
                    onChange={(event) => setResponsesText(event.target.value)}
                    rows={3}
                    className="w-full rounded-md border border-zinc-700 bg-zinc-950/60 px-3 py-2 font-mono text-xs text-zinc-100 focus:border-emerald-500/60 focus:outline-none"
                    placeholder={"password\n123456"}
                  />
                </Field>
              ) : connectTarget.auth === "password" ? (
                <Field label="Password">
                  <Input
                    type="password"
                    autoFocus
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </Field>
              ) : connectTarget.auth === "key" ? (
                <Field label="Key passphrase" hint="leave empty if the key has no passphrase">
                  <Input
                    type="password"
                    autoFocus
                    value={passphrase}
                    onChange={(event) => setPassphrase(event.target.value)}
                  />
                </Field>
              ) : (
                <p className="rounded border border-zinc-800 bg-zinc-950/50 px-3 py-2 text-[11px] text-zinc-400">
                  Authentication uses the SSH agent of the tio-server process.
                </p>
              )}

              {connectJump ? (
                <div className="space-y-2 rounded-lg border border-sky-500/20 bg-sky-500/5 px-3 py-2">
                  <p className="text-[11px] text-sky-200">
                    Jump host: {connectJump.name} ({connectJump.username}@{connectJump.host}:{connectJump.port},{" "}
                    {connectJump.auth})
                  </p>
                  {connectJump.auth === "password" ? (
                    <Field label="Jump host password">
                      <Input
                        type="password"
                        value={jumpPassword}
                        onChange={(event) => setJumpPassword(event.target.value)}
                      />
                    </Field>
                  ) : connectJump.auth === "key" ? (
                    <Field label="Jump host key passphrase" hint="empty if the jump key has no passphrase">
                      <Input
                        type="password"
                        value={jumpPassphrase}
                        onChange={(event) => setJumpPassphrase(event.target.value)}
                      />
                    </Field>
                  ) : (
                    <p className="text-[10px] text-zinc-400">Jump host uses its own agent authentication.</p>
                  )}
                </div>
              ) : null}
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

      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent
          className="w-[min(720px,94vw)]"
          title="Import from ~/.ssh/config"
          description={`Read-only candidates from ${importPath || "~/.ssh/config"}. Secrets are never imported.`}
        >
          {candidates.length === 0 ? (
            <p className="text-xs text-zinc-500">No importable hosts found (missing file, or only wildcard entries).</p>
          ) : (
            <div className="max-h-[55vh] space-y-2 overflow-y-auto">
              {candidates.map((candidate) => (
                <label
                  key={candidate.id}
                  className="flex cursor-pointer items-start gap-3 rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2"
                >
                  <input
                    type="checkbox"
                    className="mt-1 accent-emerald-500"
                    checked={selectedCandidates.has(candidate.id)}
                    onChange={(event) => {
                      const next = new Set(selectedCandidates);
                      if (event.target.checked) next.add(candidate.id);
                      else next.delete(candidate.id);
                      setSelectedCandidates(next);
                    }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-zinc-100">{candidate.name}</span>
                      <Badge tone={candidate.auth === "key" ? "accent" : "default"}>{candidate.auth}</Badge>
                    </div>
                    <p className="truncate font-mono text-[10px] text-zinc-500">
                      {candidate.username}@{candidate.host}:{candidate.port}
                      {candidate.key_file ? ` · ${candidate.key_file}` : ""}
                    </p>
                    {candidate.proxy_jump ? (
                      <p className="text-[10px] text-amber-300">ProxyJump in config: {candidate.proxy_jump} (imported as direct)</p>
                    ) : null}
                  </div>
                </label>
              ))}
            </div>
          )}
          {importError ? <p className="mt-2 text-xs text-red-400">{importError}</p> : null}
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setImportOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={importBusy || selectedCandidates.size === 0}
              onClick={() => void importSelected()}
            >
              {importBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Import {selectedCandidates.size}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(testResult || testError)}
        onOpenChange={(open) => {
          if (!open) {
            setTestResult(null);
            setTestError(null);
          }
        }}
      >
        <DialogContent title="SSH connection test" description="TCP + SSH handshake only; no authentication or command was performed.">
          {testError ? <p className="text-xs text-red-400">{testError}</p> : null}
          {testResult ? (
            <div className="space-y-2 text-xs">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-emerald-400" />
                <span className="text-zinc-200">reachable</span>
                <span className="text-zinc-500">{testResult.remote_version}</span>
              </div>
              <dl className="space-y-1 rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-2 font-mono text-[10px] text-zinc-400">
                <div className="flex justify-between gap-2">
                  <dt>host</dt>
                  <dd className="text-zinc-200">
                    {testResult.host}:{testResult.port}
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt>key type</dt>
                  <dd className="text-zinc-200">{testResult.host_key_type}</dd>
                </div>
                <div className="flex flex-col gap-1">
                  <dt>fingerprint</dt>
                  <dd className="break-all text-zinc-200">{testResult.fingerprint}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt>known_hosts</dt>
                  <dd
                    className={
                      testResult.known_hosts_status === "known"
                        ? "text-emerald-300"
                        : testResult.known_hosts_status === "changed"
                          ? "text-red-400"
                          : "text-amber-300"
                    }
                  >
                    {testResult.known_hosts_status}
                  </dd>
                </div>
              </dl>
              {testResult.known_hosts_status !== "known" ? (
                <div className="space-y-2">
                  <p className="text-[11px] text-zinc-400">
                    Verify the fingerprint out of band, then add it to{" "}
                    <span className="font-mono">{testResult.known_hosts}</span>:
                  </p>
                  <pre className="overflow-x-auto rounded border border-zinc-800 bg-zinc-950 px-2 py-1.5 font-mono text-[10px] text-zinc-300">
                    {`ssh-keyscan -p ${testResult.port} ${testResult.host} >> ${testResult.known_hosts}`}
                  </pre>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      void navigator.clipboard.writeText(
                        `ssh-keyscan -p ${testResult.port} ${testResult.host} >> ${testResult.known_hosts}`,
                      );
                      notify("ssh-keyscan command copied", "success");
                    }}
                  >
                    Copy command
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
