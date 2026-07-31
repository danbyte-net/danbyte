import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"

// Mirrors the monitoring-overview health card, compacted to a dashboard stat
// row. One tenant-scoped read buckets the whole inventory server-side.
interface CertHealth {
  total: number
  expired: number
  expiring_critical: number
  expiring_warning: number
  healthy: number
  self_signed: number
  critical_days: number
  warning_days: number
}

const TONE: Record<string, string> = {
  expired: "text-red-600 dark:text-red-400",
  critical: "text-amber-600 dark:text-amber-400",
  warning: "text-yellow-700 dark:text-yellow-500",
  healthy: "text-emerald-600 dark:text-emerald-400",
  muted: "text-muted-foreground",
}

export function CertHealthWidget() {
  const q = useQuery({
    queryKey: ["dashboard-cert-health"],
    queryFn: () => api<CertHealth>("/api/monitoring/certificates/health/"),
    refetchInterval: 60_000,
  })
  const d = q.data

  if (q.isLoading)
    return (
      <div className="flex h-full min-h-[120px] items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    )
  if (!d || d.total === 0)
    return (
      <div className="flex h-full min-h-[120px] items-center justify-center text-center text-sm text-muted-foreground">
        No certificates yet.
      </div>
    )

  const stats: { label: string; value: number; tone: keyof typeof TONE }[] = [
    { label: "Expired", value: d.expired, tone: "expired" },
    {
      label: `≤ ${d.critical_days}d`,
      value: d.expiring_critical,
      tone: "critical",
    },
    {
      label: `≤ ${d.warning_days}d`,
      value: d.expiring_warning,
      tone: "warning",
    },
    { label: "Healthy", value: d.healthy, tone: "healthy" },
    { label: "Self-signed", value: d.self_signed, tone: "muted" },
  ]

  return (
    <Link
      to="/certificates"
      className="grid h-full grid-cols-3 gap-2 sm:grid-cols-5"
    >
      {stats.map((s) => (
        <div
          key={s.label}
          className="flex flex-col justify-center rounded-md border border-border p-2"
        >
          <span
            className={`text-xl font-semibold tabular-nums ${
              s.value > 0 ? TONE[s.tone] : "text-muted-foreground"
            }`}
          >
            {s.value.toLocaleString()}
          </span>
          <span className="mt-0.5 text-[11px] text-muted-foreground">
            {s.label}
          </span>
        </div>
      ))}
    </Link>
  )
}
