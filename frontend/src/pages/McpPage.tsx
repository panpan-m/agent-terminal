import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Copy, Loader2, Plug, RefreshCw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { McpStatus } from "@/lib/types";

function buildPrompt(status: McpStatus): string {
  const toolNames = status.tools.map((tool) => tool.name).join(", ");
  return `Install and connect the tio-server MCP server.

Server:
- Name: tio
- Transport: Streamable HTTP
- URL: ${status.url}
- Auth: Authorization: Bearer <token>
- Token file: ${status.api_token_file} (read it at runtime; never print its contents)
- Server: ${status.server.name} ${status.server.version}
- Tools: ${toolNames}

Steps:
1. Add this server to the MCP configuration of whichever client you are running
   (Claude Desktop, Cursor, Codex, DSH, VS Code, or any other MCP client), using
   the URL and Bearer token above.
2. If your client only supports stdio servers, launch the bundled shim instead:
   command: '${status.shim}'
   args: '--url' '${status.url}' '--token-file' '${status.api_token_file}'
   Example for DSH (append this row to the profile patch):
   - id: mcp-tio
     name: "@deepseek-ai/dsh-mcp-client"
     config:
       serverName: tio
       transport: stdio
       command: '${status.shim}'
       args:
         - '--url'
         - '${status.url}'
         - '--token-file'
         - '${status.api_token_file}'
       toolCallTimeoutMs: 70000
3. Restart or reload the client if its configuration requires it.
4. Verify that the tools above are listed, then call serial_sessions with {} and
   ssh_sessions with {} and show me the serial and SSH sessions.

The token file is a secret: read it at runtime, never print its contents.`;
}

function stdioCommand(status: McpStatus): string {
  return `"${status.shim}" --url "${status.url}" --token-file "${status.api_token_file}"`;
}

export function McpPage({
  notify,
}: {
  notify: (message: string, tone?: "info" | "error" | "success") => void;
}) {
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await api.mcp());
      setError(null);
    } catch (failure) {
      const value = failure as { code?: string; message?: string };
      setError(`${value.code ?? "ERROR"}: ${value.message ?? String(failure)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const prompt = useMemo(() => (status ? buildPrompt(status) : null), [status]);
  const command = useMemo(() => (status ? stdioCommand(status) : null), [status]);

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      notify(`${label} copied`, "success");
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      notify("clipboard is not available in this browser", "error");
    }
  };

  return (
    <div className="mx-auto max-w-6xl px-5 py-6">
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight text-zinc-100">
            <Plug className="h-5 w-5 text-emerald-400" /> MCP
          </h1>
          <p className="mt-1 text-xs text-zinc-500">
            Streamable HTTP endpoint for agents. Copy the install prompt and hand it to your agent.
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Refresh
        </Button>
      </div>

      {error ? (
        <Card className="mb-4 border-red-500/30">
          <CardContent className="px-4 py-3 text-xs text-red-400">{error}</CardContent>
        </Card>
      ) : null}

      {status ? (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Card>
              <CardContent className="py-3.5">
                <p className="text-[10px] uppercase tracking-widest text-zinc-500">status</p>
                <p className="mt-1 flex items-center gap-2 text-lg font-semibold text-emerald-300">
                  <span className="h-2 w-2 rounded-full bg-emerald-400" /> {status.status}
                </p>
                <p className="mt-0.5 text-[11px] text-zinc-500">
                  {status.server.name} {status.server.version}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="py-3.5">
                <p className="text-[10px] uppercase tracking-widest text-zinc-500">transport</p>
                <p className="mt-1 text-sm font-medium text-zinc-200">Streamable HTTP</p>
                <p className="mt-0.5 text-[11px] text-zinc-500">MCP 2.x, stateful sessions</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="py-3.5">
                <p className="text-[10px] uppercase tracking-widest text-zinc-500">auth</p>
                <p className="mt-1 text-sm font-medium text-zinc-200">Bearer token</p>
                <p className="mt-0.5 break-all font-mono text-[10px] text-zinc-500">{status.api_token_file}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="py-3.5">
                <p className="text-[10px] uppercase tracking-widest text-zinc-500">tools</p>
                <p className="mt-1 text-2xl font-semibold text-zinc-100">{status.tools.length}</p>
                <p className="mt-0.5 text-[11px] text-zinc-500">serial + ssh surface</p>
              </CardContent>
            </Card>
          </div>

          <Card className="mb-4">
            <CardHeader className="flex-row items-center justify-between">
              <div>
                <CardTitle>Endpoint</CardTitle>
                <CardDescription>Point any MCP client here; the token stays on this machine.</CardDescription>
              </div>
              <Button size="sm" variant="ghost" onClick={() => void copy(status.url, "endpoint")}>
                {copied === "endpoint" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                Copy URL
              </Button>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex flex-wrap items-center gap-2 rounded-md border border-zinc-800 bg-zinc-950/60 px-3 py-2">
                <code className="font-mono text-xs text-emerald-300">{status.url}</code>
                <Badge tone="accent">bearer</Badge>
                {status.api_token_present ? (
                  <Badge tone="accent">token present</Badge>
                ) : (
                  <Badge tone="warn">token missing</Badge>
                )}
              </div>
              <div className="grid gap-1 text-[11px] text-zinc-500 sm:grid-cols-2">
                <span>
                  token file: <code className="font-mono text-zinc-400">{status.api_token_file}</code>
                </span>
                <span>
                  stdio shim: <code className="font-mono text-zinc-400">{status.shim}</code>
                </span>
              </div>
            </CardContent>
          </Card>

          <Card className="mb-4">
            <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
              <div>
                <CardTitle>Install prompt</CardTitle>
                <CardDescription>
                  Universal: any MCP client can follow it; the DSH row is included as one example.
                </CardDescription>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => command && void copy(command, "stdio command")}
                  disabled={!command}
                  title="copy just the stdio shim command"
                >
                  {copied === "stdio command" ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                  Copy stdio command
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => prompt && void copy(prompt, "prompt")}
                  disabled={!prompt}
                >
                  {copied === "prompt" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  Copy prompt
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <pre
                className={cn(
                  "max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border border-zinc-800",
                  "bg-zinc-950/60 px-3 py-2 font-mono text-[11px] leading-relaxed text-zinc-300",
                )}
              >
                {prompt}
              </pre>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Tools</CardTitle>
              <CardDescription>{status.tools.length} tools published with outputSchema + annotations.</CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-[10px] uppercase tracking-widest text-zinc-500">
                  <tr>
                    <th className="pb-2 pr-4">name</th>
                    <th className="pb-2 pr-4">access</th>
                    <th className="pb-2">description</th>
                  </tr>
                </thead>
                <tbody>
                  {status.tools.map((tool) => (
                    <tr key={tool.name} className="border-t border-zinc-800/70 align-top">
                      <td className="py-2 pr-4 font-mono text-[11px] text-emerald-300">{tool.name}</td>
                      <td className="py-2 pr-4">
                        {tool.read_only ? <Badge tone="accent">read</Badge> : <Badge tone="warn">write</Badge>}
                      </td>
                      <td className="py-2 text-[11px] text-zinc-400">{tool.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </>
      ) : loading ? (
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> loading MCP status…
        </div>
      ) : null}
    </div>
  );
}
