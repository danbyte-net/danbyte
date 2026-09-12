import { Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { DeviceChecksResponse, DeviceTimeline } from "@/lib/api"
import { EmptyState } from "@/components/empty-state"
import { Section } from "@/components/ui/section"
import { Button } from "@/components/ui/button"
import { apiErrorToast } from "@/lib/api-toast"
import { ExternalChips } from "./external-chips"
import { ExternalStatusHover } from "./external-status"
import { HistoryPanel } from "./history-panel"
import { MixedStatusBadge } from "./mixed-status-badge"
import { NotifyMeButton } from "./notify-me-button"
import { StatusStrip } from "./status-strip"
import { ZabbixHostPanel } from "./zabbix-host-panel"

/**
 * A device's Monitoring tab: the roll-up across its addresses with seven days
 * of status to scale, one row per monitored address with its own strip, then
 * the History panel with the changes behind the strips. Checks live on the
 * addresses, so the rows link there; what Zabbix says about the host sits
 * beside Danbyte's own status, never folded into it.
 */
export function DeviceChecksPanel({ deviceId }: { deviceId: string }) {
  const qc = useQueryClient()
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

  const confirmCalm = useMutation({
    mutationFn: () =>
      api<{ cleared: number }>(
        `/api/monitoring/devices/${deviceId}/flapping/clear/`,
        { method: "POST", body: "{}" }
      ),
    onSuccess: (d) => {
      toast.success(
        d.cleared === 1
          ? "Confirmed not flapping"
          : `Confirmed ${d.cleared} checks`
      )
      qc.invalidateQueries({ queryKey: ["device-checks", deviceId] })
      qc.invalidateQueries({ queryKey: ["monitoring-flapping"] })
      // Every list's monitoring column reads the same roll-up.
      qc.invalidateQueries({
        predicate: (q) => String(q.queryKey[0]).endsWith("-mon-status"),
      })
    },
    onError: (err) => apiErrorToast(err),
  })

  const data = checks.data
  if (checks.isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>
  if (!data || data.rollup.monitored_ips === 0)
    return (
      <div className="space-y-6">
        <EmptyState title="No monitored addresses.">
          Checks attach to an address. Open one of this device&apos;s IPs and
          add a check, or let a monitoring policy cover it.
        </EmptyState>
        {/* A host Zabbix watches is worth showing even before Danbyte
            monitors any of its addresses itself. */}
        <ZabbixHostPanel scope={{ device: deviceId }} />
      </div>
    )

  const tl = timeline.data
  const stripFor = (ipId: string) => tl?.ips.find((i) => i.id === ipId)?.rollup

  return (
    <div className="space-y-6">
      {/* The same three sections the address's tab has, in the same
          frame: Section heading outside, one card inside. The device's
          seven-day strip is the History section's job; here each address
          is a row you can open. */}
      <Section
        title="Addresses"
        count={data.rollup.monitored_ips}
        badge={
          <>
            <ExternalStatusHover entry={{ ...data, ...data.rollup }}>
              <MixedStatusBadge
                counts={data.rollup.counts}
                status={data.rollup.status}
              />
            </ExternalStatusHover>
            <ExternalChips entry={{ ...data, ...data.rollup }} />
          </>
        }
        description={
          data.rollup.total_ips > data.rollup.monitored_ips
            ? `${data.rollup.total_ips - data.rollup.monitored_ips} not monitored`
            : undefined
        }
        actions={
          <>
            {(data.rollup.flapping ?? 0) > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => confirmCalm.mutate()}
                disabled={confirmCalm.isPending}
              >
                {confirmCalm.isPending ? "Confirming…" : "Confirm not flapping"}
              </Button>
            )}
            <NotifyMeButton device={deviceId} />
          </>
        }
      >
        <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
          {data.ips.map((ip) => {
            const segs = stripFor(ip.id)
            return (
              <div
                key={ip.id}
                className="flex items-center gap-3 px-3 py-2 text-[13px]"
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
                      scope={{ ip: ip.id }}
                    />
                  )}
                </span>
                <span className="w-16 shrink-0 text-right text-[11px] text-muted-foreground">
                  {ip.checks} check{ip.checks === 1 ? "" : "s"}
                </span>
              </div>
            )
          })}
          {data.truncated && (
            <p className="px-3 py-1.5 text-[11px] text-muted-foreground">
              Showing the first {data.ips.length} addresses.
            </p>
          )}
        </div>
      </Section>

      <ZabbixHostPanel scope={{ device: deviceId }} />
      <HistoryPanel scope={{ device: deviceId }} />
    </div>
  )
}
