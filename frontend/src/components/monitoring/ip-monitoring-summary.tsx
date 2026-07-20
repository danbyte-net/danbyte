import { useQuery } from "@tanstack/react-query"
import { Activity, ArrowRight } from "lucide-react"

import { api, type CheckStatus, type IpChecksResponse } from "@/lib/api"
import { useDateFormat } from "@/lib/datetime"
import { MixedStatusBadge } from "./mixed-status-badge"

/**
 * Compact monitoring status card for the IP detail Overview tab — the headline
 * status at a glance, with a jump to the full Monitoring tab. The heavy lifting
 * (per-check rows, add/remove, uptime) lives in <IpMonitoring/>.
 */
export function IpMonitoringSummary({
  ipId,
  lastSeen,
  onOpenMonitoring,
}: {
  ipId: string
  lastSeen?: string | null
  onOpenMonitoring: () => void
}) {
  const q = useQuery({
    queryKey: ["ip-checks", ipId],
    queryFn: () => api<IpChecksResponse>(`/api/monitoring/ips/${ipId}/checks/`),
  })
  const { formatDate } = useDateFormat()
  const checks = q.data?.checks ?? []
  const counts = checks.reduce<Partial<Record<CheckStatus, number>>>(
    (acc, c) => {
      const s = c.state?.status ?? "unknown"
      acc[s] = (acc[s] ?? 0) + 1
      return acc
    },
    {}
  )

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border bg-card px-3 py-1.5 text-xs">
      <span className="flex items-center gap-1.5 font-medium text-muted-foreground">
        <Activity className="h-3.5 w-3.5" />
        Monitoring
      </span>
      {checks.length > 0 ? (
        <>
          <MixedStatusBadge counts={counts} />
          <span className="text-muted-foreground">
            <span className="num text-foreground">{checks.length}</span> check
            {checks.length === 1 ? "" : "s"}
          </span>
          {lastSeen && (
            <span className="text-muted-foreground">
              · seen {formatDate(lastSeen)}
            </span>
          )}
        </>
      ) : (
        <span className="text-muted-foreground">Not monitored</span>
      )}
      <button
        type="button"
        onClick={onOpenMonitoring}
        className="ml-auto inline-flex items-center gap-0.5 text-primary hover:underline"
      >
        {checks.length > 0 ? "Open" : "Set up"}
        <ArrowRight className="h-3 w-3" />
      </button>
    </div>
  )
}
