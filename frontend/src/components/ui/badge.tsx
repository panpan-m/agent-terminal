import * as React from "react";

import { cn } from "../../lib/utils";
import type { SessionState } from "../../lib/types";

const stateStyles: Record<SessionState, string> = {
  open: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
  opening: "bg-sky-500/15 text-sky-300 ring-sky-500/30",
  reconnecting: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  error: "bg-red-500/15 text-red-300 ring-red-500/30",
  closed: "bg-zinc-700/30 text-zinc-300 ring-zinc-600/40",
  unconfigured: "bg-zinc-700/30 text-zinc-400 ring-zinc-600/40",
};

export function StateBadge({ state, className }: { state: SessionState; className?: string }) {
  return (
    <span
      data-badge=""
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset",
        stateStyles[state] ?? stateStyles.unconfigured,
        className,
      )}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {state}
    </span>
  );
}

export function Badge({
  className,
  tone = "default",
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: "default" | "accent" | "warn" | "danger" }) {
  const tones = {
    default: "bg-zinc-800 text-zinc-300 ring-zinc-700",
    accent: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
    warn: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
    danger: "bg-red-500/15 text-red-300 ring-red-500/30",
  };
  return (
    <span
      data-badge=""
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset",
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}
