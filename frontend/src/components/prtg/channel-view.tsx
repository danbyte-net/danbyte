import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type {
  PrtgChannel,
  PrtgChannels,
  PrtgHistory,
  PrtgHistoryRange,
  PrtgPinDisplay,
} from "@/lib/api"
import { cn } from "@/lib/utils"
import { Gauge, formatGaugeValue } from "@/components/gauge"
import { LookupBar } from "@/components/lookup-bar"
import type { LookupTone } from "@/components/lookup-bar"
import { Sparkline } from "@/components/sparkline"

// One channel of a PRTG sensor, drawn the same way wherever it appears: the
// sensor panel, a dashboard's Sensor widget and the pinned tiles on a
// device's or VM's Overview. The rules that decide whether a channel gets a
// chart live here too, so a sparkline and a history graph never disagree.

/** The sensor's channels, read from PRTG when first asked for and reused
 * for one status interval on the server. One query per sensor, shared by
 * the panel, the widgets and the Overview tiles. */
export function useChannels(sensorId: string | null, refetchMs?: number) {
  return useQuery({
    queryKey: ["prtg-channels", sensorId],
    queryFn: () => api<PrtgChannels>(`/api/prtg/sensors/${sensorId}/channels/`),
    enabled: !!sensorId,
    staleTime: 60_000,
    refetchInterval: refetchMs,
  })
}

/** Every channel's history for one range: one request serves every card. */
export function useHistory(
  sensorId: string | null,
  range: PrtgHistoryRange | null,
  refetchMs?: number
) {
  return useQuery({
    queryKey: ["prtg-history", sensorId, range],
    queryFn: () =>
      api<PrtgHistory>(`/api/prtg/sensors/${sensorId}/history/?range=${range}`),
    enabled: !!sensorId && !!range,
    staleTime: 60_000,
    refetchInterval: refetchMs,
  })
}

export type HistorySeries = PrtgHistory["channels"][number]

/** The channel's series in a history answer, by id. */
export function seriesFor(
  history: PrtgHistory | undefined,
  channelId: string
): HistorySeries | undefined {
  return history?.channels.find((h) => h.id === channelId)
}

/** The channel a caller asked for: by id, or the primary one for "". */
export function pickChannel(
  rows: PrtgChannel[] | undefined,
  id: string | undefined | null
): PrtgChannel | undefined {
  if (!rows?.length) return undefined
  if (id) return rows.find((c) => c.id === id)
  return rows.find((c) => c.primary) ?? rows[0]
}

export const LOOKUP_TONE: Record<string, LookupTone> = {
  ok: "ok",
  warning: "warning",
  error: "error",
}

export function lookupKey(s: { value: number; to: number | null }) {
  return s.to != null ? `${s.value}-${s.to}` : String(s.value)
}

type LookupEntry = PrtgChannel["lookup_states"][number]

function lookupFor(c: PrtgChannel, v: number): LookupEntry | undefined {
  return c.lookup_states.find((s) =>
    s.to != null ? v >= s.value && v <= s.to : s.value === v
  )
}

/** The lookup state the raw value falls in - a single value or a range. */
export function currentLookup(c: PrtgChannel): string | null {
  if (c.value_raw == null) return null
  const hit = lookupFor(c, c.value_raw)
  return hit ? lookupKey(hit) : null
}

/** A number or a percentage - the channels a line can say something about. */
export function isNumeric(c: PrtgChannel): boolean {
  return c.kind === "number" || c.kind === "percent"
}

/**
 * What a channel's history amounts to, for a sparkline and a history graph
 * alike:
 * - `none`: text, or fewer than two values in the range - nothing to draw;
 * - `steady`: one value over the whole range - say so, no flat line;
 * - `line`: a number that moved - draw it;
 * - `timeline`: a lookup - its states along the range, never a line.
 */
export type Trend =
  | { kind: "none" }
  | { kind: "steady"; value: number }
  | { kind: "line"; values: (number | null)[] }
  | { kind: "timeline" }

export function trendOf(
  c: PrtgChannel,
  series: HistorySeries | undefined
): Trend {
  if (c.kind === "lookup") return { kind: "timeline" }
  if (!isNumeric(c)) return { kind: "none" }
  const values = (series?.points ?? []).map((p) => p.v)
  const nums = values.filter((v): v is number => v != null)
  if (nums.length < 2) return { kind: "none" }
  if (nums.every((v) => v === nums[0]))
    return { kind: "steady", value: nums[0] }
  return { kind: "line", values }
}

const RANGE_WORDS: Record<PrtgHistoryRange, string> = {
  "1h": "1h",
  "24h": "24h",
  "7d": "7 days",
}

export function steadyText(range: PrtgHistoryRange): string {
  return `Steady over the last ${RANGE_WORDS[range]}`
}

/** "Root Authority Trusted (Yes)" for channel "Root Authority Trusted" is
 * "Yes": the lookup state PRTG's history measured the time spent in. */
function referenceLabel(c: PrtgChannel, series: HistorySeries): string | null {
  const name = series.name.trim()
  if (!name.startsWith(c.name)) return null
  const rest = name.slice(c.name.length).trim()
  if (!rest.startsWith("(") || !rest.endsWith(")")) return null
  return rest.slice(1, -1).trim() || null
}

/**
 * The lookup state at each history point. PRTG reports a lookup channel's
 * history two ways: as the share of each interval spent in one named state
 * ("Root Authority Trusted (Yes)", 0 %), or as the raw lookup value. The
 * share reads as that state at half or more, otherwise the other state of a
 * two-state lookup; anything else is the value looked up directly.
 */
export function lookupStatesAt(
  c: PrtgChannel,
  series: HistorySeries | undefined
): (LookupEntry | null)[] {
  if (!series) return []
  const ref = series.unit === "%" ? referenceLabel(c, series) : null
  const refState = ref
    ? c.lookup_states.find((s) => s.label === ref)
    : undefined
  return series.points.map((p) => {
    if (p.v == null) return null
    if (refState) {
      if (p.v >= 50) return refState
      const others = c.lookup_states.filter((s) => s !== refState)
      return others.length === 1 ? others[0] : null
    }
    return lookupFor(c, Math.round(p.v)) ?? null
  })
}

const TONE_FILL: Record<LookupTone, string> = {
  ok: "bg-emerald-500 dark:bg-emerald-400",
  warning: "bg-amber-500 dark:bg-amber-400",
  error: "bg-destructive",
  neutral: "bg-muted-foreground/60",
}

/**
 * A lookup channel's states along the range: one coloured segment per run of
 * the same state, sized by how long it lasted, gaps where PRTG has nothing,
 * and the range's start and end under it. No axis, no percentages.
 */
export function LookupTimeline({
  channel,
  series,
  range,
  className,
}: {
  channel: PrtgChannel
  series: HistorySeries | undefined
  range: PrtgHistoryRange
  className?: string
}) {
  const states = lookupStatesAt(channel, series)
  const runs: { key: string; entry: LookupEntry | null; n: number }[] = []
  for (const s of states) {
    const key = s ? lookupKey(s) : ""
    const last = runs.at(-1)
    if (last && last.key === key) last.n++
    else runs.push({ key, entry: s, n: 1 })
  }
  if (!runs.some((r) => r.entry))
    return (
      <p
        className={cn("text-[11px] text-muted-foreground", className)}
        data-testid="prtg-lookup-timeline"
      >
        No history in this range.
      </p>
    )
  return (
    <div
      className={cn("w-full min-w-0", className)}
      data-testid="prtg-lookup-timeline"
    >
      <div
        className="flex h-2.5 gap-px overflow-hidden rounded-md"
        role="img"
        aria-label={`${channel.name}, last ${RANGE_WORDS[range]}: ${runs
          .filter((r) => r.entry)
          .map((r) => r.entry!.label)
          .join(", ")}`}
      >
        {runs.map((r, i) => (
          <span
            key={i}
            data-state={r.entry?.label ?? ""}
            data-tone={r.entry ? (LOOKUP_TONE[r.entry.state] ?? "neutral") : ""}
            style={{ flexGrow: r.n }}
            className={cn(
              "h-full basis-0",
              r.entry
                ? TONE_FILL[LOOKUP_TONE[r.entry.state] ?? "neutral"]
                : "bg-muted"
            )}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
        <span>{RANGE_WORDS[range]} ago</span>
        <span>now</span>
      </div>
    </div>
  )
}

/** The channel's value as text with its unit: "781 #", "No". */
export function channelText(c: PrtgChannel): string {
  if (c.kind === "lookup") return c.lookup_label || c.value
  if (isNumeric(c) && c.value_raw != null)
    return `${formatGaugeValue(c.value_raw)}${c.unit ? ` ${c.unit}` : ""}`
  return c.value
}

/**
 * The channel's reading: an arc gauge for a number, the segmented bar for a
 * lookup, the text for text, and "No value" when PRTG has none. `display`
 * overrides the choice (a widget or a pin may ask for the plain value).
 */
export function ChannelReading({
  channel: c,
  display = "auto",
  compact = false,
}: {
  channel: PrtgChannel
  display?: PrtgPinDisplay
  compact?: boolean
}) {
  const noValue =
    (isNumeric(c) && c.value_raw == null) ||
    (c.kind === "lookup" && c.value_raw == null && !c.lookup_label) ||
    (c.kind === "text" && !c.value)
  if (noValue)
    return (
      <p
        className="text-center text-sm text-muted-foreground"
        data-testid="prtg-no-value"
      >
        No value
      </p>
    )
  const mode =
    display === "auto"
      ? c.kind === "lookup"
        ? "lookup"
        : isNumeric(c)
          ? "gauge"
          : "value"
      : display
  if (mode === "lookup" && c.kind === "lookup")
    return (
      <LookupBar
        states={c.lookup_states.map((s) => ({
          key: lookupKey(s),
          label: s.label,
          tone: LOOKUP_TONE[s.state] ?? "neutral",
        }))}
        current={currentLookup(c)}
        label={c.lookup_label || c.value}
      />
    )
  if (mode === "gauge" && isNumeric(c))
    return (
      <Gauge
        value={c.value_raw}
        unit={c.unit}
        min={c.min ?? 0}
        max={c.max ?? 100}
        warn={{ below: c.limits.warn_min, above: c.limits.warn_max }}
        error={{ below: c.limits.error_min, above: c.limits.error_max }}
        label={c.name}
        className={compact ? "max-w-[140px]" : undefined}
      />
    )
  return (
    <p
      className={cn(
        "text-center font-medium",
        isNumeric(c) ? "num text-2xl tracking-tight" : "text-sm"
      )}
      data-testid="prtg-channel-value"
    >
      {channelText(c)}
    </p>
  )
}

/**
 * The one-line trend under a reading: the sparkline when the number moved,
 * "Steady over the last 1h" when it did not, the state timeline for a
 * lookup, nothing for text or too little history.
 */
export function ChannelTrend({
  channel,
  series,
  range,
  className,
  width = 120,
}: {
  channel: PrtgChannel
  series: HistorySeries | undefined
  range: PrtgHistoryRange
  className?: string
  width?: number
}) {
  const t = trendOf(channel, series)
  if (t.kind === "timeline")
    return (
      <LookupTimeline
        channel={channel}
        series={series}
        range={range}
        className={className}
      />
    )
  if (t.kind === "steady")
    return (
      <p
        className={cn("text-[11px] text-muted-foreground", className)}
        data-testid="prtg-steady"
      >
        {steadyText(range)}
      </p>
    )
  if (t.kind === "line")
    return (
      <Sparkline
        values={t.values}
        label={`${channel.name}, last ${RANGE_WORDS[range]}`}
        className={cn("min-w-0", className)}
        width={width}
      />
    )
  return null
}
