import type { ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { ArrowRight, ExternalLink } from "lucide-react"

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
import { Loading } from "@/components/loading"
import {
  countSensors,
  usePrtgLinks,
  usePrtgSensors,
} from "@/components/prtg/sensors-tab"
import { SeverityPill, zabbixHostUrl } from "./external-status"
import { FlappingPill } from "./flapping-pill"
import { MixedStatusBadge, StatePill, mixedEntries } from "./mixed-status-badge"
import type { MixedState } from "./mixed-status-badge"
import { NotifyMeButton } from "./notify-me-button"
import { statusLabel, useStatusLabels } from "./status-palette"
import { CheckStatusBadge } from "./status-badge"
import { useZabbixHostStatus } from "./zabbix-host-panel"

/**
 * The monitoring card on a device's and a VM's Overview, and the pill in
 * their headers. Every state on them is the shared pill, and a source with
 * several states is the shared mixed badge - never a bar, never the same
 * word twice. Every badge has the same hover (the shared tooltip: counts,
 * then the items worst first, ten at most) and the same click (the tab the
 * items live on, filtered). The header pill is the simple version: the
 * overall state (worst wins across Danbyte's checks, Zabbix and PRTG). The
 * card is the detailed one: one header line with the overall pill and each
 * source's badge, then only the problem rows. The Sensors tab strip and the
 * Monitoring tab's PRTG row draw their line with `MonitoringSourceRow`.
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
    note: i.error || undefined,
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

/** A plain list of PRTG sensors as a source - the strip on an address,
 * interface or service, where no PRTG device is the subject. */
export function sensorListSource(
  sensors: PrtgSensor[],
  labels: Labels,
  key = "prtg"
): MonitoringSource {
  const items = sensors.map(sensorItem).sort(byWorst)
  const tally = countSensors(sensors)
  const counts = PRTG_ORDER.filter((k) => tally[k] > 0).map((k) => ({
    key: k,
    n: tally[k],
    label: lower(k, labels),
    variant: VARIANT[k],
    items: items.filter((i) => i.status === k),
  }))
  const live = sensors
    .filter((s) => !s.paused)
    .map((s): CheckStatus => s.state || "unknown")
  return {
    key,
    kind: "prtg",
    label: "PRTG",
    status: worstOf(live.length ? live : ["unknown"]),
    counts,
    items,
    total: sensors.length,
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

/** A source's states with their numbers, for its mixed badge. Zabbix counts
 * problems, not items, so it tallies what it has; with nothing to tally it
 * is its own state. */
export function stateCounts(
  s: MonitoringSource
): Partial<Record<MixedState, number>> {
  const out: Partial<Record<MixedState, number>> = {}
  if (s.kind === "zabbix") {
    for (const i of s.items) out[i.status] = (out[i.status] ?? 0) + 1
    if (s.items.length === 0 && s.status) out[s.status] = 1
    return out
  }
  for (const c of s.counts) if (c.n) out[c.key as MixedState] = c.n
  if (s.counts.length === 0 && s.status) out[s.status] = 1
  return out
}

/** "1 degraded · 2 up", "1 problem · SNMP unreachable", "no problems". */
export function countsText(s: MonitoringSource): string {
  if (s.counts.length === 0) return s.kind === "zabbix" ? "no problems" : ""
  return s.counts
    .map((c) => (c.n != null ? `${c.n} ${c.label}` : c.label))
    .join(" · ")
}

/** The list behind a badge, worst first, ten at most. */
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
      {heading && <div className="font-medium">{heading}</div>}
      {shown.length > 0 && (
        <ul className="flex flex-col gap-1">
          {shown.map((i) => (
            <li key={i.key} className="flex min-w-0 items-start gap-2">
              <span className="shrink-0">
                {i.pill ?? <StatePill state={i.status} />}
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

/** The shared hover every state element on these surfaces uses. */
export function StateTip({
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

/** A source's hover: its name and counts, then its items worst first. */
function SourceTip({ source: s }: { source: MonitoringSource }) {
  const text = countsText(s)
  return (
    <SourceItemsList
      items={[...s.items].sort(byWorst)}
      total={s.kind === "zabbix" ? s.items.length : s.total}
      heading={
        <span>
          {s.label}
          {s.object && (
            <span className="font-normal text-muted-foreground">
              {" "}
              {s.object.name}
            </span>
          )}
          {text && (
            <span className="num font-normal text-muted-foreground">
              {" · "}
              {text}
            </span>
          )}
        </span>
      }
    />
  )
}

/**
 * A source's state as the shared mixed badge: one pill when everything is
 * in one state ("Up"), the racing flag when it is mixed. The hover lists the
 * counts and the items; a click goes where `link` sends it.
 */
export function SourceStateBadge({
  source: s,
  link = (c) => c,
  active,
}: {
  source: MonitoringSource
  link?: SourceLink
  active?: string
}) {
  return (
    <StateTip content={<SourceTip source={s} />}>
      {link(
        <span
          className={cn(
            "inline-flex rounded-[5px]",
            active && "ring-2 ring-ring/60 ring-offset-1 ring-offset-card"
          )}
          data-testid="monitoring-source-badge"
          data-source={s.kind}
          data-active={active || undefined}
        >
          <MixedStatusBadge counts={stateCounts(s)} status={s.status} />
        </span>,
        s.filter
      )}
    </StateTip>
  )
}

/**
 * One source as a line: its name, its mixed badge, the source's own extras,
 * its object over there with the external link, and when it was read. The
 * name and the badge are wrapped by `link`: a route link on the Overview, a
 * filter toggle on the Sensors tab. One line; the object name truncates.
 */
export function MonitoringSourceRow({
  source: s,
  link = (c) => c,
  showPill = true,
  active,
  actions,
  className,
}: {
  source: MonitoringSource
  link?: SourceLink
  /** Off where the overall pill beside it already says the same. */
  showPill?: boolean
  /** The filter in force, marked on the badge. */
  active?: string
  /** An actions menu at the line's end. */
  actions?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px] sm:flex-nowrap",
        className
      )}
      data-testid="monitoring-source"
      data-source={s.kind}
    >
      {link(
        <span className="shrink-0 font-medium hover:underline">{s.label}</span>,
        s.filter
      )}
      {showPill && s.status && (
        <SourceStateBadge source={s} link={link} active={active} />
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
        <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-[11px] whitespace-nowrap text-muted-foreground">
          read <TimeCell iso={s.readAt} />
        </span>
      )}
      {actions && (
        <span className={cn("shrink-0", !s.readAt && "ml-auto")}>
          {actions}
        </span>
      )}
    </div>
  )
}

/** Where on the target's page something opens: a tab, filtered to a state,
 * at an anchor, or with a PRTG sensor's panel open. */
export interface TargetPlace {
  tab: "monitoring" | "sensors"
  state?: string
  hash?: string
  sensor?: string
}

/** A typed link to the target's own page, on one of its tabs. */
function TargetLink({
  target,
  place: { tab, state, hash, sensor },
  className,
  children,
  ...rest
}: {
  target: MonitoringTarget
  place: TargetPlace
  className?: string
  children: ReactNode
  "data-testid"?: string
  "data-source"?: string
  "data-state"?: string
}) {
  const cls = cn(
    "rounded-[5px] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
    className ?? "inline-flex"
  )
  const search = { tab, state, sensor }
  return "device" in target ? (
    <Link
      to="/devices/$id"
      params={{ id: target.device }}
      search={search}
      hash={hash}
      className={cls}
      {...rest}
    >
      {children}
    </Link>
  ) : (
    <Link
      to="/virtual-machines/$id"
      params={{ id: target.virtual_machine }}
      search={search}
      hash={hash}
      className={cls}
      {...rest}
    >
      {children}
    </Link>
  )
}

/** Where a source, or one of its states, opens on the target's page. */
export function sourcePlace(
  source: MonitoringSource,
  filter?: string
): TargetPlace {
  if (source.kind === "zabbix") return { tab: "monitoring", hash: "zabbix" }
  return {
    tab: source.kind === "prtg" ? "sensors" : "monitoring",
    state: filter,
  }
}

/** Where each source's name and badge open on the target's page. */
export function sourceLink(
  target: MonitoringTarget,
  source: MonitoringSource
): SourceLink {
  return (children, filter) => (
    <TargetLink target={target} place={sourcePlace(source, filter)}>
      {children}
    </TargetLink>
  )
}

/** The worst source: where the overall pill opens. */
function worstSource(sources: MonitoringSource[]): MonitoringSource | null {
  let out: MonitoringSource | null = null
  for (const s of sources)
    if (!out || rankOf(s.status) > rankOf(out.status)) out = s
  return out
}

/** The overall pill's hover: one line per source with its badge and
 * counts, then whatever is in a problem state, worst first. */
function OverallTip({ sources }: { sources: MonitoringSource[] }) {
  const problems = sources
    .flatMap((s) => s.items.filter((i) => isProblem(i.status)))
    .sort(byWorst)
  return (
    <div className="flex flex-col gap-2 text-[12px]">
      <div className="flex flex-col gap-1">
        {sources.map((s) => (
          <div key={s.key} className="flex min-w-0 items-center gap-2">
            <span className="w-12 shrink-0 font-medium">{s.label}</span>
            {s.status && (
              <MixedStatusBadge counts={stateCounts(s)} status={s.status} />
            )}
            <span className="num min-w-0 truncate text-[11px] text-muted-foreground">
              {countsText(s)}
            </span>
          </div>
        ))}
      </div>
      {problems.length > 0 && (
        <div className="border-t border-border pt-2">
          <SourceItemsList items={problems} />
        </div>
      )}
    </div>
  )
}

/** The overall pill with its hover, opening the worst source's tab. */
function OverallPill({
  target,
  sources,
  overall,
  testId,
}: {
  target: MonitoringTarget
  sources: MonitoringSource[]
  overall: CheckStatus
  testId: string
}) {
  const worst = worstSource(sources)
  const place = worst
    ? sourcePlace(worst, worst.filter)
    : { tab: "monitoring" as const }
  return (
    <StateTip content={<OverallTip sources={sources} />}>
      <TargetLink target={target} place={place} data-testid={testId}>
        <CheckStatusBadge status={overall} />
      </TargetLink>
    </StateTip>
  )
}

// ─── the health card ─────────────────────────────────────────────────────

const SOURCE_NAME: Record<MonitoringSource["kind"], string> = {
  checks: "Danbyte check",
  zabbix: "Zabbix",
  prtg: "PRTG",
}

/** One thing in a problem state, from any source, and where it opens. */
export interface ProblemRow {
  key: string
  kind: MonitoringSource["kind"]
  status: SourceState
  name: string
  address?: string
  message?: string
  since?: string | null
  place: TargetPlace
}

/** How many things a source has in a problem state. */
export function problemCount(s: MonitoringSource): number {
  if (s.kind === "zabbix") return s.total ?? 0
  return s.counts.reduce((a, c) => a + (isProblem(c.key) ? (c.n ?? 0) : 0), 0)
}

/** Everything in a problem state across the sources, worst first, then the
 * longest-standing. */
export function problemRows(sources: MonitoringSource[]): ProblemRow[] {
  const out: ProblemRow[] = []
  for (const s of sources)
    for (const i of s.items) {
      if (!isProblem(i.status)) continue
      const row: ProblemRow = {
        key: `${s.key}:${i.key}`,
        kind: s.kind,
        status: i.status,
        name: i.name,
        address: i.address,
        message: i.note,
        since: i.since,
        place: sourcePlace(s, i.status),
      }
      if (s.kind === "prtg") row.place = { tab: "sensors", sensor: i.key }
      // A trigger reads as the host, with the trigger as its message.
      if (s.kind === "zabbix" && !i.key.startsWith("reach-")) {
        row.name = s.object?.name ?? i.name
        row.message = i.name
      }
      out.push(row)
    }
  const t = (x?: string | null) => (x ? new Date(x).getTime() : Infinity)
  return out.sort(
    (a, b) =>
      rankOf(b.status) - rankOf(a.status) ||
      t(a.since) - t(b.since) ||
      a.name.localeCompare(b.name)
  )
}

/** "2h" from "2h ago": how long something has been so. */
function lasted(iso: string): string {
  return timeAgo(iso).replace(/ ago$/, "")
}

function earliest(isos: (string | null | undefined)[]): string | null {
  let out: string | null = null
  for (const x of isos) if (x && (!out || new Date(x) < new Date(out))) out = x
  return out
}

const PROBLEM_LIMIT = 3

/** A problem as one 32px row: its state pill, the thing, its source, how
 * long, and what the source says (the full text in the tooltip). On a
 * phone the source and the message give way. */
function ProblemLine({
  target,
  row,
}: {
  target: MonitoringTarget
  row: ProblemRow
}) {
  return (
    <TargetLink
      target={target}
      place={row.place}
      className="flex h-8 min-w-0 items-center gap-3 rounded-none px-3 text-[13px] hover:bg-muted/40"
      data-testid="monitoring-problem"
      data-source={row.kind}
      data-state={row.status}
    >
      <span className="w-[4.5rem] shrink-0">
        <StatePill state={row.status} />
      </span>
      <span className="min-w-0 truncate sm:max-w-[45%] sm:shrink-0">
        {row.name}
        {row.address && (
          <span className="ml-1.5 font-mono text-xs text-muted-foreground">
            {row.address}
          </span>
        )}
      </span>
      <Badge
        variant="outline"
        className="hidden text-muted-foreground sm:inline-flex"
      >
        {SOURCE_NAME[row.kind]}
      </Badge>
      {row.since && (
        <span className="num ml-auto shrink-0 text-xs text-muted-foreground sm:order-last">
          {lasted(row.since)}
        </span>
      )}
      {row.message && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="hidden min-w-0 flex-1 truncate text-xs text-muted-foreground sm:inline"
              data-testid="problem-message"
            >
              {row.message}
            </span>
          </TooltipTrigger>
          <TooltipContent variant="panel" className="max-w-sm">
            {row.message}
          </TooltipContent>
        </Tooltip>
      )}
    </TargetLink>
  )
}

/** The sources on the card's header line: "Checks [Up] · PRTG [mixed]",
 * each name and badge opening its tab. `bare` drops the badge where the
 * overall pill beside it already says exactly the same. */
function SourceBadges({
  target,
  sources,
  bare,
}: {
  target: MonitoringTarget
  sources: MonitoringSource[]
  bare: boolean
}) {
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
      {sources.map((s, i) => {
        const link = sourceLink(target, s)
        return (
          <span
            key={s.key}
            className="inline-flex items-center gap-1.5"
            data-testid="monitoring-source"
            data-source={s.kind}
          >
            {i > 0 && (
              <span aria-hidden className="text-muted-foreground">
                ·
              </span>
            )}
            {link(
              <span className="text-muted-foreground hover:text-foreground hover:underline">
                {s.label}
              </span>,
              s.filter
            )}
            {!bare && s.status && <SourceStateBadge source={s} link={link} />}
          </span>
        )
      })}
    </span>
  )
}

function CardTitle() {
  return (
    <h2 className="shrink-0 text-[11px] font-semibold tracking-wide text-foreground uppercase">
      Monitoring
    </h2>
  )
}

function ReadAgo({ iso }: { iso: string | null }) {
  if (!iso) return null
  return (
    <span className="inline-flex items-center gap-1 text-xs whitespace-nowrap text-muted-foreground">
      read <TimeCell iso={iso} />
    </span>
  )
}

/**
 * The monitoring card on a device's or VM's Overview. One header line: the
 * overall pill and how long while something is wrong, then each source with
 * its mixed badge, when it was read and Notify me. With problems, the body
 * is the problem rows and nothing else. Absent when nothing monitors the
 * object. `notify` is the Notify me scope: the device, or a VM's primary
 * address.
 *
 * `slot` places it: `banner` renders only with problems (full width above
 * the Overview's cards), `compact` only when all is clear (in the grid,
 * beside the first attribute card). Both read the same cached queries.
 */
export function MonitoringBar({
  target,
  notify,
  slot,
}: {
  target: MonitoringTarget
  notify?: { device: string } | { ip: string }
  slot?: "banner" | "compact"
}) {
  const { sources, overall, isLoading } = useMonitoringSources(target)
  if (isLoading)
    return slot === "banner" ? null : (
      <Loading className="min-h-0 flex-row py-2" />
    )
  if (sources.length === 0 || !overall) return null
  const rows = problemRows(sources)
  const total = Math.max(
    sources.reduce((a, s) => a + problemCount(s), 0),
    rows.length
  )
  const compact = total === 0 && !isProblem(overall)
  if ((slot === "banner" && compact) || (slot === "compact" && !compact))
    return null
  const read = earliest(sources.map((s) => s.readAt))
  const since = compact ? null : earliest(rows.map((r) => r.since))
  const shown = rows.slice(0, PROBLEM_LIMIT)
  // One source in one state: the overall pill is its badge, said once.
  const bare =
    !compact &&
    sources.length === 1 &&
    mixedEntries(stateCounts(sources[0])).length <= 1

  return (
    <section
      className="overflow-hidden rounded-lg border border-border bg-card"
      data-testid="monitoring-bar"
      data-compact={compact ? "" : undefined}
    >
      <div
        className={cn(
          "flex min-h-10 min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5",
          shown.length > 0 && "border-b border-border"
        )}
      >
        <CardTitle />
        {!compact && (
          <span className="inline-flex items-center gap-1.5">
            <OverallPill
              target={target}
              sources={sources}
              overall={overall}
              testId="monitoring-overall"
            />
            {since && (
              <span className="num text-xs whitespace-nowrap text-muted-foreground">
                since {lasted(since)}
              </span>
            )}
            <span aria-hidden className="ml-1.5 h-4 w-px bg-border" />
          </span>
        )}
        <SourceBadges target={target} sources={sources} bare={bare} />
        <span className="ml-auto inline-flex shrink-0 items-center gap-2">
          <ReadAgo iso={read} />
          {notify && (
            <NotifyMeButton
              device={"device" in notify ? notify.device : undefined}
              ip={"ip" in notify ? notify.ip : undefined}
            />
          )}
        </span>
      </div>
      {shown.length > 0 && (
        <div className="flex flex-col divide-y divide-border/60">
          {shown.map((r) => (
            <ProblemLine key={r.key} target={target} row={r} />
          ))}
          {total > shown.length && (
            <TargetLink
              target={target}
              place={{ tab: "monitoring", state: "problem" }}
              className="link flex h-8 items-center gap-1 rounded-none px-3 text-xs"
              data-testid="monitoring-view-all"
            >
              View all {total}
              <ArrowRight className="h-3 w-3" />
            </TargetLink>
          )}
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

/** The same overall pill, hover and click for the device and VM headers. */
export function MonitoringHeaderBadge({
  target,
}: {
  target: MonitoringTarget
}) {
  const { sources, overall } = useMonitoringSources(target, { items: false })
  if (sources.length === 0 || !overall) return null
  return (
    <OverallPill
      target={target}
      sources={sources}
      overall={overall}
      testId="monitoring-header-badge"
    />
  )
}
