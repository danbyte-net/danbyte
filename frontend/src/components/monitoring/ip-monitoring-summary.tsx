import { useQuery } from "@tanstack/react-query"
import { Activity, ArrowRight } from "lucide-react"

import { api, type BulkStatusEntry, type CheckStatus, type IpChecksResponse } from "@/lib/api"
import { useDateFormat } from "@/lib/datetime"
import { MixedStatusBadge } from "./mixed-status-badge"
import { ExternalChips } from "./external-chips"
import { ExternalStatusHover } from "./external-status"
import { ObjectCertExpiryBadge } from "./cert-expiry-badge"

/**
 * Compact monitoring status card for the IP detail Overview tab - the headline
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

  // The same roll-up the prefix's IP list shows for this very address, from
  // the same endpoint field - so opening the address does not lose what the
  // row it was opened from was saying.
  const entry: BulkStatusEntry = {
    status: null,
    checks: checks.length,
    counts,
    problems: q.data?.problems,
    problem_names: q.data?.problem_names,
    unreachable: q.data?.unreachable,
    unreachable_errors: q.data?.unreachable_errors,
    external: q.data?.external,
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border bg-card px-3 py-1.5 text-xs">
      <span className="flex items-center gap-1.5 font-medium text-muted-foreground">
        <Activity className="h-3.5 w-3.5" />
        Monitoring
      </span>
      {checks.length > 0 ? (
        <>
          <ExternalStatusHover entry={entry}>
            <span className="inline-flex items-center gap-1.5">
              <MixedStatusBadge counts={counts} />
              <ExternalChips entry={entry} />
            </span>
          </ExternalStatusHover>
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
      {/* A declared certificate on this IP that is expired/expiring shows here,
          so the Overview flags it without opening the Monitoring tab. */}
      <ObjectCertExpiryBadge objectType="api.ipaddress" objectId={ipId} />
      <button
        type="button"
        onClick={onOpenMonitoring}
        className="link ml-auto inline-flex items-center gap-0.5"
      >
        {checks.length > 0 ? "Open" : "Set up"}
        <ArrowRight className="h-3 w-3" />
      </button>
    </div>
  )
}
