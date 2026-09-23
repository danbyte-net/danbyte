import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts"

import { useState } from "react"

import type { CheckFigures } from "@/lib/api"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart"
import type { ChartConfig } from "@/components/ui/chart"
import { SeriesLegend } from "@/components/monitoring/series-legend"
import { useDateFormat } from "@/lib/datetime"

// Charts drawn from rollup points - one per hour or per day - as the check
// page and the latency page read them. The raw-probe chart is LatencyChart.

type Point = CheckFigures & { t: string }

function useLabel(daily: boolean) {
  const { formatCustom } = useDateFormat()
  return (t: string) =>
    daily
      ? formatCustom(t, { month: "short", day: "numeric" })
      : formatCustom(t, { weekday: "short", hour: "2-digit" })
}

const LATENCY = {
  p50: { label: "Median", color: "var(--chart-1)" },
  p95: { label: "95th percentile", color: "var(--chart-3)" },
  spikes: { label: "Spikes", color: "var(--color-red-500)" },
} satisfies ChartConfig

const LATENCY_SERIES = (["p50", "p95", "spikes"] as const).map((k) => ({
  key: k,
  label: LATENCY[k].label,
  color: LATENCY[k].color,
}))

/**
 * p50 and p95 per bucket against the check's own baseline, with the spikes
 * counted in each bucket as bars on their own axis. The dashed line is what
 * this check usually does; the dotted one is where a probe becomes a spike.
 */
export function RollupLatencyChart({
  series,
  daily,
  baseline,
  threshold,
  className = "h-[220px]",
}: {
  series: Point[]
  daily: boolean
  baseline?: number | null
  threshold?: number | null
  className?: string
}) {
  const label = useLabel(daily)
  const [hidden, setHidden] = useState<Set<string>>(() => new Set())
  const data = series
    .filter((p) => p.samples > 0)
    .map((p) => ({ ...p, label: label(p.t) }))
  if (!data.length)
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        No latency recorded in this window.
      </p>
    )
  return (
    <div>
      <ChartContainer
        config={LATENCY}
        className={`aspect-auto w-full ${className}`}
      >
        <ComposedChart data={data} margin={{ left: 0, right: 12, top: 4 }}>
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            tickMargin={6}
            minTickGap={32}
          />
          <YAxis
            yAxisId="ms"
            tickLine={false}
            axisLine={false}
            width={56}
            tickFormatter={(v: number) => `${v} ms`}
          />
          {/* Spikes stay in the bottom quarter: a count, not a latency, and
              it must not read as one. */}
          <YAxis
            yAxisId="n"
            orientation="right"
            hide
            allowDecimals={false}
            domain={[0, (max: number) => Math.max(max * 4, 4)]}
          />
          <ChartTooltip
            cursor={false}
            content={<ChartTooltipContent indicator="line" />}
          />
          <Bar
            yAxisId="n"
            dataKey="spikes"
            fill="var(--color-spikes)"
            fillOpacity={0.35}
            radius={2}
            hide={hidden.has("spikes")}
          />
          {baseline != null && (
            <ReferenceLine
              yAxisId="ms"
              y={baseline}
              stroke="var(--muted-foreground)"
              strokeDasharray="4 4"
            />
          )}
          {threshold != null && (
            <ReferenceLine
              yAxisId="ms"
              y={threshold}
              stroke="var(--color-red-500)"
              strokeOpacity={0.5}
              strokeDasharray="1 3"
            />
          )}
          <Line
            yAxisId="ms"
            dataKey="p95"
            type="monotone"
            stroke="var(--color-p95)"
            strokeWidth={2}
            dot={false}
            connectNulls
            hide={hidden.has("p95")}
          />
          <Line
            yAxisId="ms"
            dataKey="p50"
            type="monotone"
            stroke="var(--color-p50)"
            strokeWidth={2}
            dot={false}
            connectNulls
            hide={hidden.has("p50")}
          />
        </ComposedChart>
      </ChartContainer>
      <SeriesLegend
        items={LATENCY_SERIES}
        hidden={hidden}
        onChange={setHidden}
        className="mt-2"
      />
    </div>
  )
}

const AVAIL = {
  availability: { label: "Availability", color: "var(--color-emerald-500)" },
} satisfies ChartConfig

function barTone(pct: number | null): string {
  if (pct == null) return "var(--muted)"
  if (pct >= 99.9) return "var(--color-emerald-500)"
  if (pct >= 99) return "var(--color-amber-500)"
  return "var(--color-red-500)"
}

/** Availability per bucket, tier as colour - the same reading as the daily
 * bars on an address, from the rollups instead of the transitions. */
export function RollupAvailabilityChart({
  series,
  daily,
}: {
  series: Point[]
  daily: boolean
}) {
  const label = useLabel(daily)
  // Buckets before the check was first measured are not a result; start at
  // the first one that was.
  const first = series.findIndex((p) => p.availability != null)
  const shown = first < 0 ? [] : series.slice(first)
  if (!shown.length) return null
  const floor = Math.min(
    95,
    ...shown.map((p) => Math.floor(p.availability ?? 100))
  )
  const data = shown.map((p) => ({
    ...p,
    label: label(p.t),
    // An unmeasured bucket sits at the floor, in the muted tone, as a gap.
    value: p.availability ?? floor,
    fill: barTone(p.availability),
  }))
  return (
    <ChartContainer config={AVAIL} className="aspect-auto h-[120px] w-full">
      <BarChart data={data} margin={{ left: 0, right: 8, top: 4 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tickMargin={6}
          minTickGap={24}
        />
        <YAxis
          domain={[floor, 100]}
          allowDataOverflow
          tickLine={false}
          axisLine={false}
          width={44}
          tickFormatter={(v: number) => `${v}%`}
        />
        <ChartTooltip
          cursor={false}
          content={
            <ChartTooltipContent
              hideIndicator
              formatter={(_v, _n, item) => {
                const p = item.payload as unknown as Point
                return p.availability == null
                  ? "Nothing measured"
                  : `${p.availability}% · ${p.incidents} incident${p.incidents === 1 ? "" : "s"}`
              }}
            />
          }
        />
        <Bar dataKey="value" radius={2}>
          {data.map((p) => (
            <Cell key={p.t} fill={p.fill} />
          ))}
        </Bar>
      </BarChart>
    </ChartContainer>
  )
}
