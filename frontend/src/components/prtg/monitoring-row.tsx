import { useState } from "react"
import type { ReactNode } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react"

import { api } from "@/lib/api"
import type {
  PrtgDeviceLink,
  PrtgLastApply,
  PrtgPlanEntry,
  PrtgSavePlan,
  PrtgSync,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useDateFormat } from "@/lib/datetime"
import { useMe } from "@/lib/use-me"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { InfoTip } from "@/components/ui/info-tip"
import { Section } from "@/components/ui/section"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
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
import {
  ConnectionLink,
  PRTG_PLAN_FOOTNOTE,
  PrtgIssueLine,
  prtgIssueLinks,
} from "./issues"
import { sensorTotal, usePrtgLinks, usePrtgSensors } from "./sensors-tab"
import {
  AddToPrtgNowButton,
  useAddToPrtgNow,
  usePrtgPlan,
  useRefreshWhenLinked,
} from "./object-state"
import { showPrtgSaveToast } from "./prtg-sync-select"
import type { PrtgParent } from "./sensors-tab"

/**
 * One row on a device's or VM's Monitoring tab: what PRTG says about it, as
 * the monitoring bar's PRTG source row - the state pill, the counts with
 * their sensors in the hover, the PRTG device and when it was read - then a
 * link to the Sensors tab. A count opens that tab filtered to its state.
 * Its chevron opens the details in place: whether the object is in PRTG,
 * whether Danbyte made it, what registers it and what is planned. It is
 * absent while the integration is off. Like the Zabbix section beside it, it never
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
  const [open, setOpen] = useDetailsOpen()
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
      actions={
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label="Details"
              aria-expanded={open}
              onClick={() => setOpen(!open)}
            >
              {open ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent variant="panel">Details</TooltipContent>
        </Tooltip>
      }
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
                      {link.rule_paused_at && (
                        <Badge
                          variant="secondary"
                          className="whitespace-nowrap"
                        >
                          Paused by rule {link.rule_paused_name}
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
      {open && (
        <PrtgDetails parent={parent} prtgSync={prtgSync} className="mt-3" />
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

const OPEN_KEY = "danbyte.prtg.monitoring-details"

/** Whether the details block is open, remembered per browser. */
function useDetailsOpen(): [boolean, (v: boolean) => void] {
  const [open, setOpen] = useState(() => {
    try {
      return window.localStorage.getItem(OPEN_KEY) === "1"
    } catch {
      return false
    }
  })
  return [
    open,
    (v) => {
      setOpen(v)
      try {
        window.localStorage.setItem(OPEN_KEY, v ? "1" : "0")
      } catch {
        // Storage blocked: the block still opens, it is just not remembered.
      }
    },
  ]
}

type ObjectRef = { kind: "device" | "virtual_machine"; id: string }

function objectOf(parent: PrtgParent): ObjectRef {
  return "device" in parent
    ? { kind: "device", id: parent.device }
    : { kind: "virtual_machine", id: parent.virtual_machine }
}

function matchedBy(how: string | undefined): string {
  if (!how) return ""
  if (how === "created") return "created by Danbyte"
  if (how === "adopted") return "adopted"
  return `matched by ${how}`
}

/** The details under the PRTG row: one card per connection, then the
 * Register and review-queue actions. Read when opened. */
export function PrtgDetails({
  parent,
  prtgSync,
  className,
}: {
  parent: PrtgParent
  prtgSync?: PrtgSync
  className?: string
}) {
  const object = objectOf(parent)
  const qc = useQueryClient()
  const { canDo } = useMe()
  const plan = usePrtgPlan(object)
  const add = useAddToPrtgNow(object)
  useRefreshWhenLinked(plan.data)
  const register = useMutation({
    // The save plans the object at once (and applies it when the
    // connection applies automatically).
    mutationFn: () =>
      api<{ prtg_plan?: PrtgSavePlan | null }>(
        object.kind === "device"
          ? `/api/devices/${object.id}/`
          : `/api/virtual-machines/${object.id}/`,
        { method: "PATCH", body: JSON.stringify({ prtg_sync: "always" }) }
      ),
    onSuccess: (saved) => {
      showPrtgSaveToast(saved.prtg_plan, "Set to Monitor in PRTG")
      void qc.invalidateQueries({ queryKey: ["prtg-plan"] })
      void qc.invalidateQueries({ queryKey: ["prtg-changes"] })
      void qc.invalidateQueries({
        queryKey: [
          object.kind === "device" ? "device" : "virtual-machine",
          object.id,
        ],
      })
    },
    onError: (e) => apiErrorToast(e),
  })
  let body: ReactNode
  if (plan.isLoading) body = <Loading />
  else if (plan.isError) body = <QueryError error={plan.error} />
  else if (!plan.data?.length)
    body = <EmptyState title="No PRTG connection">Nothing to plan.</EmptyState>
  else {
    const entries = plan.data
    const linked = entries.some((e) => e.linked)
    const excluded =
      prtgSync === "never" ||
      entries.some((e) => e.registration.mode === "never")
    const canRegister =
      !linked &&
      !excluded &&
      canDo(object.kind === "device" ? "device" : "virtualmachine", "change")
    const queued = entries.reduce((n, e) => n + e.planned.queued, 0)
    const ready = entries.reduce(
      (n, e) => n + (e.linked ? 0 : (e.planned.ready ?? 0)),
      0
    )
    const adding =
      add.isPending || entries.some((e) => !e.linked && e.planned.applying)
    body = (
      <>
        {entries.map((e) => (
          <DetailsEntry
            key={e.connection.id}
            entry={e}
            many={entries.length > 1}
            object={object}
          />
        ))}
        <div className="flex flex-wrap items-center gap-2">
          {canRegister && (
            <Button
              size="sm"
              variant="outline"
              disabled={register.isPending}
              onClick={() => register.mutate()}
            >
              {register.isPending ? "Registering…" : "Register in PRTG"}
            </Button>
          )}
          {adding ? (
            <span className="text-[13px] text-muted-foreground">
              Adding to PRTG…
            </span>
          ) : (
            ready > 0 &&
            !excluded && <AddToPrtgNowButton object={object} add={add} />
          )}
          {queued > 0 && (
            <Button size="sm" variant="outline" asChild>
              <Link to="/prtg" search={{ tab: "review", object: object.id }}>
                Open review queue
              </Link>
            </Button>
          )}
          <span className="text-[11px] text-muted-foreground">
            {PRTG_PLAN_FOOTNOTE}
          </span>
        </div>
      </>
    )
  }
  return (
    <div
      className={`grid gap-3 rounded-lg border border-border p-3 ${className ?? ""}`}
      data-testid="prtg-details"
    >
      {body}
    </div>
  )
}

const MODE: Record<string, string> = {
  always: "Monitor in PRTG set on the object",
  register_all: "Register all",
  never: "Excluded",
  none: "Nothing registers it",
}

function Registration({
  entry: e,
  object,
}: {
  entry: PrtgPlanEntry
  object: ObjectRef
}) {
  const { mode, policies } = e.registration
  let label: ReactNode = MODE[mode] ?? mode
  let links: ReactNode[] = []
  if (mode === "policies") {
    label = (
      <>
        {policies.length === 1 ? "Policy" : "Policies"}{" "}
        {policies.map((p, i) => (
          <span key={p.id}>
            {i > 0 && ", "}
            <Link
              to="/prtg"
              search={{ tab: "policies", policy: p.id }}
              className="link"
            >
              {p.name}
            </Link>
          </span>
        ))}
      </>
    )
  } else if (mode === "register_all") {
    links = [<ConnectionLink key="conn" />]
  } else if (mode === "never" || mode === "always") {
    links = prtgIssueLinks({ code: "excluded", text: "" }, object)
  } else if (mode === "none") {
    links = prtgIssueLinks({ code: "no_match", text: "" }, object)
  }
  links = links.filter(Boolean)
  return (
    <span
      className="inline-flex flex-wrap items-center gap-x-2"
      data-testid="prtg-registration"
    >
      <span>{label}</span>
      {links.length > 0 && (
        <span className="inline-flex flex-wrap gap-2 text-xs">{links}</span>
      )}
    </span>
  )
}

function Planned({
  entry: e,
  object,
}: {
  entry: PrtgPlanEntry
  object: ObjectRef
}) {
  const p = e.planned
  const empty =
    !p.create_device && !p.sensors.length && !p.move && !p.remove.length
  if (empty)
    return (
      <div className="grid gap-1" data-testid="prtg-planned">
        <span className="text-muted-foreground">Nothing planned</span>
        {p.reasons.map((i) => (
          <PrtgIssueLine
            key={i.text}
            issue={i}
            object={object}
            className="text-xs text-muted-foreground"
          />
        ))}
      </div>
    )
  return (
    <ul className="grid gap-1" data-testid="prtg-planned">
      {p.create_device && (
        <li>
          Create the PRTG device
          {e.registration.group?.path && (
            <span className="text-muted-foreground">
              {" "}
              in {e.registration.group.path}
            </span>
          )}
        </li>
      )}
      {p.sensors.map((s) => (
        <li key={s.key} data-testid="prtg-plan-sensor">
          Add {s.name}{" "}
          <span className="text-xs text-muted-foreground">{s.kind_label}</span>
        </li>
      ))}
      {p.move && (
        <li>
          Move from {p.move.from?.path || p.move.from?.objid} to{" "}
          {p.move.to?.path || p.move.to?.objid}
        </li>
      )}
      {p.remove.map((s) => (
        <li key={s.objid}>
          Remove {s.name}{" "}
          <span className="text-xs text-muted-foreground">{s.kind}</span>
        </li>
      ))}
    </ul>
  )
}

function LastApply({ apply }: { apply: PrtgLastApply }) {
  return (
    <span
      className="inline-flex flex-wrap items-center gap-x-1.5"
      data-testid="prtg-last-apply"
    >
      <span className="text-muted-foreground">· last apply</span>
      <Badge variant={apply.ok ? "success" : "destructive"}>
        {apply.ok ? "Applied" : "Failed"}
      </Badge>
      <TimeCell iso={apply.at} />
      {!apply.ok && apply.detail && (
        <span className="text-xs text-muted-foreground">{apply.detail}</span>
      )}
    </span>
  )
}

function DetailsEntry({
  entry: e,
  many,
  object,
}: {
  entry: PrtgPlanEntry
  many: boolean
  object: ObjectRef
}) {
  const { formatDate } = useDateFormat()
  const issues = e.issues ?? e.problems.map((text) => ({ text }))
  const how = matchedBy(e.linked?.matched_by)
  const rows: KvRow[] = [
    {
      label: "In PRTG",
      value: e.linked ? (
        <span className="inline-flex flex-wrap items-center gap-x-1.5">
          Yes ·
          <a
            href={e.linked.url}
            target="_blank"
            rel="noreferrer"
            className="link inline-flex items-center gap-1"
          >
            {e.linked.name || e.linked.objid}
            <ExternalLink className="h-3 w-3" />
          </a>
          {how && <span className="text-muted-foreground">· {how}</span>}
        </span>
      ) : (
        "No"
      ),
    },
    {
      label: "Managed by Danbyte",
      value: (
        <span
          className="inline-flex flex-wrap items-center gap-x-1.5"
          data-testid="prtg-managed"
        >
          {e.managed && e.linked?.created_at
            ? `Yes, created on ${formatDate(e.linked.created_at)}`
            : e.managed
              ? "Yes"
              : "No"}
          {e.last_apply?.at && <LastApply apply={e.last_apply} />}
          {e.managed &&
            (e.linked?.sent_tags ?? []).map((t) => (
              <Badge key={t} variant="outline" data-testid="prtg-sent-tag">
                {t}
              </Badge>
            ))}
        </span>
      ),
    },
    {
      label: "Registration",
      value: <Registration entry={e} object={object} />,
    },
    { label: "Planned", value: <Planned entry={e} object={object} /> },
    ...((e.credential_placement ?? []).length > 0
      ? [
          {
            label: "Credentials",
            value: (
              <span className="grid gap-0.5" data-testid="prtg-credentials">
                {(e.credential_placement ?? []).map((c) => (
                  <span
                    key={c.section}
                    className={
                      c.mode === "inherit" && c.state?.set === false
                        ? "text-amber-600 dark:text-amber-400"
                        : ""
                    }
                  >
                    {c.label}:{" "}
                    {c.mode === "group"
                      ? `set on the group${c.credential ? `, ${c.credential}` : ""}`
                      : c.mode === "device"
                        ? `set on the device${c.credential ? `, ${c.credential}` : ""}`
                        : c.state?.set === false
                          ? "not set on any group above this device"
                          : c.text
                            ? c.text.charAt(0).toLowerCase() + c.text.slice(1)
                            : "inherited"}
                  </span>
                ))}
              </span>
            ),
          },
        ]
      : []),
  ]
  return (
    <div className="grid gap-2">
      <KvCard title={many ? e.connection.name : "Details"} rows={rows} />
      {issues.map((i) => (
        <PrtgIssueLine key={i.text} issue={i} object={object} />
      ))}
    </div>
  )
}
