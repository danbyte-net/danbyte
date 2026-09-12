import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from "recharts"

import type { DashboardData } from "@/lib/api"
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart"
import type { ChartConfig } from "@/components/ui/chart"

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
  if (!rows.length) return <Empty hint="No alerts this week." />
  const data = rows.map((p) => ({
    ...p,
    label: new Date(p.t).toLocaleDateString([], {
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
          width={26}
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

export function LatencyWeek({
  rows,
}: {
  rows: DashboardData["latency_series"]
}) {
  if (!rows.length) return <Empty hint="No latency recorded this week." />
  const data = rows.map((p) => ({
    ...p,
    label: new Date(p.t).toLocaleString([], {
      weekday: "short",
      hour: "2-digit",
    }),
  }))
  return (
    <ChartContainer
      config={LATENCY}
      className="aspect-auto h-full min-h-[140px] w-full"
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
        />
        <Line
          dataKey="p50"
          type="monotone"
          stroke="var(--color-p50)"
          strokeWidth={2}
          dot={false}
          connectNulls
        />
        <ChartLegend content={<ChartLegendContent />} />
      </LineChart>
    </ChartContainer>
  )
}
