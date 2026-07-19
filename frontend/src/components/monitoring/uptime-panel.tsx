import { useState } from "react"
import { useQuery } from "@tanstack/react-query"

import { api, type IpUptime } from "@/lib/api"

const WINDOWS: { days: number; label: string }[] = [
  { days: 1, label: "24h" },
  { days: 7, label: "7d" },
  { days: 30, label: "30d" },
  { days: 90, label: "90d" },
]

function fmtPct(p: number | null): string {
  return p == null ? "—" : `${p.toFixed(p >= 99.95 ? 2 : 1)}%`
}

// Color tiers mirror the utilization bar: ≥99.9 emerald, ≥99 amber, else red.
function tier(p: number | null): string {
  if (p == null) return "text-muted-foreground"
  if (p >= 99.9) return "text-emerald-600 dark:text-emerald-400"
  if (p >= 99) return "text-amber-600 dark:text-amber-400"
  return "text-red-600 dark:text-red-400"
}

function fmtDuration(s: number | null): string {
  if (s == null) return "—"
  if (s < 90) return `${Math.round(s)}s`
  const m = s / 60
  if (m < 90) return `${Math.round(m)}m`
  const h = m / 60
  if (h < 36) return `${h.toFixed(1)}h`
  return `${(h / 24).toFixed(1)}d`
}

export function UptimePanel({ ipId }: { ipId: string }) {
  const [days, setDays] = useState(30)
  const q = useQuery({
    queryKey: ["ip-uptime", ipId, days],
    queryFn: () =>
      api<IpUptime>(`/api/monitoring/ips/${ipId}/uptime/?days=${days}`),
  })

  const data = q.data
  const hasChecks = (data?.checks.length ?? 0) > 0
  if (q.isSuccess && !hasChecks) return null

  return (
    <div className="mb-3 rounded-lg border border-border bg-card p-3">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          Uptime (SLA)
        </h3>
        <div className="ml-auto flex items-center gap-0.5 rounded-md border border-border p-0.5">
          {WINDOWS.map((w) => (
            <button
              key={w.days}
              type="button"
              onClick={() => setDays(w.days)}
              className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
                days === w.days
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {data && (
        <>
          <div className="flex items-baseline gap-3">
            <span
              className={`num text-3xl font-semibold tracking-tight ${tier(data.overall_uptime_pct)}`}
            >
              {fmtPct(data.overall_uptime_pct)}
            </span>
            <span className="text-[11px] text-muted-foreground">
              overall · {data.total_incidents} incident
              {data.total_incidents === 1 ? "" : "s"} · {data.measured_checks}{" "}
              of {data.checks.length} check{data.checks.length === 1 ? "" : "s"}{" "}
              measured
            </span>
          </div>

          {data.checks.length > 1 && (
            <table className="mt-3 w-full text-left text-[12px]">
              <thead className="text-[10px] tracking-[0.06em] text-muted-foreground uppercase">
                <tr>
                  <th className="py-1 font-medium">Check</th>
                  <th className="py-1 text-right font-medium">Uptime</th>
                  <th className="py-1 text-right font-medium">Incidents</th>
                  <th className="py-1 text-right font-medium">MTTR</th>
                  <th className="py-1 text-right font-medium">Downtime</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.checks.map((c) => (
                  <tr key={c.template_id}>
                    <td className="py-1">
                      {c.template_name ?? c.kind}{" "}
                      <span className="font-mono text-[10px] text-muted-foreground uppercase">
                        {c.kind}
                      </span>
                    </td>
                    <td
                      className={`num py-1 text-right font-medium ${tier(c.uptime_pct)}`}
                    >
                      {fmtPct(c.uptime_pct)}
                    </td>
                    <td className="num py-1 text-right text-muted-foreground">
                      {c.incidents}
                    </td>
                    <td className="num py-1 text-right text-muted-foreground">
                      {fmtDuration(c.mttr_seconds)}
                    </td>
                    <td className="num py-1 text-right text-muted-foreground">
                      {fmtDuration(c.down_seconds)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  )
}
