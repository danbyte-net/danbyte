import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from "recharts"

import { useState } from "react"

import type { DashboardData } from "@/lib/api"
import { SeriesLegend } from "@/components/monitoring/series-legend"
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  countAxisWidth,
} from "@/components/ui/chart"
import type { ChartConfig } from "@/components/ui/chart"
import { useDateFormat } from "@/lib/datetime"

// Seven-day monitoring charts for the dashboard, from the payload the page
// already fetches - the same data the Monitoring overview draws over its
// chosen window, fixed at a week here.

const ALERTS = {
  opened: { label: "Opened", color: "var(--color-red-500)" },
  resolved: { label: "Resolved", color: "var(--color-emerald-500)" },
} satisfies ChartConfig

const LATENCY = {
  p50: { label: "Median", color: "var(--chart-1)" },
  p95: { label: "95th percentile", color: "var(--chart-3)" },
} satisfies ChartConfig

function Empty({ hint }: { hint: string }) {
  return (
    <div className="flex h-full min-h-[120px] items-center justify-center text-sm text-muted-foreground">
      {hint}
    </div>
  )
}

export function AlertsPerDay({
  rows,
}: {
  rows: DashboardData["alerts_per_day"]
}) {
  const { formatCustom } = useDateFormat()
  if (!rows.length) return <Empty hint="No alerts this week." />
  const data = rows.map((p) => ({
    ...p,
    label: formatCustom(p.t, {
      month: "short",
      day: "numeric",
    }),
  }))
  return (
    <ChartContainer
      config={ALERTS}
      className="aspect-auto h-full min-h-[140px] w-full"
    >
      <BarChart
        accessibilityLayer
        data={data}
        margin={{ left: 0, right: 8, top: 4 }}
      >
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tickMargin={6}
          minTickGap={20}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={countAxisWidth(
            data.map((p) => Math.max(p.opened, p.resolved))
          )}
          allowDecimals={false}
        />
        <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
        <Bar dataKey="opened" fill="var(--color-opened)" radius={3} />
        <Bar dataKey="resolved" fill="var(--color-resolved)" radius={3} />
        <ChartLegend content={<ChartLegendContent />} />
      </BarChart>
    </ChartContainer>
  )
}

const LATENCY_SERIES = (["p50", "p95"] as const).map((k) => ({
  key: k,
  label: LATENCY[k].label,
  color: LATENCY[k].color,
}))

export function LatencyWeek({
  rows,
}: {
  rows: DashboardData["latency_series"]
}) {
  const { formatCustom } = useDateFormat()
  const [hidden, setHidden] = useState<Set<string>>(() => new Set())
  if (!rows.length) return <Empty hint="No latency recorded this week." />
  const data = rows.map((p) => ({
    ...p,
    label: formatCustom(p.t, {
      weekday: "short",
      hour: "2-digit",
    }),
  }))
  return (
    <div className="flex h-full flex-col">
      <ChartContainer
        config={LATENCY}
        className="aspect-auto min-h-[140px] w-full flex-1"
      >
        <LineChart
          accessibilityLayer
          data={data}
          margin={{ left: 0, right: 8, top: 4 }}
        >
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            tickMargin={6}
            minTickGap={32}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            width={56}
            tickFormatter={(v: number) => `${v} ms`}
          />
          <ChartTooltip
            cursor={false}
            content={<ChartTooltipContent indicator="line" />}
          />
          <Line
            dataKey="p95"
            type="monotone"
            stroke="var(--color-p95)"
            strokeWidth={2}
            dot={false}
            connectNulls
            hide={hidden.has("p95")}
          />
          <Line
            dataKey="p50"
            type="monotone"
            stroke="var(--color-p50)"
            strokeWidth={2}
            dot={false}
            connectNulls
            hide={hidden.has("p50")}
          />
        </LineChart>
      </ChartContainer>
      <SeriesLegend
        items={LATENCY_SERIES}
        hidden={hidden}
        onChange={setHidden}
      />
    </div>
  )
}
