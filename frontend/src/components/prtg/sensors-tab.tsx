import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { ExternalLink } from "lucide-react"
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
import { PinToggle } from "./sensor-pins"
import { PrtgStateStrip } from "./sensor-strip"

/** The device or VM whose PRTG sensors a surface shows. */
export type PrtgParent = { device: string } | { virtual_machine: string }

function parentQuery(parent: PrtgParent): string {
  return "device" in parent
    ? `device=${parent.device}`
    : `virtual_machine=${parent.virtual_machine}`
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
export function usePrtgLinks(parent: PrtgParent) {
  const qs = parentQuery(parent)
  return useQuery({
    queryKey: ["prtg-links", qs],
    queryFn: () =>
      quiet(
        async () =>
          (await apiAll<PrtgDeviceLink>(`/api/prtg/links/?${qs}`)).results,
        [] as PrtgDeviceLink[]
      ),
    staleTime: 60_000,
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

export function usePrtgSensors(parent: PrtgParent, enabled = true) {
  const qs = parentQuery(parent)
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
}: {
  parent: PrtgParent
  selected?: string
  onSelect: (id: string | null) => void
}) {
  const links = usePrtgLinks(parent)
  const sensors = usePrtgSensors(parent)
  if (links.isLoading || sensors.isLoading) return <Loading />
  if (sensors.isError) return <QueryError error={sensors.error} />
  const rows = sensors.data ?? []
  const open = rows.find((s) => s.id === selected) ?? null

  return (
    <div className="space-y-4">
      {(links.data ?? []).map((link) => (
        <div
          key={link.id}
          className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-card px-3 py-2 text-[13px]"
        >
          <PrtgStateStrip
            summary={countSensors(
              rows.filter((s) => s.connection === link.connection)
            )}
          />
          <a
            href={link.url}
            target="_blank"
            rel="noreferrer"
            className="link inline-flex items-center gap-1 font-mono text-xs"
          >
            {link.name || link.objid}
            <ExternalLink className="h-3 w-3" />
          </a>
          {link.status_read_at && (
            <span className="ml-auto inline-flex items-center gap-1 text-[11px] whitespace-nowrap text-muted-foreground">
              read <TimeCell iso={link.status_read_at} />
            </span>
          )}
        </div>
      ))}
      {rows.length === 0 ? (
        <EmptyState title="No sensors.">
          PRTG has no sensors on this device yet.
        </EmptyState>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((s) => (
            <SensorCard key={s.id} sensor={s} onOpen={() => onSelect(s.id)} />
          ))}
        </div>
      )}
      <SensorPanel sensor={open} onClose={() => onSelect(null)} />
    </div>
  )
}

/** The shared state pill, PRTG's own word for it in the tooltip. */
export function PrtgSensorState({ sensor }: { sensor: PrtgSensor }) {
  return (
    <span className="inline-flex items-center gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <CheckStatusBadge status={sensor.state || "unknown"} />
          </span>
        </TooltipTrigger>
        <TooltipContent variant="default">
          {sensor.status || "Unknown"} in PRTG
        </TooltipContent>
      </Tooltip>
      {sensor.paused && <Badge variant="outline">Paused</Badge>}
      {sensor.acknowledged && <Badge variant="secondary">Acknowledged</Badge>}
    </span>
  )
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

function SensorCard({
  sensor: s,
  onOpen,
}: {
  sensor: PrtgSensor
  onOpen: () => void
}) {
  const [num, unit] = splitValue(s)
  const notUp = s.state !== "up" || s.paused
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          onOpen()
        }
      }}
      className="flex min-w-0 cursor-pointer flex-col gap-2 rounded-lg border border-border bg-card p-3 text-left transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      data-testid="prtg-sensor-card"
    >
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{s.name}</p>
          <p className="truncate text-xs text-muted-foreground">
            {s.kind_label || s.kind}
          </p>
        </div>
        <PrtgSensorState sensor={s} />
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
      <div className="mt-auto flex items-center gap-3 text-[11px] whitespace-nowrap text-muted-foreground">
        {s.last_check_at && (
          <span className="inline-flex items-center gap-1">
            checked <TimeCell iso={s.last_check_at} />
          </span>
        )}
        {s.uptime_pct != null && (
          <span className="num">{s.uptime_pct.toFixed(2)}% up</span>
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
              <DialogTitle className="flex flex-wrap items-center gap-2">
                {sensor.name}
                <PrtgSensorState sensor={sensor} />
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
                    {sensor.uptime_pct.toFixed(2)}% up
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
  return (
    <div
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-card p-3"
      data-testid="prtg-channel-card"
      data-kind={c.kind}
    >
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 truncate text-[13px] font-medium">
          {c.name}
        </p>
        {c.state !== "up" && c.status && <CheckStatusBadge status={c.state} />}
        <PinToggle sensor={sensor} channelId={c.id} />
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
