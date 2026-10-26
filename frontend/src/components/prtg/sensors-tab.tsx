import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ReactNode, SyntheticEvent } from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { EthernetPort, ExternalLink, Globe, Network } from "lucide-react"
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts"

import { ApiError } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import type {
  PrtgChannel,
  PrtgDeviceLink,
  PrtgHistory,
  PrtgHistoryRange,
  PrtgSensor,
} from "@/lib/api"
import { labelTicks } from "@/lib/chart-axis"
import { useDateFormat } from "@/lib/datetime"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart"
import type { ChartConfig } from "@/components/ui/chart"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { EmptyState } from "@/components/empty-state"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { TimeCell } from "@/components/cells/time-ago"
import { CheckStatusBadge } from "@/components/monitoring/status-badge"
import { formatGaugeValue } from "@/components/gauge"
import {
  ChannelReading,
  ChannelTrend,
  bridgedPoints,
  currentLookup,
  seriesFor,
  steadyText,
  trendOf,
  useChannels,
  useHistory,
} from "./channel-view"
import { PinScopeProvider, PinToggle, sensorParent } from "./sensor-pins"
import { LinkActionsMenu, SensorActionsMenu } from "./sensor-actions"
import { AddSensorButtons, MANUAL_TAG } from "./add-sensor"
import { SensorStatePill, TileCorner } from "./tile-corner"
import { useMe } from "@/lib/use-me"
import {
  MonitoringSourceRow,
  SourceStateBadge,
  StateFilterNote,
  matchesState,
  prtgSource,
  sensorListSource,
} from "@/components/monitoring/monitoring-bar"
import type { SourceLink } from "@/components/monitoring/monitoring-bar"
import { useStatusLabels } from "@/components/monitoring/status-palette"

/** The device or VM whose PRTG sensors a surface shows. */
export type PrtgParent = { device: string } | { virtual_machine: string }

/** What a sensors section is narrowed to: a device or VM (its Sensors tab),
 * or one object the sensors watch - an address, an interface (device or
 * VM) or a service. */
export type PrtgScope =
  | PrtgParent
  | { ip_address: string }
  | { interface: string }
  | { service: string }

function parentQuery(scope: PrtgScope): string {
  const [key, value] = Object.entries(scope)[0]
  return `${key}=${encodeURIComponent(value)}`
}

function isParent(scope: PrtgScope): scope is PrtgParent {
  return "device" in scope || "virtual_machine" in scope
}

/** A 404 (integration off) or 403 (no grant on PRTG rows) is "nothing to
 * show", not an error on someone else's page. */
async function quiet<T>(fetcher: () => Promise<T>, empty: T): Promise<T> {
  try {
    return await fetcher()
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 403))
      return empty
    throw e
  }
}

/** The PRTG devices linked to this device or VM. Empty while the
 * integration is off, which is what hides the Sensors tab. */
export function usePrtgLinks(parent: PrtgParent, enabled = true) {
  const qs = parentQuery(parent)
  return useQuery({
    enabled,
    queryKey: ["prtg-links", qs],
    queryFn: () =>
      quiet(
        async () =>
          (await apiAll<PrtgDeviceLink>(`/api/prtg/links/?${qs}`)).results,
        [] as PrtgDeviceLink[]
      ),
    staleTime: 60_000,
    refetchInterval: 2 * 60_000,
  })
}

/** How many sensors a link counted at the last read. */
export function sensorTotal(link: PrtgDeviceLink): number {
  return (link.sensor_counts as Partial<Record<string, number>>).total ?? 0
}

/** How many sensors the links counted at the last read: the tab's count. */
export function linkedSensorCount(links: PrtgDeviceLink[] | undefined) {
  return (links ?? []).reduce((n, l) => n + sensorTotal(l), 0)
}

/** The sensors of a device or VM, or the ones watching one object. Empty
 * while the integration is off, which is what hides a Sensors tab. */
export function usePrtgSensors(scope: PrtgScope, enabled = true) {
  const qs = parentQuery(scope)
  return useQuery({
    queryKey: ["prtg-sensors", qs],
    queryFn: () =>
      quiet(
        async () =>
          (await apiAll<PrtgSensor>(`/api/prtg/sensors/?${qs}&ordering=alarms`))
            .results,
        [] as PrtgSensor[]
      ),
    enabled,
    staleTime: 60_000,
    refetchInterval: 2 * 60_000,
  })
}

/** Per-state counts of a sensor list, paused counted apart - the strip. */
export function countSensors(sensors: PrtgSensor[]) {
  const out = { down: 0, degraded: 0, up: 0, unknown: 0, paused: 0 }
  for (const s of sensors) {
    if (s.paused) out.paused++
    else if (s.state === "down" || s.state === "degraded" || s.state === "up")
      out[s.state]++
    else out.unknown++
  }
  return out
}

/**
 * A device's or VM's PRTG sensors, in Danbyte's language: the status strip
 * with the PRTG device and when it was read, then one card per sensor -
 * state, last value as the big number, last check, uptime, and PRTG's
 * message when it is not up. A card opens the sensor panel with its
 * channels. `selected` is the sensor whose panel is open (the page keeps it
 * in `?sensor=`).
 */
export function PrtgSensorsTab({
  parent,
  selected,
  onSelect,
  state,
  onState,
}: {
  parent: PrtgParent
  selected?: string
  onSelect: (id: string | null) => void
  /** The strip's filter (`?state=`): `problem`, a state, or `paused`. */
  state?: string
  onState?: (state: string | null) => void
}) {
  return (
    <PrtgSensorsSection
      scope={parent}
      selected={selected}
      onSelect={onSelect}
      state={state}
      onState={onState}
    />
  )
}

/**
 * PRTG's sensors for one scope, in the same shape everywhere: a strip, a
 * card per sensor, the sensor panel. On a device or VM the strip is the
 * PRTG device; on an address, interface or service it says which device the
 * sensors come from ("via db-dev01 in PRTG") and links to its Sensors tab.
 * Without `onSelect` the open panel is the section's own state.
 */
export function PrtgSensorsSection({
  scope,
  selected,
  onSelect,
  state,
  onState,
}: {
  scope: PrtgScope
  selected?: string
  onSelect?: (id: string | null) => void
  /** The strip's filter (`?state=`): `problem`, a state, or `paused`. */
  state?: string
  onState?: (state: string | null) => void
}) {
  const [own, setOwn] = useState<string | null>(null)
  const [fresh, flash] = useFreshSensors()
  const labels = useStatusLabels()
  const parent = isParent(scope)
  // Only a device or VM lists its PRTG devices.
  const links = usePrtgLinks(parent ? scope : { device: "" }, parent)
  const sensors = usePrtgSensors(scope)
  const current = onSelect ? selected : own
  const select = onSelect ?? setOwn
  if ((parent && links.isLoading) || sensors.isLoading) return <Loading />
  if (sensors.isError) return <QueryError error={sensors.error} />
  const rows = sensors.data ?? []
  const open = rows.find((s) => s.id === current) ?? null
  const shown = rows.filter((s) =>
    matchesState(state, s.paused ? "paused" : s.state || "unknown")
  )
  // The name and the badge show the problems; with a filter on, they clear it.
  const toggle: SourceLink = (children, filter) => (
    <button
      type="button"
      className="inline-flex rounded-[5px] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      aria-pressed={!!state}
      onClick={() => onState?.(state || !filter ? null : filter)}
    >
      {children}
    </button>
  )

  return (
    <PinScopeProvider scope={parent ? null : scope}>
      <div className="space-y-4">
        {!parent && <ViaStrips sensors={rows} />}
        {(parent ? (links.data ?? []) : []).map((link) => (
          <MonitoringSourceRow
            key={link.id}
            source={prtgSource(link, rows, labels)}
            link={toggle}
            active={state}
            actions={
              <span className="inline-flex items-center gap-1.5">
                <AddSensorButtons
                  target={{
                    linkId: link.id,
                    connectionId: link.connection,
                    name: link.name || link.objid,
                    writeMode: link.write_mode,
                  }}
                  onAdded={flash}
                />
                <LinkActionsMenu link={link} />
              </span>
            }
            className="min-h-10 rounded-lg border border-border bg-card px-3 py-1.5"
          />
        ))}
        {rows.length === 0 ? (
          <EmptyState title="No sensors.">
            {parent
              ? "PRTG has no sensors on this device yet."
              : "No PRTG sensor watches this."}
          </EmptyState>
        ) : (
          <>
            <StateFilterNote state={state} onClear={() => onState?.(null)} />
            {shown.length === 0 ? (
              <EmptyState title="No sensor matches." />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {shown.map((s) => (
                  <SensorCard
                    key={s.id}
                    sensor={s}
                    fresh={fresh.includes(s.objid)}
                    onOpen={() => select(s.id)}
                  />
                ))}
              </div>
            )}
          </>
        )}
        <SensorPanel sensor={open} onClose={() => select(null)} />
      </div>
    </PinScopeProvider>
  )
}

/** The device or VM a sensor sits on. */
function sensorOwner(s: PrtgSensor) {
  if (s.virtual_machine)
    return { key: `vm:${s.virtual_machine.id}`, ...s.virtual_machine, vm: true }
  if (s.device) return { key: `d:${s.device.id}`, ...s.device, vm: false }
  return null
}

/** A link to the Sensors tab of the device or VM a sensor sits on. */
export function OwnerSensorsLink({
  sensor,
  className,
  children,
}: {
  sensor: PrtgSensor
  className?: string
  children: ReactNode
}) {
  const owner = sensorOwner(sensor)
  if (!owner) return <>{children}</>
  return owner.vm ? (
    <Link
      to="/virtual-machines/$id"
      params={{ id: owner.id }}
      search={{ tab: "sensors" }}
      className={className}
    >
      {children}
    </Link>
  ) : (
    <Link
      to="/devices/$id"
      params={{ id: owner.id }}
      search={{ tab: "sensors" }}
      className={className}
    >
      {children}
    </Link>
  )
}

/**
 * Where an object's sensors come from: one strip per device or VM with its
 * state counts, "via db-dev01 in PRTG" linking to its Sensors tab, the PRTG
 * device in PRTG, and when it was read.
 */
function ViaStrips({ sensors }: { sensors: PrtgSensor[] }) {
  const labels = useStatusLabels()
  const groups = new Map<string, PrtgSensor[]>()
  for (const s of sensors) {
    const key = sensorOwner(s)?.key ?? s.connection
    groups.set(key, [...(groups.get(key) ?? []), s])
  }
  return (
    <>
      {[...groups.entries()].map(([key, rows]) => {
        const first = rows[0]
        const owner = sensorOwner(first)
        const readAt = rows
          .map((s) => s.last_seen_at)
          .filter((t): t is string => !!t)
          .sort()
          .at(-1)
        return (
          <div
            key={key}
            className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-[13px] sm:flex-nowrap"
            data-testid="prtg-via"
          >
            <SourceStateBadge source={sensorListSource(rows, labels, key)} />
            <span className="whitespace-nowrap text-muted-foreground">
              via{" "}
              <OwnerSensorsLink sensor={first} className="link font-medium">
                {owner?.name ?? first.prtg_device}
              </OwnerSensorsLink>{" "}
              in PRTG
            </span>
            <a
              href={first.device_url}
              target="_blank"
              rel="noreferrer"
              className="link inline-flex items-center gap-1 font-mono text-xs"
            >
              {first.prtg_device}
              <ExternalLink className="h-3 w-3" />
            </a>
            {readAt && (
              <span className="ml-auto inline-flex items-center gap-1 text-[11px] whitespace-nowrap text-muted-foreground">
                read <TimeCell iso={readAt} />
              </span>
            )}
          </div>
        )
      })}
    </>
  )
}

/**
 * What a sensor watches, as small chips that link to it: the address PRTG
 * reaches the device on, the interface a traffic sensor measures, the
 * service an HTTP or SSL sensor checks.
 */
export function SensorWatches({ sensor: s }: { sensor: PrtgSensor }) {
  if (!s.ip_address && !s.interface && !s.service) return null
  const stop = (e: SyntheticEvent) => e.stopPropagation()
  const chip = "max-w-full min-w-0 gap-1 hover:bg-muted"
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-1"
      data-testid="prtg-sensor-watches"
      onClick={stop}
      onKeyDown={stop}
    >
      {s.ip_address && (
        <WatchTip label="Address">
          <Badge variant="outline" className={chip} asChild>
            <Link to="/ips/$id" params={{ id: s.ip_address.id }}>
              <Network className="h-3 w-3 shrink-0" />
              <span className="truncate font-mono">{s.ip_address.address}</span>
            </Link>
          </Badge>
        </WatchTip>
      )}
      {s.interface && (
        <WatchTip label="Interface">
          <Badge variant="outline" className={chip} asChild>
            {s.interface.kind === "interface" ? (
              <Link to="/interfaces/$id" params={{ id: s.interface.id }}>
                <EthernetPort className="h-3 w-3 shrink-0" />
                <span className="truncate">{s.interface.name}</span>
              </Link>
            ) : (
              <Link
                to="/virtual-machines/$id"
                params={{ id: s.interface.parent }}
                search={{ tab: "components" }}
              >
                <EthernetPort className="h-3 w-3 shrink-0" />
                <span className="truncate">{s.interface.name}</span>
              </Link>
            )}
          </Badge>
        </WatchTip>
      )}
      {s.service && (
        <WatchTip label="Service">
          <Badge variant="outline" className={chip} asChild>
            <Link to="/services/$id" params={{ id: s.service.id }}>
              <Globe className="h-3 w-3 shrink-0" />
              <span className="truncate">{s.service.name}</span>
              {s.service.ports && (
                <span className="text-muted-foreground">{s.service.ports}</span>
              )}
            </Link>
          </Badge>
        </WatchTip>
      )}
    </div>
  )
}

function WatchTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent variant="default">{label}</TooltipContent>
    </Tooltip>
  )
}

/** The shared state pill - one pill, Paused when paused - with PRTG's own
 * word and message in the tooltip. */
export function PrtgSensorState({ sensor }: { sensor: PrtgSensor }) {
  return <SensorStatePill sensor={sensor} />
}

/** The corner controls this viewer may use on a sensor: pin, then the
 * actions menu. Left out without the grant, so the corner keeps only the
 * room it needs. */
function useSensorControls(s: PrtgSensor): ReactNode[] {
  const { canDo } = useMe()
  return [
    canDo("prtgsensorpin", "change") ? <PinToggle sensor={s} /> : null,
    canDo("prtgsensor", "change") ? <SensorActionsMenu sensor={s} /> : null,
  ]
}

/** "12.3 msec" -> ["12.3", "msec"]; a word ("Only Strong Protocols
 * Available") stays whole. */
function splitValue(s: PrtgSensor): [string, string] {
  const text = s.last_value || ""
  if (s.unit && text.endsWith(s.unit))
    return [text.slice(0, -s.unit.length).trim(), s.unit]
  return [text, ""]
}

/** PRTG's message on a card: two lines at most, ending in an ellipsis,
 * the whole text in the shared tooltip. The clamp sits on an inner block so
 * the box's padding cannot show a sliver of a third line. */
function SensorMessage({ message }: { message: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
          <p
            className="line-clamp-2 break-words"
            data-testid="prtg-sensor-message"
          >
            {message}
          </p>
        </div>
      </TooltipTrigger>
      <TooltipContent variant="default" className="max-w-sm break-words">
        {message}
      </TooltipContent>
    </Tooltip>
  )
}

/** The sensors just added from Danbyte (PRTG object ids), highlighted for a
 * few seconds once their cards appear. */
function useFreshSensors(): [string[], (objids: string[]) => void] {
  const [fresh, setFresh] = useState<string[]>([])
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )
  const flash = useCallback((objids: string[]) => {
    setFresh(objids)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setFresh([]), 4000)
  }, [])
  return [fresh, flash]
}

function SensorCard({
  sensor: s,
  fresh,
  onOpen,
}: {
  sensor: PrtgSensor
  /** Just added: a brief highlight. */
  fresh?: boolean
  onOpen: () => void
}) {
  const [num, unit] = splitValue(s)
  const notUp = s.state !== "up" || s.paused
  const controls = useSensorControls(s)
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          onOpen()
        }
      }}
      className={cn(
        "group/tile flex min-w-0 cursor-pointer flex-col gap-2 rounded-lg border border-border bg-card p-3 text-left transition-colors duration-700 hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        fresh && "border-primary bg-primary/5"
      )}
      data-testid="prtg-sensor-card"
      data-fresh={fresh || undefined}
    >
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{s.name}</p>
          <p className="truncate text-xs text-muted-foreground">
            {s.kind_label || s.kind}
          </p>
        </div>
        <TileCorner
          className="-mt-1 -mr-1"
          state={<SensorStatePill sensor={s} />}
          controls={controls}
        />
      </div>
      <p className="truncate leading-none">
        {num ? (
          <>
            <span className="num text-2xl font-semibold tracking-tight">
              {num}
            </span>
            {unit && (
              <span className="ml-1 text-sm text-muted-foreground">{unit}</span>
            )}
          </>
        ) : (
          <span className="text-sm text-muted-foreground">No value</span>
        )}
      </p>
      {notUp && s.message && <SensorMessage message={s.message} />}
      <SensorWatches sensor={s} />
      <div className="mt-auto flex items-center gap-3 text-[11px] whitespace-nowrap text-muted-foreground">
        {s.last_check_at && (
          <span className="inline-flex items-center gap-1">
            checked <TimeCell iso={s.last_check_at} />
          </span>
        )}
        {s.uptime_pct != null && (
          <span className="num">{s.uptime_pct.toFixed(2)}% uptime</span>
        )}
        {s.acknowledged && <Badge variant="secondary">Acknowledged</Badge>}
        {s.tags.includes(MANUAL_TAG) && (
          <Badge variant="outline" className="text-muted-foreground">
            Added from Danbyte
          </Badge>
        )}
        <a
          href={s.url}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="ml-auto hover:text-foreground"
          aria-label={`Open ${s.name} in PRTG`}
        >
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>
    </div>
  )
}

/**
 * The sensor panel: PRTG's sensor overview drawn the Danbyte way. A header
 * with the state, kind, PRTG device and a link into PRTG; PRTG's message;
 * then one card per channel - an arc gauge for a number, a segmented state
 * bar for a lookup - each with an hour's sparkline and a range switch for
 * its history.
 */
export function SensorPanel({
  sensor,
  onClose,
}: {
  sensor: PrtgSensor | null
  onClose: () => void
}) {
  const channels = useChannels(sensor?.id ?? null)
  const hour = useHistory(sensor?.id ?? null, "1h")
  const message = channels.data?.summary.message || sensor?.message || ""
  return (
    <Dialog open={!!sensor} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="5xl" data-testid="prtg-sensor-panel">
        {sensor && (
          <>
            <DialogHeader>
              <DialogTitle className="flex flex-wrap items-center gap-2 pr-8">
                {sensor.name}
                <SensorStatePill sensor={sensor} />
                {sensor.acknowledged && (
                  <Badge variant="secondary">Acknowledged</Badge>
                )}
                <span className="inline-flex items-center gap-0.5">
                  <PinToggle sensor={sensor} />
                  <SensorActionsMenu sensor={sensor} />
                </span>
              </DialogTitle>
              <DialogDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span>{sensor.kind_label || sensor.kind}</span>
                <span>{sensor.prtg_device}</span>
                {sensor.last_check_at && (
                  <span className="inline-flex items-center gap-1">
                    checked <TimeCell iso={sensor.last_check_at} />
                  </span>
                )}
                {sensor.uptime_pct != null && (
                  <span className="num">
                    {sensor.uptime_pct.toFixed(2)}% uptime
                  </span>
                )}
                <a
                  href={sensor.url}
                  target="_blank"
                  rel="noreferrer"
                  className="link inline-flex items-center gap-1"
                >
                  Open in PRTG
                  <ExternalLink className="h-3 w-3" />
                </a>
              </DialogDescription>
            </DialogHeader>
            {message && (sensor.state !== "up" || sensor.paused) && (
              <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
                {message}
              </p>
            )}
            {channels.isLoading ? (
              <Loading />
            ) : channels.isError ? (
              <QueryError error={channels.error} />
            ) : (channels.data?.rows ?? []).length === 0 ? (
              <EmptyState title="No channels." />
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {channels.data!.rows.map((c) => (
                    <ChannelCard
                      key={c.id}
                      sensor={sensor}
                      channel={c}
                      hour={hour.data}
                    />
                  ))}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Read from PRTG <TimeCell iso={channels.data!.fetched_at} />
                  {channels.data!.stale &&
                    " · PRTG did not answer, last read shown"}
                </p>
              </>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

export { currentLookup }

const RANGES: { value: PrtgHistoryRange; label: string }[] = [
  { value: "1h", label: "1h" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
]

/**
 * One channel in the panel: its reading, then what its history says. A
 * number that moved gets the hour's sparkline and the range switch for its
 * graph; a number that did not says it was steady; a lookup gets its state
 * timeline for the chosen range; text and channels with too little history
 * get nothing under the reading.
 */
function ChannelCard({
  sensor,
  channel: c,
  hour,
}: {
  sensor: PrtgSensor
  channel: PrtgChannel
  hour: PrtgHistory | undefined
}) {
  const [range, setRange] = useState<PrtgHistoryRange | "">("")
  const series = seriesFor(hour, c.id)
  const trend = trendOf(c, series)
  const lookup = c.kind === "lookup"
  // A lookup's range switch moves its timeline; a number's opens its graph.
  const timelineRange: PrtgHistoryRange = range || "1h"
  const ranged = useHistory(lookup && range ? sensor.id : null, range || null)
  const showSwitch = lookup || trend.kind === "line" || trend.kind === "steady"
  const { canDo } = useMe()
  const pinnable = !!sensorParent(sensor) && canDo("prtgsensorpin", "change")
  return (
    <div
      className="group/tile flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-card p-3"
      data-testid="prtg-channel-card"
      data-kind={c.kind}
    >
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 truncate text-[13px] font-medium">
          {c.name}
        </p>
        <TileCorner
          className="-mt-1 -mr-1"
          state={c.status ? <CheckStatusBadge status={c.state} /> : undefined}
          controls={
            pinnable ? [<PinToggle sensor={sensor} channelId={c.id} />] : []
          }
        />
      </div>
      <div className="flex min-h-[84px] items-center justify-center">
        <ChannelReading channel={c} />
      </div>
      {(showSwitch || trend.kind !== "none") && (
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            {lookup ? (
              <ChannelTrend
                channel={c}
                series={range ? seriesFor(ranged.data, c.id) : series}
                range={timelineRange}
              />
            ) : (
              <ChannelTrend channel={c} series={series} range="1h" />
            )}
          </div>
          {showSwitch && (
            <SegmentedTabs
              className="ml-auto shrink-0"
              value={range}
              onValueChange={(v) => setRange(v === range ? "" : v)}
              items={RANGES}
            />
          )}
        </div>
      )}
      {range && !lookup && (
        <ChannelHistory sensorId={sensor.id} channel={c} range={range} />
      )}
    </div>
  )
}

const CONFIG = {
  v: { label: "Value", color: "var(--chart-1)" },
} satisfies ChartConfig

/** A number's history graph for one range, in the channel's own unit. The
 * same rule as the sparkline: two values at least, and a flat range says
 * "steady" instead of drawing a flat line. */
function ChannelHistory({
  sensorId,
  channel,
  range,
}: {
  sensorId: string
  channel: PrtgChannel
  range: PrtgHistoryRange
}) {
  const { formatCustom } = useDateFormat()
  const q = useHistory(sensorId, range)
  const series = seriesFor(q.data, channel.id)
  // The channel's unit, never the history's: PRTG reports some channels'
  // history as a percentage of time, which is not what the channel measures.
  const unit = channel.unit
  const data = useMemo(
    () =>
      bridgedPoints(series?.points ?? []).map((p) => ({
        t: p.t,
        v: p.v,
        label: formatCustom(
          p.t,
          range === "7d"
            ? { month: "short", day: "numeric", hour: "2-digit" }
            : { hour: "2-digit", minute: "2-digit" }
        ),
      })),
    [series, range, formatCustom]
  )
  if (q.isLoading) return <Loading />
  if (q.isError) return <QueryError error={q.error} />
  const trend = trendOf(channel, series)
  if (trend.kind === "none")
    return (
      <p
        className="py-4 text-center text-xs text-muted-foreground"
        data-testid="prtg-history-empty"
      >
        Not enough history in this range.
      </p>
    )
  if (trend.kind === "steady")
    return (
      <p
        className="py-4 text-center text-xs text-muted-foreground"
        data-testid="prtg-steady"
      >
        <span className="num font-medium text-foreground">
          {formatGaugeValue(trend.value)}
          {unit ? ` ${unit}` : ""}
        </span>{" "}
        · {steadyText(range)}
      </p>
    )
  return (
    <ChartContainer
      config={CONFIG}
      className={cn("aspect-auto h-[140px] w-full")}
      data-testid="prtg-history-chart"
    >
      <LineChart
        accessibilityLayer
        data={data}
        margin={{ left: 0, right: 8, top: 4 }}
      >
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="t"
          tickFormatter={labelTicks(data, "t")}
          tickLine={false}
          axisLine={false}
          tickMargin={6}
          minTickGap={32}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={48}
          domain={["auto", "auto"]}
          tickFormatter={(v: number) =>
            `${formatGaugeValue(v)}${unit ? ` ${unit}` : ""}`
          }
        />
        <ChartTooltip
          cursor={false}
          content={
            <ChartTooltipContent
              labelFormatter={(_l, items) =>
                (items[0]?.payload as { label?: string } | undefined)?.label ??
                _l
              }
              formatter={(value) => (
                <span className="num">
                  {String(value)}
                  {unit ? ` ${unit}` : ""}
                </span>
              )}
            />
          }
        />
        <Line
          dataKey="v"
          type="monotone"
          stroke="var(--color-v)"
          strokeWidth={2}
          // The empty points between a sparse sensor's samples are left out
          // (bridgedPoints), so only a real gap breaks the line; a value
          // between two gaps has no neighbour, and its dot shows it.
          dot={{ r: 1.5 }}
          connectNulls={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ChartContainer>
  )
}
