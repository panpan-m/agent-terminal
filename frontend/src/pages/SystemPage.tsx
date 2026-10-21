import { useState } from "react";
import { Check, Copy, ExternalLink, RefreshCw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { SessionStatus, SystemInfo } from "@/lib/types";
import { formatUptime } from "@/lib/utils";

function Copyable({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[11px] text-zinc-300 hover:bg-zinc-800"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          /* ignore */
        }
      }}
    >
      {copied ? <Check className="h-3 w-3 px-0 text-emerald-400" /> : <Copy className="h-3 w-3" />}
      {value}
    </button>
  );
}

export function SystemPage({
  system,
  sessions,
  refresh,
}: {
  system: SystemInfo | null;
  sessions: SessionStatus[];
  refresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  if (!system) {
    return <div className="px-5 py-10 text-center text-sm text-zinc-500">Loading system information…</div>;
  }
  const mcpUrl = `${window.location.protocol}//${window.location.host}/mcp`;

  return (
    <div className="mx-auto max-w-5xl px-5 py-6">
      <div className="mb-5 flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-zinc-100">System</h1>
          <p className="mt-1 text-xs text-zinc-500">Deployment facts, MCP wiring and the ttyd supervisor.</p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await refresh();
            } finally {
              setBusy(false);
            }
          }}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Runtime</CardTitle>
            <CardDescription>Everything stays on this host unless you put a TLS proxy in front.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-1.5 text-xs">
            <Row label="Version" value={`v${system.version}`} />
            <Row label="Uptime" value={formatUptime(system.uptime_seconds)} />
            <Row label="Platform" value={`${system.platform} · Python ${system.python}`} />
            <Row label="Bind" value={`${system.bind}:${system.port}`} />
            <Row label="Config" value={system.config_path ?? "—"} mono />
            <Row label="Data dir" value={system.data_dir} mono />
            <Row label="Log dir" value={system.log_dir} mono />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>MCP</CardTitle>
            <CardDescription>Streamable HTTP endpoint for agents; bearer token required.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-xs">
            <Row label="Endpoint" value="" custom={<Copyable value={mcpUrl} />} />
            <Row label="Token" value={`${system.data_dir}/api-token`} mono />
            <Row label="stdio" value="tio-mcp --url <endpoint> --token-file <token>" mono />
            <div className="mt-2 rounded-md border border-zinc-800 bg-zinc-950/50 p-2.5 font-mono text-[10.5px] leading-relaxed text-zinc-400">
              {`curl -s ${mcpUrl} \\
  -H "Authorization: Bearer $(cat api-token)" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`}
            </div>
            <p className="text-[11px] text-zinc-500">
              Tools: serial_sessions · serial_status · serial_read · serial_write · serial_break · serial_command · serial_expect
            </p>
          </CardContent>
        </Card>

        <Card className="md:col-span-2">
          <CardHeader className="flex-row items-center justify-between">
            <div>
              <CardTitle>Browser terminal (ttyd)</CardTitle>
              <CardDescription>
                Two entries per session: read-only view and authenticated control. The bridge is a separate process.
              </CardDescription>
            </div>
            <Badge tone={system.ttyd.available ? "accent" : "warn"}>
              {system.ttyd.available ? `ttyd ${system.ttyd.version ?? ""}` : "ttyd not installed"}
            </Badge>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-xs">
            <Row label="Enabled" value={system.ttyd.enabled ? "yes" : "no (config ttyd.enabled)"} />
            <Row label="Binary" value={system.ttyd.binary ?? "not found"} mono />
            {system.ttyd.instances.length === 0 ? (
              <p className="rounded-md border border-dashed border-zinc-800 px-3 py-4 text-center text-[11px] text-zinc-500">
                No ttyd process running. Install ttyd, set <code className="text-zinc-400">ttyd.enabled = true</code>{" "}
                and restart the server (or start an entry from the session card).
              </p>
            ) : (
              <table className="w-full text-left text-[11px]">
                <thead className="text-zinc-500">
                  <tr>
                    <th className="py-1 font-medium">session</th>
                    <th className="py-1 font-medium">mode</th>
                    <th className="py-1 font-medium">port</th>
                    <th className="py-1 font-medium">pid</th>
                    <th className="py-1 font-medium">open</th>
                  </tr>
                </thead>
                <tbody className="font-mono text-zinc-300">
                  {system.ttyd.instances.map((instance) => (
                    <tr key={`${instance.session_id}-${instance.mode}`} className="border-t border-zinc-800/60">
                      <td className="py-1.5">{instance.session_id}</td>
                      <td>{instance.mode}</td>
                      <td>{instance.port}</td>
                      <td>{instance.pid}</td>
                      <td>
                        <a
                          className="inline-flex items-center gap-1 text-emerald-300 hover:underline"
                          href={instance.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {instance.alive ? "alive" : "dead"} <ExternalLink className="h-3 w-3" />
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>

        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle>Sessions</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-left text-[11px]">
              <thead className="text-zinc-500">
                <tr>
                  <th className="px-5 py-2 font-medium">id</th>
                  <th className="px-5 py-2 font-medium">port</th>
                  <th className="px-5 py-2 font-medium">state</th>
                  <th className="px-5 py-2 font-medium">owner</th>
                  <th className="px-5 py-2 font-medium">rx</th>
                  <th className="px-5 py-2 font-medium">tx</th>
                </tr>
              </thead>
              <tbody>
                {sessions.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-5 py-6 text-center text-zinc-500">
                      none
                    </td>
                  </tr>
                ) : null}
                {sessions.map((session) => (
                  <tr key={session.session_id} className="border-t border-zinc-800/60 font-mono text-zinc-300">
                    <td className="px-5 py-1.5">{session.session_id}</td>
                    <td className="px-5 py-1.5">{session.port}</td>
                    <td className="px-5 py-1.5">{session.state}</td>
                    <td className="px-5 py-1.5">{session.control_owner}</td>
                    <td className="px-5 py-1.5">{session.rx_bytes}</td>
                    <td className="px-5 py-1.5">{session.tx_bytes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  mono,
  custom,
}: {
  label: string;
  value: string;
  mono?: boolean;
  custom?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="shrink-0 text-zinc-500">{label}</span>
      {custom ?? (
        <span className={`truncate text-right text-zinc-300 ${mono ? "font-mono text-[11px]" : ""}`}>{value}</span>
      )}
    </div>
  );
}
