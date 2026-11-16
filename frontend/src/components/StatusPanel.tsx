import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn, formatBytes, formatNumber } from "@/lib/utils";
import type { SessionStatus } from "@/lib/types";
import { useT } from "@/lib/i18n";

export function StatusPanel({ session }: { session: SessionStatus }) {
  const t = useT();
  const lease = session.lease;
  const rows: [string, string][] = [
    [t("port"), session.port],
    [t("state"), t(session.state)],
    [t("control"), t(session.control_owner)],
    [
      t("lease"),
      lease ? `${lease.label} · ${Math.ceil(lease.remaining_ms / 1000)}s` : t("free"),
    ],
    [t("rx / tx"), `${formatNumber(session.rx_bytes)} / ${formatNumber(session.tx_bytes)}`],
    [t("buffer"), `${formatBytes(session.buffer_bytes)} (${formatBytes(session.lost_bytes)} ${t("lost")})`],
    [t("reconnects"), String(session.reconnect_count)],
    [t("opened"), session.opened_at ? new Date(session.opened_at).toLocaleTimeString() : "—"],
    [t("last error"), session.last_error ?? t("none")],
  ];
  const lineKeys: ("dtr" | "rts" | "cts" | "dsr" | "cd" | "ri")[] = ["dtr", "rts", "cts", "dsr", "cd", "ri"];

  return (
    <Card className="rounded-lg">
      <CardHeader className="px-4 py-2.5">
        <CardTitle className="text-[11px] uppercase tracking-widest text-zinc-400">{t("status")}</CardTitle>
      </CardHeader>
      <CardContent className="px-4 py-3">
        <dl className="grid grid-cols-1 gap-1 text-[11px]">
          {rows.map(([key, value]) => (
            <div key={key} className="flex items-center justify-between gap-3">
              <dt className="text-zinc-500">{key}</dt>
              <dd className="truncate font-mono text-zinc-300">{value}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {lineKeys.map((key) => {
            const value = session.lines?.[key];
            return (
              <span
                key={key}
                className={cn(
                  "rounded border px-1.5 py-0.5 font-mono text-[10px]",
                  value
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                    : "border-zinc-700 bg-zinc-900 text-zinc-500",
                )}
              >
                {key.toUpperCase()} {value ? 1 : 0}
              </span>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
