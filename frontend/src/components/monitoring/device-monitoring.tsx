import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { Activity } from "lucide-react"

import { api, type DeviceChecksResponse } from "@/lib/api"
import { MixedStatusBadge } from "./mixed-status-badge"

// Shared query so the header badge, the Overview summary, and the IPs tab all
// dedupe onto one fetch.
function useDeviceChecks(deviceId: string) {
  return useQuery({
    queryKey: ["device-checks", deviceId],
    queryFn: () =>
      api<DeviceChecksResponse>(`/api/monitoring/devices/${deviceId}/checks/`),
  })
}

function rollupTooltip(rollup: DeviceChecksResponse["rollup"]): string {
  const parts = Object.entries(rollup.counts).map(([s, n]) => `${n} ${s}`)
  const head = `${rollup.monitored_ips} monitored IP${
    rollup.monitored_ips === 1 ? "" : "s"
  }`
  return parts.length ? `${head} — ${parts.join(", ")}` : head
}

/**
 * The device's rolled-up monitoring status as a single mixed badge — for the
 * device header, next to the status badge. Renders nothing when the device has
 * no monitored IPs.
 */
export function DeviceMonitoringBadge({ deviceId }: { deviceId: string }) {
  const q = useDeviceChecks(deviceId)
  const r = q.data?.rollup
  if (!r || r.monitored_ips === 0 || !r.status) return null
  return (
    <span title={rollupTooltip(r)} className="inline-flex">
      <MixedStatusBadge counts={r.counts} status={r.status} />
    </span>
  )
}

/**
 * Monitoring summary for a device's Overview: a roll-up across every IP
 * assigned to the device plus a per-IP status grid. Checks attach to IPs (a
 * service's check lives on its IP), so this surfaces both IP and service
 * monitoring. Read-only — checks are managed on each IP's detail page.
 *
 * Renders nothing when the device has no monitored IPs, to keep the Overview
 * uncluttered for devices that aren't monitored.
 */
export function DeviceMonitoring({ deviceId }: { deviceId: string }) {
  const q = useDeviceChecks(deviceId)

  const data = q.data
  if (!data || data.rollup.monitored_ips === 0) return null

  // Cap the inline per-IP list so the strip never wraps past one row; the rest
  // roll up into a "+N more" that links nowhere special (the IPs tab has them).
  const MAX_IPS = 5
  const shownIps = data.ips.slice(0, MAX_IPS)
  const hiddenCount = data.rollup.monitored_ips - shownIps.length

  // Compact: one combined (striped) rollup indicator + per-IP combined
  // indicators as links. No legend, no plain status badges — the mixed badge
  // carries the status. Full breakdown lives on each IP's page.
  return (
    <section className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-border bg-card px-4 py-2.5">
      <h2 className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-foreground uppercase">
        <Activity className="h-3.5 w-3.5 text-muted-foreground" />
        Monitoring
      </h2>
      <MixedStatusBadge
        counts={data.rollup.counts}
        status={data.rollup.status}
      />
      <div className="flex items-center gap-x-4 overflow-hidden">
        {shownIps.map((ip) => (
          <Link
            key={ip.id}
            to="/ips/$id"
            params={{ id: ip.id }}
            className="flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
          >
            <MixedStatusBadge counts={ip.counts} status={ip.status} />
            <span className="font-mono">{ip.ip_address}</span>
          </Link>
        ))}
        {hiddenCount > 0 && (
          <span className="text-[11px] text-muted-foreground">
            +{hiddenCount} more
          </span>
        )}
      </div>
    </section>
  )
}
