import type { ReactNode } from "react"
import { ExternalLink } from "lucide-react"

import { InfoTip } from "@/components/ui/info-tip"
import { Section } from "@/components/ui/section"
import { TimeCell } from "@/components/cells/time-ago"
import { CheckStatusBadge } from "@/components/monitoring/status-badge"
import { PrtgStateStrip, usePrtgSensorSummary } from "./sensor-strip"
import { sensorTotal, usePrtgLinks } from "./sensors-tab"
import type { PrtgParent } from "./sensors-tab"

/**
 * One row on a device's or VM's Monitoring tab: what PRTG says about it -
 * the roll-up pill, the state badges with their counts, the PRTG device and
 * a link to the Sensors tab, where the sensors themselves are. Absent when
 * PRTG has no device for it (or the integration is off). Like the Zabbix
 * section beside it, it never changes Danbyte's own status.
 */
export function PrtgMonitoringRow({
  parent,
  sensorsLink,
}: {
  parent: PrtgParent
  /** The page's link to its Sensors tab, so the route stays typed. */
  sensorsLink: (children: ReactNode) => ReactNode
}) {
  const links = usePrtgLinks(parent)
  const rows = links.data ?? []
  const summary = usePrtgSensorSummary(parent, rows.length > 0)
  if (rows.length === 0) return null
  const s = summary.data
  return (
    <Section
      title="PRTG"
      badge={
        <InfoTip>
          What PRTG reports about this object. It does not change Danbyte&apos;s
          status.
        </InfoTip>
      }
    >
      <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
        {rows.map((link) => (
          <div
            key={link.id}
            className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 text-[13px]"
            data-testid="prtg-monitoring-row"
          >
            <CheckStatusBadge status={link.state || "unknown"} />
            {s && rows.length === 1 && <PrtgStateStrip summary={s} />}
            <a
              href={link.url}
              target="_blank"
              rel="noreferrer"
              className="link inline-flex items-center gap-1 font-mono text-xs"
            >
              {link.name || link.objid}
              <ExternalLink className="h-3 w-3" />
            </a>
            <span className="ml-auto inline-flex items-center gap-3 text-[11px] whitespace-nowrap text-muted-foreground">
              {link.status_read_at && (
                <span className="inline-flex items-center gap-1">
                  read <TimeCell iso={link.status_read_at} />
                </span>
              )}
              {sensorsLink(
                <>
                  {sensorTotal(link)} sensor
                  {sensorTotal(link) === 1 ? "" : "s"}
                </>
              )}
            </span>
          </div>
        ))}
      </div>
    </Section>
  )
}
