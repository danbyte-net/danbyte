import type { ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { Activity, ExternalLink } from "lucide-react"

import { api } from "@/lib/api"
import type {
  BulkStatusEntry,
  BulkStatusResponse,
  CheckStatus,
  PrtgDeviceLink,
  PrtgSensor,
  ZabbixHostStatus,
} from "@/lib/api"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { TimeCell, timeAgo } from "@/components/cells/time-ago"
import {
  countSensors,
  usePrtgLinks,
  usePrtgSensors,
} from "@/components/prtg/sensors-tab"
import { SeverityPill, zabbixHostUrl } from "./external-status"
import { FlappingPill } from "./flapping-pill"
import { NotifyMeButton } from "./notify-me-button"
import { statusLabel, useStatusLabels } from "./status-palette"
import { CheckStatusBadge } from "./status-badge"
import { useZabbixHostStatus } from "./zabbix-host-panel"

/**
 * The monitoring bar on a device's and a VM's Overview, and the pill in their
 * headers. One overall pill (worst wins across Danbyte's checks, Zabbix and
 * PRTG), then one row per source the object has: its state, its counts, the
 * object over there and when it was read. Every pill and count opens the
 * shared tooltip with what is behind it; every row opens the tab that shows
 * it. The Sensors tab strip and the Monitoring tab's PRTG row draw their row
 * with the same `MonitoringSourceRow`.
 */

/** The device or VM a bar is about. */
export type MonitoringTarget = { device: string } | { virtual_machine: string }

/** A source's states: Danbyte's, plus PRTG's paused. */
export type SourceState = CheckStatus | "paused"

/** One thing behind a pill or a count: a check, a trigger, a sensor. */
export interface SourceItem {
  key: string
  name: string
  /** Shown as mono text after the name - a check's address. */
  address?: string
  status: SourceState
  /** A pill in place of the state pill (a Zabbix severity). */
  pill?: ReactNode
  /** The source's own words: PRTG's message, a Zabbix error. */
  note?: string
  /** The last change. */
  since?: string | null
}

type BadgeVariant =
  "destructive" | "warning" | "success" | "secondary" | "outline"

export interface SourceCount {
  /** The filter a click applies (a state, or `problem`). */
  key: string
  /** Absent for a fact with no number ("SNMP unreachable"). */
  n?: number
  label: string
  variant: BadgeVariant
  items: SourceItem[]
}

export interface MonitoringSource {
  key: string
  kind: "checks" | "zabbix" | "prtg"
  label: string
  status: CheckStatus | null
  counts: SourceCount[]
  /** Everything behind the state pill, worst first. */
  items: SourceItem[]
  /** How many there are in all, for "+N more". */
  total?: number
  object?: { name: string; url: string }
  readAt?: string | null
  /** The filter the row itself opens with. */
  filter?: string
  extra?: ReactNode
}

/** Wraps a clickable part of a row; `filter` is the count's key, or the
 * row's own filter. */
export type SourceLink = (children: ReactNode, filter?: string) => ReactNode

const RANK: Record<string, number> = {
  skipped: 0,
  paused: 0,
  up: 1,
  unknown: 2,
  degraded: 3,
  stale: 4,
  down: 5,
}

export function rankOf(s: string | null | undefined): number {
  return s ? (RANK[s] ?? 1) : -1
}

/** The worst of several states - the overall pill. */
export function worstOf(
  states: (CheckStatus | null | undefined)[]
): CheckStatus | null {
  let out: CheckStatus | null = null
  for (const s of states) if (s && rankOf(s) > rankOf(out)) out = s
  return out
}

const VARIANT: Record<string, BadgeVariant> = {
  down: "destructive",
  stale: "destructive",
  degraded: "warning",
  up: "success",
  unknown: "secondary",
  skipped: "secondary",
  paused: "outline",
}

const CHECK_ORDER: CheckStatus[] = [
  "down",
  "stale",
  "degraded",
  "unknown",
  "up",
  "skipped",
]

const PRTG_ORDER = ["down", "degraded", "unknown", "up", "paused"] as const

/** Worst first, then by name. */
function byWorst(a: SourceItem, b: SourceItem): number {
  return rankOf(b.status) - rankOf(a.status) || a.name.localeCompare(b.name)
}

const isProblem = (s: string | null | undefined) =>
  !!s && s !== "up" && s !== "skipped" && s !== "paused"

// ─── sources ─────────────────────────────────────────────────────────────

type Labels = ReturnType<typeof useStatusLabels>

function lower(s: SourceState, labels: Labels): string {
  return s === "paused" ? "paused" : statusLabel(s, labels).toLowerCase()
}

/** Danbyte's own checks, from the bulk roll-up with `detail`. */
export function checksSource(
  e: BulkStatusEntry | undefined,
  labels: Labels
): MonitoringSource | null {
  if (!e || !e.status) return null
  const items: SourceItem[] = (e.items ?? []).map((i) => ({
    key: i.id,
    name: i.name,
    address: i.address,
    status: i.status,
    since: i.since,
  }))
  const counts = CHECK_ORDER.filter((s) => (e.counts?.[s] ?? 0) > 0).map(
    (s) => ({
      key: s,
      n: e.counts![s]!,
      label: lower(s, labels),
      variant: VARIANT[s],
      items: items.filter((i) => i.status === s),
    })
  )
  return {
    key: "checks",
    kind: "checks",
    label: "Checks",
    status: e.status,
    counts,
    items,
    total: counts.reduce((a, c) => a + c.n, 0),
    filter: isProblem(e.status) ? "problem" : undefined,
    extra: e.flapping ? <FlappingPill count={e.flapping} /> : undefined,
  }
}

/** What Zabbix says about one of the device's hosts. */
export function zabbixSource(row: ZabbixHostStatus): MonitoringSource {
  const s = row.status
  const problems: SourceItem[] = s.problems.map((p, i) => ({
    key: p.eventid || `${p.name}-${i}`,
    name: p.name,
    status: s.worst_status ?? "unknown",
    pill: <SeverityPill severity={p.severity} />,
    since: p.since,
  }))
  const down = Object.entries(s.availability).filter(
    ([, v]) => v.state === "down"
  )
  const reach: SourceItem[] = down.map(([proto, v]) => ({
    key: `reach-${proto}`,
    name: `${proto.toUpperCase()} unreachable`,
    status: "down",
    note: v.error,
  }))
  const counts: SourceCount[] = []
  if (s.problem_count > 0)
    counts.push({
      key: "problems",
      n: s.problem_count,
      label: s.problem_count === 1 ? "problem" : "problems",
      variant: VARIANT[s.worst_status ?? "degraded"] ?? "warning",
      items: problems,
    })
  for (const item of reach)
    counts.push({
      key: item.key,
      label: item.name,
      variant: "destructive",
      items: [item],
    })
  return {
    key: `zabbix-${row.connection.id}-${row.host.hostid}`,
    kind: "zabbix",
    label: "Zabbix",
    status: s.worst_status,
    counts,
    items: [...reach, ...problems],
    total: s.problem_count + reach.length,
    object: {
      name: row.host.name,
      url: zabbixHostUrl(row.connection.url, row.host.hostid),
    },
    readAt: s.polled_at,
    extra: (
      <>
        {s.disabled && <Badge variant="secondary">Disabled</Badge>}
        {s.maintenance && <Badge variant="secondary">Maintenance</Badge>}
      </>
    ),
  }
}

/** A PRTG sensor as a row in a tooltip. */
function sensorItem(s: PrtgSensor): SourceItem {
  return {
    key: s.id,
    name: s.name,
    status: s.paused ? "paused" : s.state || "unknown",
    note: s.state !== "up" || s.paused ? s.message || s.status : undefined,
    since: s.state === "up" ? null : s.last_down_at,
  }
}

/** What PRTG says about one of its devices for this object. `sensors` are
 * the object's sensors when read; without them the counts come from the
 * link's last read and the tooltips say only the numbers. */
export function prtgSource(
  link: PrtgDeviceLink,
  sensors: PrtgSensor[] | undefined,
  labels: Labels
): MonitoringSource {
  const mine = sensors?.filter((s) => s.connection === link.connection)
  const items = (mine ?? []).map(sensorItem).sort(byWorst)
  const raw = link.sensor_counts as Partial<Record<string, number>>
  const tally = mine
    ? countSensors(mine)
    : {
        down: raw.down ?? 0,
        degraded: raw.degraded ?? 0,
        up: raw.up ?? 0,
        unknown: raw.unknown ?? 0,
        paused: raw.paused ?? 0,
      }
  const counts = PRTG_ORDER.filter((k) => tally[k] > 0).map((k) => ({
    key: k,
    n: tally[k],
    label: lower(k, labels),
    variant: VARIANT[k],
    items: items.filter((i) => i.status === k),
  }))
  const status = link.state || "unknown"
  return {
    key: `prtg-${link.id}`,
    kind: "prtg",
    label: "PRTG",
    status,
    counts,
    items,
    total: counts.reduce((a, c) => a + c.n, 0),
    object: { name: link.name || link.objid, url: link.url },
    readAt: link.status_read_at,
    filter: tally.down + tally.degraded > 0 ? "problem" : undefined,
  }
}

function parentOf(target: MonitoringTarget) {
  return "device" in target
    ? { kind: "devices" as const, id: target.device }
    : { kind: "vms" as const, id: target.virtual_machine }
}

/**
 * Every source for one device or VM: one bulk roll-up with its checks, the
 * Zabbix host status (devices) and the PRTG links, plus the PRTG sensors
 * when `items` asks for the hovers' lists. Each query is the one the page's
 * tabs already make, so they share their cache.
 */
export function useMonitoringSources(
  target: MonitoringTarget,
  { items = true }: { items?: boolean } = {}
) {
  const labels = useStatusLabels()
  const { kind, id } = parentOf(target)
  const bulk = useQuery({
    queryKey: ["monitoring-bar", kind, id],
    queryFn: () =>
      api<BulkStatusResponse>("/api/monitoring/status/", {
        method: "POST",
        body: JSON.stringify({ [kind]: [id], detail: true }),
      }),
    refetchInterval: 60_000,
  })
  const isDevice = "device" in target
  const zabbix = useZabbixHostStatus(
    { device: isDevice ? target.device : "" },
    isDevice
  )
  const links = usePrtgLinks(target)
  const linkRows = links.data ?? []
  const sensors = usePrtgSensors(target, items && linkRows.length > 0)

  const sources: MonitoringSource[] = []
  const checks = checksSource(bulk.data?.statuses[id], labels)
  if (checks) sources.push(checks)
  if (isDevice)
    for (const row of zabbix.data ?? []) sources.push(zabbixSource(row))
  for (const link of linkRows)
    sources.push(prtgSource(link, sensors.data ?? undefined, labels))
  return {
    sources,
    overall: worstOf(sources.map((s) => s.status)),
    isLoading: bulk.isLoading,
  }
}

// ─── pieces ──────────────────────────────────────────────────────────────

const TIP_LIMIT = 10

function ItemPill({ item }: { item: SourceItem }) {
  if (item.pill) return <>{item.pill}</>
  if (item.status === "paused") return <Badge variant="outline">Paused</Badge>
  return <CheckStatusBadge status={item.status} />
}

/** The list behind a pill or a count, worst first, ten at most. */
export function SourceItemsList({
  items,
  total,
  heading,
}: {
  items: SourceItem[]
  total?: number
  heading?: ReactNode
}) {
  const shown = items.slice(0, TIP_LIMIT)
  const more = Math.max((total ?? items.length) - shown.length, 0)
  return (
    <div
      className="flex min-w-0 flex-col gap-1.5 text-[12px]"
      data-testid="monitoring-tip"
    >
      {heading && <p className="font-medium">{heading}</p>}
      {shown.length > 0 && (
        <ul className="flex flex-col gap-1">
          {shown.map((i) => (
            <li key={i.key} className="flex min-w-0 items-start gap-2">
              <span className="shrink-0">
                <ItemPill item={i} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="break-words">{i.name}</span>
                {i.address && (
                  <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">
                    {i.address}
                  </span>
                )}
                {i.note && (
                  <span className="block text-[11px] break-words text-muted-foreground">
                    {i.note}
                  </span>
                )}
              </span>
              {i.since && (
                <span className="num shrink-0 text-[11px] text-muted-foreground">
                  {timeAgo(i.since)}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {more > 0 && (
        <p className="text-[11px] text-muted-foreground">+{more} more</p>
      )}
    </div>
  )
}

function Tip({
  content,
  children,
}: {
  content: ReactNode
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">{children}</span>
      </TooltipTrigger>
      <TooltipContent variant="panel" className="max-w-sm">
        {content}
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * One source as a row: its name, its state pill, its counts as badges, its
 * object over there with the external link, and when it was read. The name,
 * the pill and each count are wrapped by `link`: a route link on the
 * Overview, a filter button on the Sensors tab.
 */
export function MonitoringSourceRow({
  source: s,
  link = (c) => c,
  showPill = true,
  active,
  className,
}: {
  source: MonitoringSource
  link?: SourceLink
  /** Off on a bar with one source: the overall pill says the same. */
  showPill?: boolean
  /** The filter in force, marked on its count. */
  active?: string
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px]",
        className
      )}
      data-testid="monitoring-source"
      data-source={s.kind}
    >
      {link(
        <span className="w-14 shrink-0 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase hover:text-foreground">
          {s.label}
        </span>,
        s.filter
      )}
      {showPill && s.status && (
        <Tip
          content={
            <SourceItemsList
              items={s.items}
              total={s.total}
              heading={`${s.label}: ${s.total ?? s.items.length} in all`}
            />
          }
        >
          {link(<CheckStatusBadge status={s.status} />, s.filter)}
        </Tip>
      )}
      {s.counts.length > 0 && (
        <span
          className="inline-flex flex-wrap items-center gap-1.5"
          data-testid="monitoring-source-counts"
        >
          {s.counts.map((c) => (
            <Tip
              key={c.key}
              content={
                <SourceItemsList
                  items={c.items}
                  total={c.n}
                  heading={c.n != null ? `${c.n} ${c.label}` : c.label}
                />
              }
            >
              {link(
                <Badge
                  variant={c.variant}
                  className={cn(
                    "num cursor-pointer",
                    active === c.key && "ring-1 ring-foreground/40"
                  )}
                  data-state={c.key}
                  data-active={active === c.key || undefined}
                >
                  {c.n != null ? `${c.n} ${c.label}` : c.label}
                </Badge>,
                c.key
              )}
            </Tip>
          ))}
        </span>
      )}
      {s.extra}
      {s.object && (
        <a
          href={s.object.url || undefined}
          target="_blank"
          rel="noreferrer"
          className="link inline-flex min-w-0 items-center gap-1 font-mono text-xs"
        >
          <span className="truncate">{s.object.name}</span>
          <ExternalLink className="h-3 w-3 shrink-0" />
        </a>
      )}
      {s.readAt && (
        <span className="ml-auto inline-flex items-center gap-1 text-[11px] whitespace-nowrap text-muted-foreground">
          read <TimeCell iso={s.readAt} />
        </span>
      )}
    </div>
  )
}

/** A typed link to the target's own page, on one of its tabs. */
function TargetLink({
  target,
  tab,
  state,
  hash,
  children,
}: {
  target: MonitoringTarget
  tab: "monitoring" | "sensors"
  state?: string
  hash?: string
  children: ReactNode
}) {
  const cls =
    "inline-flex rounded-[5px] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
  return "device" in target ? (
    <Link
      to="/devices/$id"
      params={{ id: target.device }}
      search={{ tab, state }}
      hash={hash}
      className={cls}
    >
      {children}
    </Link>
  ) : (
    <Link
      to="/virtual-machines/$id"
      params={{ id: target.virtual_machine }}
      search={{ tab, state }}
      hash={hash}
      className={cls}
    >
      {children}
    </Link>
  )
}

/** Where each source's row and counts open on the target's page. */
export function sourceLink(
  target: MonitoringTarget,
  source: MonitoringSource
): SourceLink {
  return (children, filter) => {
    if (source.kind === "zabbix")
      return (
        <TargetLink target={target} tab="monitoring" hash="zabbix">
          {children}
        </TargetLink>
      )
    // A Zabbix-style "problems" key never reaches here; a check or sensor
    // count filters by its state.
    return (
      <TargetLink
        target={target}
        tab={source.kind === "prtg" ? "sensors" : "monitoring"}
        state={filter}
      >
        {children}
      </TargetLink>
    )
  }
}

/** The overall pill's hover: one line per source. */
function OverallTip({ sources }: { sources: MonitoringSource[] }) {
  return (
    <div
      className="flex flex-col gap-1.5 text-[12px]"
      data-testid="monitoring-tip"
    >
      {sources.map((s) => (
        <div key={s.key} className="flex flex-wrap items-center gap-1.5">
          <span className="w-14 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
            {s.label}
          </span>
          {s.status && <CheckStatusBadge status={s.status} />}
          {s.counts.map((c) => (
            <Badge key={c.key} variant={c.variant} className="num">
              {c.n != null ? `${c.n} ${c.label}` : c.label}
            </Badge>
          ))}
        </div>
      ))}
    </div>
  )
}

/**
 * The monitoring bar for a device's or VM's Overview. Absent when nothing
 * monitors the object. `notify` is the Notify me scope: the device, or a
 * VM's primary address.
 */
export function MonitoringBar({
  target,
  notify,
}: {
  target: MonitoringTarget
  notify?: { device: string } | { ip: string }
}) {
  const { sources, overall } = useMonitoringSources(target)
  if (sources.length === 0 || !overall) return null
  return (
    <section
      className="flex flex-col gap-x-4 gap-y-2 rounded-lg border border-border bg-card px-3 py-2 sm:flex-row sm:items-start"
      data-testid="monitoring-bar"
    >
      <div className="flex shrink-0 items-center gap-2 sm:min-h-7">
        <h2 className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-foreground uppercase">
          <Activity className="h-3.5 w-3.5 text-muted-foreground" />
          Monitoring
        </h2>
        <Tip content={<OverallTip sources={sources} />}>
          <span data-testid="monitoring-overall" className="inline-flex">
            <CheckStatusBadge status={overall} />
          </span>
        </Tip>
      </div>
      <div className="flex min-w-0 flex-1 flex-col divide-y divide-border/60">
        {sources.map((s) => (
          <MonitoringSourceRow
            key={s.key}
            source={s}
            link={sourceLink(target, s)}
            showPill={sources.length > 1}
            className="py-1 sm:min-h-7"
          />
        ))}
      </div>
      {notify && (
        <div className="shrink-0 sm:ml-auto">
          <NotifyMeButton
            device={"device" in notify ? notify.device : undefined}
            ip={"ip" in notify ? notify.ip : undefined}
          />
        </div>
      )}
    </section>
  )
}

// ─── the filter the bar opens a tab with ─────────────────────────────────

/** Whether something in `status` (or with these per-state `counts`) passes
 * the bar's filter: `problem` is anything not up, skipped or paused. */
export function matchesState(
  filter: string | undefined,
  status: SourceState | null | undefined,
  counts?: Partial<Record<string, number>>
): boolean {
  if (!filter) return true
  if (filter === "problem")
    return counts
      ? Object.entries(counts).some(([s, n]) => (n ?? 0) > 0 && isProblem(s))
      : isProblem(status)
  return counts ? (counts[filter] ?? 0) > 0 : status === filter
}

/** "Showing Degraded · Show all" above a list the bar filtered. */
export function StateFilterNote({
  state,
  onClear,
}: {
  state?: string
  onClear: () => void
}) {
  const labels = useStatusLabels()
  if (!state) return null
  const label =
    state === "problem"
      ? "Problems"
      : state === "paused"
        ? "Paused"
        : statusLabel(state as CheckStatus, labels)
  return (
    <div
      className="mb-2 flex items-center gap-2 text-[12px] text-muted-foreground"
      data-testid="state-filter-note"
    >
      <span>Showing</span>
      <Badge variant={VARIANT[state] ?? "secondary"}>{label}</Badge>
      <Button
        variant="link"
        size="sm"
        className="h-auto p-0 text-[12px]"
        onClick={onClear}
      >
        Show all
      </Button>
    </div>
  )
}

/** The same overall pill and hover for the device and VM headers. */
export function MonitoringHeaderBadge({
  target,
}: {
  target: MonitoringTarget
}) {
  const { sources, overall } = useMonitoringSources(target, { items: false })
  if (sources.length === 0 || !overall) return null
  return (
    <Tip content={<OverallTip sources={sources} />}>
      <span
        className="inline-flex"
        data-testid="monitoring-header-badge"
        tabIndex={0}
      >
        <CheckStatusBadge status={overall} />
      </span>
    </Tip>
  )
}
