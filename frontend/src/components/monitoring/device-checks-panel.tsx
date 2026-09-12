import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { Activity } from "lucide-react"

import { api } from "@/lib/api"
import type { DeviceChecksResponse, DeviceTimeline } from "@/lib/api"
import { EmptyState } from "@/components/empty-state"
import { ExternalChips } from "./external-chips"
import { ExternalStatusHover } from "./external-status"
import { HistoryPanel } from "./history-panel"
import { MixedStatusBadge } from "./mixed-status-badge"
import { NotifyMeButton } from "./notify-me-button"
import { StatusStrip } from "./status-strip"

/**
 * A device's Monitoring tab: the roll-up across its addresses with seven days
 * of status to scale, one row per monitored address with its own strip, then
 * the History panel with the changes behind the strips. Checks live on the
 * addresses, so the rows link there; what Zabbix says about the host sits
 * beside Danbyte's own status, never folded into it.
 */
export function DeviceChecksPanel({ deviceId }: { deviceId: string }) {
  const checks = useQuery({
    queryKey: ["device-checks", deviceId],
    queryFn: () =>
      api<DeviceChecksResponse>(`/api/monitoring/devices/${deviceId}/checks/`),
  })
  const timeline = useQuery({
    queryKey: ["monitoring-timeline", `devices/${deviceId}`, 7],
    queryFn: () =>
      api<DeviceTimeline>(
        `/api/monitoring/devices/${deviceId}/timeline/?days=7`
      ),
  })

  const data = checks.data
  if (checks.isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>
  if (!data || data.rollup.monitored_ips === 0)
    return (
      <EmptyState title="No monitored addresses.">
        Checks attach to an address. Open one of this device&apos;s IPs and add
        a check, or let a monitoring policy cover it.
      </EmptyState>
    )

  const tl = timeline.data
  const stripFor = (ipId: string) => tl?.ips.find((i) => i.id === ipId)?.rollup

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-border bg-card">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
          <h2 className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-foreground uppercase">
            <Activity className="h-3.5 w-3.5 text-muted-foreground" />
            Monitoring
          </h2>
          <ExternalStatusHover entry={{ ...data, ...data.rollup }}>
            <MixedStatusBadge
              counts={data.rollup.counts}
              status={data.rollup.status}
            />
          </ExternalStatusHover>
          <ExternalChips entry={{ ...data, ...data.rollup }} />
          <span className="text-[11px] text-muted-foreground">
            {data.rollup.monitored_ips} of {data.rollup.total_ips} address
            {data.rollup.total_ips === 1 ? "" : "es"} monitored
          </span>
          <div className="ml-auto">
            <NotifyMeButton device={deviceId} />
          </div>
        </div>
        {tl && (
          <div className="border-t border-border px-4 py-2.5">
            <StatusStrip
              segments={tl.rollup}
              since={tl.since}
              until={tl.until}
              height={10}
            />
            <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
              <span>7 days ago</span>
              <span>now</span>
            </div>
          </div>
        )}
        <div className="divide-y divide-border border-t border-border">
          {data.ips.map((ip) => {
            const segs = stripFor(ip.id)
            return (
              <div
                key={ip.id}
                className="flex items-center gap-3 px-4 py-2 text-[13px]"
              >
                <ExternalStatusHover entry={ip}>
                  <MixedStatusBadge counts={ip.counts} status={ip.status} />
                </ExternalStatusHover>
                <Link
                  to="/ips/$id"
                  params={{ id: ip.id }}
                  search={{ tab: "monitoring" }}
                  className="link w-36 shrink-0 font-mono"
                >
                  {ip.ip_address}
                </Link>
                <ExternalChips entry={ip} />
                <span className="min-w-0 flex-1">
                  {tl && segs && (
                    <StatusStrip
                      segments={segs}
                      since={tl.since}
                      until={tl.until}
                    />
                  )}
                </span>
                <span className="w-16 shrink-0 text-right text-[11px] text-muted-foreground">
                  {ip.checks} check{ip.checks === 1 ? "" : "s"}
                </span>
              </div>
            )
          })}
        </div>
        {data.truncated && (
          <p className="border-t border-border px-4 py-1.5 text-[11px] text-muted-foreground">
            Showing the first {data.ips.length} addresses.
          </p>
        )}
      </section>

      <HistoryPanel scope={{ device: deviceId }} />
    </div>
  )
}
