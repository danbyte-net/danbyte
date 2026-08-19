import { useState } from "react"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { IpUptime, UptimeCheck } from "@/lib/api"
import { SimpleTable } from "@/components/ui/simple-table"
import type { SimpleColumn } from "@/components/ui/simple-table"
import { SegmentedTabs } from "@/components/segmented-tabs"

const WINDOWS: { days: number; label: string }[] = [
  { days: 1, label: "24h" },
  { days: 7, label: "7d" },
  { days: 30, label: "30d" },
  { days: 90, label: "90d" },
]

function fmtPct(p: number | null): string {
  return p == null ? "-" : `${p.toFixed(p >= 99.95 ? 2 : 1)}%`
}

// Color tiers mirror the utilization bar: ≥99.9 emerald, ≥99 amber, else red.
function tier(p: number | null): string {
  if (p == null) return "text-muted-foreground"
  if (p >= 99.9) return "text-emerald-600 dark:text-emerald-400"
  if (p >= 99) return "text-amber-600 dark:text-amber-400"
  return "text-red-600 dark:text-red-400"
}

function fmtDuration(s: number | null): string {
  if (s == null) return "-"
  if (s < 90) return `${Math.round(s)}s`
  const m = s / 60
  if (m < 90) return `${Math.round(m)}m`
  const h = m / 60
  if (h < 36) return `${h.toFixed(1)}h`
  return `${(h / 24).toFixed(1)}d`
}

const COLUMNS: SimpleColumn<UptimeCheck>[] = [
  {
    id: "check",
    header: "Check",
    flex: true,
    cell: (c) => (
      <>
        {c.template_name ?? c.kind}{" "}
        <span className="font-mono text-[10px] text-muted-foreground uppercase">
          {c.kind}
        </span>
      </>
    ),
  },
  {
    id: "uptime",
    header: "Uptime",
    align: "right",
    cell: (c) => (
      <span className={`num font-medium ${tier(c.uptime_pct)}`}>
        {fmtPct(c.uptime_pct)}
      </span>
    ),
  },
  {
    id: "incidents",
    header: "Incidents",
    align: "right",
    cell: (c) => (
      <span className="num text-muted-foreground">{c.incidents}</span>
    ),
  },
  {
    id: "mttr",
    header: "MTTR",
    align: "right",
    cell: (c) => (
      <span className="num text-muted-foreground">
        {fmtDuration(c.mttr_seconds)}
      </span>
    ),
  },
  {
    id: "downtime",
    header: "Downtime",
    align: "right",
    cell: (c) => (
      <span className="num text-muted-foreground">
        {fmtDuration(c.down_seconds)}
      </span>
    ),
  },
]

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
        <SegmentedTabs
          className="ml-auto"
          value={String(days)}
          onValueChange={(v) => setDays(Number(v))}
          items={WINDOWS.map((w) => ({
            value: String(w.days),
            label: w.label,
          }))}
        />
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
            <div className="mt-3">
              <SimpleTable
                columns={COLUMNS}
                data={data.checks}
                getRowKey={(c) => c.template_id}
              />
            </div>
          )}
        </>
      )}
    </div>
  )
}
