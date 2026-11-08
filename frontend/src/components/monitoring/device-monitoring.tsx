import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { DeviceChecksResponse } from "@/lib/api"
import { ExternalStatusHover } from "./external-status"
import { MixedStatusBadge } from "./mixed-status-badge"

/**
 * A stack member's rolled-up monitoring status as a compact badge, for the
 * member rows of a virtual chassis. Shares the device Monitoring tab's query.
 * A device's own page uses `MonitoringHeaderBadge` (monitoring-bar.tsx).
 * Renders nothing when the device has no monitored IPs.
 */
export function DeviceMonitoringBadge({ deviceId }: { deviceId: string }) {
  const q = useQuery({
    queryKey: ["device-checks", deviceId],
    queryFn: () =>
      api<DeviceChecksResponse>(`/api/monitoring/devices/${deviceId}/checks/`),
  })
  const data = q.data
  const r = data?.rollup
  if (!data || !r || r.monitored_ips === 0 || !r.status) return null
  return (
    <ExternalStatusHover entry={{ ...data, ...r }}>
      <MixedStatusBadge counts={r.counts} status={r.status} />
    </ExternalStatusHover>
  )
}
