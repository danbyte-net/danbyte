import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { ExternalLink } from "lucide-react"
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts"

import { ApiError, api } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import type {
  PrtgChannel,
  PrtgChannels,
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
import { Gauge } from "@/components/gauge"
import { Loading } from "@/components/loading"
import { LookupBar } from "@/components/lookup-bar"
import type { LookupTone } from "@/components/lookup-bar"
import { QueryError } from "@/components/query-error"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { Sparkline } from "@/components/sparkline"
import { TimeCell } from "@/components/cells/time-ago"
import { CheckStatusBadge } from "@/components/monitoring/status-badge"
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
      {notUp && s.message && (
        <p
          className="line-clamp-2 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground"
          data-testid="prtg-sensor-message"
        >
          {s.message}
        </p>
      )}
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

/** The sensor's channels, read from PRTG when the panel opens and reused
 * for one status interval on the server. */
function useChannels(sensorId: string | null) {
  return useQuery({
    queryKey: ["prtg-channels", sensorId],
    queryFn: () => api<PrtgChannels>(`/api/prtg/sensors/${sensorId}/channels/`),
    enabled: !!sensorId,
    staleTime: 60_000,
  })
}

/** Every channel's history for one range: one request serves every card. */
function useHistory(sensorId: string | null, range: PrtgHistoryRange | null) {
  return useQuery({
    queryKey: ["prtg-history", sensorId, range],
    queryFn: () =>
      api<PrtgHistory>(`/api/prtg/sensors/${sensorId}/history/?range=${range}`),
    enabled: !!sensorId && !!range,
    staleTime: 60_000,
  })
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
                      sensorId={sensor.id}
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

const LOOKUP_TONE: Record<string, LookupTone> = {
  ok: "ok",
  warning: "warning",
  error: "error",
}

function lookupKey(s: { value: number; to: number | null }) {
  return s.to != null ? `${s.value}-${s.to}` : String(s.value)
}

/** The lookup state the raw value falls in - a single value or a range. */
export function currentLookup(c: PrtgChannel): string | null {
  if (c.value_raw == null) return null
  const hit = c.lookup_states.find((s) =>
    s.to != null
      ? c.value_raw! >= s.value && c.value_raw! <= s.to
      : s.value === c.value_raw
  )
  return hit ? lookupKey(hit) : null
}

const RANGES: { value: PrtgHistoryRange; label: string }[] = [
  { value: "1h", label: "1h" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
]

function ChannelCard({
  sensorId,
  channel: c,
  hour,
}: {
  sensorId: string
  channel: PrtgChannel
  hour: PrtgHistory | undefined
}) {
  const [range, setRange] = useState<PrtgHistoryRange | "">("")
  const spark = hour?.channels.find((h) => h.id === c.id)?.points ?? []
  const warn = { below: c.limits.warn_min, above: c.limits.warn_max }
  const error = { below: c.limits.error_min, above: c.limits.error_max }
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
      </div>
      <div className="flex min-h-[84px] items-center justify-center">
        {c.kind === "lookup" ? (
          <LookupBar
            states={c.lookup_states.map((s) => ({
              key: lookupKey(s),
              label: s.label,
              tone: LOOKUP_TONE[s.state] ?? "neutral",
            }))}
            current={currentLookup(c)}
            label={c.lookup_label || c.value}
          />
        ) : c.kind === "text" ? (
          <p className="text-center text-sm font-medium">{c.value || "-"}</p>
        ) : (
          <Gauge
            value={c.value_raw}
            unit={c.unit}
            min={c.min ?? 0}
            max={c.max ?? 100}
            warn={warn}
            error={error}
            label={c.name}
          />
        )}
      </div>
      <div className="flex items-center gap-2">
        {c.kind !== "text" && (
          <Sparkline
            values={spark.map((p) => p.v)}
            label={`${c.name}, last hour`}
            className="min-w-0 flex-1"
            width={120}
          />
        )}
        <SegmentedTabs
          className="ml-auto"
          value={range}
          onValueChange={(v) => setRange(v === range ? "" : v)}
          items={RANGES}
        />
      </div>
      {range && (
        <ChannelHistory sensorId={sensorId} channel={c} range={range} />
      )}
    </div>
  )
}

const CONFIG = {
  v: { label: "Value", color: "var(--chart-1)" },
} satisfies ChartConfig

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
  const series = q.data?.channels.find((h) => h.id === channel.id)
  const unit = series?.unit || channel.unit
  const data = useMemo(
    () =>
      (series?.points ?? []).map((p) => ({
        t: p.t,
        v: p.v,
        label: formatCustom(
          p.t,
          range === "1h"
            ? { hour: "2-digit", minute: "2-digit" }
            : range === "24h"
              ? { hour: "2-digit", minute: "2-digit" }
              : { month: "short", day: "numeric", hour: "2-digit" }
        ),
      })),
    [series, range, formatCustom]
  )
  if (q.isLoading) return <Loading />
  if (q.isError) return <QueryError error={q.error} />
  if (data.every((d) => d.v == null))
    return (
      <p className="py-4 text-center text-xs text-muted-foreground">
        No values in this range.
      </p>
    )
  return (
    <ChartContainer
      config={CONFIG}
      className={cn("aspect-auto h-[140px] w-full")}
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
          tickFormatter={(v: number) => `${v}${unit ? ` ${unit}` : ""}`}
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
          dot={false}
          connectNulls={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ChartContainer>
  )
}
