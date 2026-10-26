import { useState } from "react"
import type { ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { ExternalLink } from "lucide-react"

import { api } from "@/lib/api"
import type { PrtgDeviceLink, PrtgPlanEntry, PrtgSync } from "@/lib/api"
import { useDateFormat } from "@/lib/datetime"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { InfoTip } from "@/components/ui/info-tip"
import { Section } from "@/components/ui/section"
import { TimeCell } from "@/components/cells/time-ago"
import { EmptyState } from "@/components/empty-state"
import { KvCard } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import {
  MonitoringSourceRow,
  prtgSource,
} from "@/components/monitoring/monitoring-bar"
import { useStatusLabels } from "@/components/monitoring/status-palette"
import { usePrtgEnabled } from "./group-picker"
import { PRTG_PLAN_FOOTNOTE, PrtgIssueLine } from "./issues"
import { sensorTotal, usePrtgLinks, usePrtgSensors } from "./sensors-tab"
import type { PrtgParent } from "./sensors-tab"

/**
 * One row on a device's or VM's Monitoring tab: what PRTG says about it, as
 * the monitoring bar's PRTG source row - the state pill, the counts with
 * their sensors in the hover, the PRTG device and when it was read - then a
 * link to the Sensors tab. A count opens that tab filtered to its state.
 * With no PRTG device it only offers the plan preview, and it is absent
 * while the integration is off. Like the Zabbix section beside it, it never
 * changes Danbyte's own status.
 */
export function PrtgMonitoringRow({
  parent,
  sensorsLink,
  prtgSync,
}: {
  parent: PrtgParent
  /** The page's link to its Sensors tab, so the route stays typed;
   * `state` is the filter a count opens it with. */
  sensorsLink: (children: ReactNode, state?: string) => ReactNode
  /** The object's own PRTG setting, for the Exclude chip. */
  prtgSync?: PrtgSync
}) {
  const labels = useStatusLabels()
  const links = usePrtgLinks(parent)
  const enabled = usePrtgEnabled()
  const { formatDateTime } = useDateFormat()
  const rows = links.data ?? []
  const sensors = usePrtgSensors(parent, rows.length > 0)
  if (rows.length === 0 && !enabled) return null
  const excluded =
    prtgSync === "never" ? <Badge variant="secondary">Exclude</Badge> : null
  return (
    <Section
      title="PRTG"
      badge={
        <InfoTip>
          What PRTG reports about this object. It does not change Danbyte&apos;s
          status.
        </InfoTip>
      }
      actions={<PrtgPlanButton parent={parent} />}
    >
      {rows.length === 0 ? (
        <div className="inline-flex items-center gap-2 text-[13px] text-muted-foreground">
          <span>No PRTG device.</span>
          {excluded}
        </div>
      ) : (
        <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
          {rows.map((link) => (
            <div
              key={link.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2"
              data-testid="prtg-monitoring-row"
            >
              <MonitoringSourceRow
                className="min-w-0 flex-1"
                source={{
                  ...prtgSource(link, sensors.data ?? undefined, labels),
                  extra: (
                    <>
                      {excluded}
                      {link.created_here && (
                        <Badge
                          variant="secondary"
                          className="whitespace-nowrap"
                        >
                          Created by Danbyte
                        </Badge>
                      )}
                      {pausedUntil(link) && (
                        <Badge
                          variant="secondary"
                          className="whitespace-nowrap"
                        >
                          Paused by maintenance until{" "}
                          {formatDateTime(pausedUntil(link))}
                        </Badge>
                      )}
                    </>
                  ),
                }}
                link={sensorsLink}
              />
              <span className="text-[11px] whitespace-nowrap text-muted-foreground">
                {sensorsLink(
                  <span className="link">
                    {sensorTotal(link)} sensor
                    {sensorTotal(link) === 1 ? "" : "s"}
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </Section>
  )
}

/** Until when Danbyte holds the PRTG device paused for a window, or "" when
 * it does not now. */
function pausedUntil(link: PrtgDeviceLink): string {
  const until = link.maintenance_paused_until
  return until && new Date(until).getTime() > Date.now() ? until : ""
}

const VIA: Record<string, string> = {
  policy: "Policy",
  always: "Monitor in PRTG",
  register_all: "Register all",
  never: "Excluded",
}

/** "What would PRTG get?" - the plan for one object, read on open. */
export function PrtgPlanButton({ parent }: { parent: PrtgParent }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        What would PRTG get?
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="2xl" className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>What PRTG would get</DialogTitle>
          </DialogHeader>
          {open && <PrtgPlanPreview parent={parent} />}
        </DialogContent>
      </Dialog>
    </>
  )
}

export function PrtgPlanPreview({ parent }: { parent: PrtgParent }) {
  const qs =
    "device" in parent
      ? `device=${parent.device}`
      : `virtual_machine=${parent.virtual_machine}`
  const plan = useQuery({
    queryKey: ["prtg-plan", qs],
    queryFn: () => api<PrtgPlanEntry[]>(`/api/prtg/plan/?${qs}`),
  })
  if (plan.isLoading) return <Loading />
  if (plan.isError) return <QueryError error={plan.error} />
  const entries = plan.data ?? []
  if (entries.length === 0)
    return <EmptyState title="No PRTG connection">Nothing to plan.</EmptyState>
  return (
    <div className="grid gap-4">
      {entries.map((e) => (
        <PlanEntry
          key={e.connection.id}
          entry={e}
          many={entries.length > 1}
          parent={parent}
        />
      ))}
      <p className="text-[11px] text-muted-foreground">{PRTG_PLAN_FOOTNOTE}</p>
    </div>
  )
}

function PlanEntry({
  entry: e,
  many,
  parent,
}: {
  entry: PrtgPlanEntry
  many: boolean
  parent: PrtgParent
}) {
  const object =
    "device" in parent
      ? { kind: "device" as const, id: parent.device }
      : { kind: "virtual_machine" as const, id: parent.virtual_machine }
  const issues = e.issues ?? e.problems.map((text) => ({ text }))
  const rows: KvRow[] = [
    {
      label: "In PRTG",
      value: e.managed ? (
        <Badge variant="success">{VIA[e.via] ?? e.via}</Badge>
      ) : (
        <span className="inline-flex flex-wrap items-center gap-2">
          <Badge variant="secondary">{VIA[e.via] ?? "No"}</Badge>
          {e.reason_issue ? (
            <PrtgIssueLine
              issue={e.reason_issue}
              object={object}
              className="text-xs text-muted-foreground"
            />
          ) : (
            e.reason && (
              <span className="text-xs text-muted-foreground">{e.reason}</span>
            )
          )}
        </span>
      ),
    },
  ]
  if (e.policies.length)
    rows.push({
      label: "Policies",
      value: (
        <span className="inline-flex flex-wrap gap-x-2">
          {e.policies.map((p) => (
            <Link
              key={p.id}
              to="/prtg"
              search={{ tab: "policies", policy: p.id }}
              className="link"
            >
              {p.name}
            </Link>
          ))}
        </span>
      ),
    })
  if (e.linked)
    rows.push({
      label: "PRTG device",
      value: (
        <span className="inline-flex flex-wrap items-center gap-2">
          <a
            href={e.linked.url}
            target="_blank"
            rel="noreferrer"
            className="link inline-flex items-center gap-1 font-mono text-xs"
          >
            {e.linked.name || e.linked.objid}
            <ExternalLink className="h-3 w-3" />
          </a>
          {e.linked.created_here && (
            <Badge variant="secondary">Created by Danbyte</Badge>
          )}
        </span>
      ),
    })
  if (e.last_apply && e.last_apply.at)
    rows.push({
      label: "Last apply",
      value: (
        <span
          className="inline-flex flex-wrap items-center gap-2"
          data-testid="prtg-last-apply"
        >
          <Badge variant={e.last_apply.ok ? "success" : "destructive"}>
            {e.last_apply.ok ? "Applied" : "Failed"}
          </Badge>
          <TimeCell iso={e.last_apply.at} />
          <span className="text-xs text-muted-foreground">
            {e.last_apply.detail}
          </span>
        </span>
      ),
    })
  if (e.managed) {
    rows.push({
      label: "Group",
      value: e.group ? (
        <span className="text-xs">{e.group.path || e.group.objid}</span>
      ) : (
        <Badge variant="warning">None</Badge>
      ),
    })
    if (e.profiles.length)
      rows.push({ label: "Profiles", value: e.profiles.join(", ") })
    if (e.credentials.length)
      rows.push({
        label: "Credentials",
        value: (
          <span className="flex flex-wrap gap-1">
            {e.credentials.map((c) => (
              <Badge key={`${c.kind}-${c.name}`} variant="outline">
                {c.kind === "snmp" ? "SNMP" : "Windows"} {c.name}
              </Badge>
            ))}
          </span>
        ),
      })
  }
  return (
    <div className="grid gap-3">
      <KvCard title={many ? e.connection.name : "Plan"} rows={rows} />
      {e.managed && e.sensors.length > 0 && (
        <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
          {e.sensors.map((s) => (
            <div
              key={s.key}
              className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-[13px]"
              data-testid="prtg-plan-sensor"
            >
              <span className="font-medium">{s.name}</span>
              <span className="text-xs text-muted-foreground">
                {s.kind_label}
              </span>
              {!s.required && <Badge variant="outline">Optional</Badge>}
              <span className="ml-auto">
                {s.template ? (
                  <Badge variant="outline">Template</Badge>
                ) : s.present ? (
                  <Badge variant="success">Present</Badge>
                ) : (
                  <Badge variant="info">Planned</Badge>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
      {issues.map((i) => (
        <PrtgIssueLine key={i.text} issue={i} object={object} />
      ))}
    </div>
  )
}
