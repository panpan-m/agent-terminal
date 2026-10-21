import { useState } from "react";
import { Loader2, Waves } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

export function LoginPage({
  onSubmit,
  error,
}: {
  onSubmit: (username: string, password: string) => Promise<void>;
  error: string | null;
}) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await onSubmit(username, password);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-emerald-500/30 bg-emerald-500/10">
            <Waves className="h-5 w-5 text-emerald-400" />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">tio-server</h1>
            <p className="text-xs text-zinc-500">Shared serial-port gateway</p>
          </div>
        </div>

        <form
          onSubmit={submit}
          className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-6 shadow-2xl backdrop-blur"
        >
          <div className="mb-4">
            <h2 className="text-sm font-semibold text-zinc-100">Operator sign in</h2>
            <p className="mt-1 text-xs text-zinc-500">
              Credentials are printed once by <code className="text-zinc-400">tio-server init</code>.
            </p>
          </div>

          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="username">Username</Label>
              <Input
                id="username"
                autoComplete="username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                autoFocus
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            {error ? (
              <p className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                {error}
              </p>
            ) : null}
            <Button type="submit" variant="primary" className="mt-1" disabled={busy || !password}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Sign in
            </Button>
          </div>
        </form>
        <p className="mt-4 text-center text-[11px] text-zinc-600">
          Binds to 127.0.0.1 by default · MCP at <span className="font-mono">/mcp</span>
        </p>
      </div>
    </div>
  );
}
