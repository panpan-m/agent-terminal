import { useState } from "react";
import { Check, ClipboardCopy } from "lucide-react";

import { writeClipboardText } from "@/lib/terminal-setup";
import { cn } from "@/lib/utils";

/** One shell command line with a copy button (clipboard bridge aware). */
function CopyLine({ command, label }: { command: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-1.5">
      {label ? <span className="w-16 shrink-0 text-[10px] text-zinc-500">{label}</span> : null}
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-[10px] text-zinc-300">
        {command}
      </code>
      <button
        type="button"
        aria-label={copied ? "copied" : "copy command"}
        onClick={() => {
          void writeClipboardText(command).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          });
        }}
        className={cn(
          "shrink-0 rounded p-1 transition-colors",
          copied ? "text-emerald-300" : "text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200",
        )}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <ClipboardCopy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

/**
 * Remediation steps shown when an SSH host key no longer matches known_hosts
 * (connect error with expected/actual fingerprints, or a test reporting
 * "changed").  The app never accepts a changed key automatically — these are
 * the manual steps.
 */
export function HostKeyHelp({
  host,
  port,
  knownHostsFile,
}: {
  host: string;
  port: number;
  knownHostsFile?: string;
}) {
  const file = knownHostsFile || "~/.ssh/known_hosts";
  const lookup = port === 22 ? host : `[${host}]:${port}`;
  const scan = port === 22 ? `ssh-keyscan ${host} >> ${file}` : `ssh-keyscan -p ${port} ${host} >> ${file}`;
  return (
    <div className="space-y-1.5 rounded border border-amber-500/30 bg-amber-500/5 px-2.5 py-2 text-[10px] text-zinc-400">
      <p className="text-[11px] font-medium text-amber-200">Host key changed — how to fix</p>
      <p>
        The machine at <span className="font-mono text-zinc-300">{lookup}</span> now presents a different host key.
        Usually the OS was reinstalled, the board reflashed, or the IP now belongs to another device. This app never
        accepts a changed key automatically.
      </p>
      <p>
        <span className="text-zinc-300">1.</span> Verify out of band — run this on the machine itself (serial/VM
        console); the fingerprint must equal <span className="text-amber-200">actual</span> above:
      </p>
      <CopyLine command="ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub" label="on the server" />
      <p>
        <span className="text-zinc-300">2.</span> Then on <span className="text-zinc-300">this PC</span> (Git Bash) —
        drop the stale entry, re-scan, confirm:
      </p>
      <CopyLine command={`ssh-keygen -R ${lookup}`} label="remove old" />
      <CopyLine command={scan} label="re-scan" />
      <CopyLine command={`ssh-keygen -lf ${file} | grep ${host}`} label="verify" />
      <p>
        <span className="text-zinc-300">3.</span> Reconnect here.
      </p>
      <p className="text-red-300/80">
        If nothing changed on the machine — especially for public hosts — do not update the entry; investigate first
        (possible man-in-the-middle).
      </p>
    </div>
  );
}
