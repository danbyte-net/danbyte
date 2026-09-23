import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"

import type { DashboardData } from "@/lib/api"
import { LatencyByKindChart } from "@/components/monitoring/latency-by-kind"
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

export function LatencyWeek({
  kinds,
}: {
  kinds: DashboardData["latency_by_kind"]
}) {
  const { formatCustom } = useDateFormat()
  return (
    <LatencyByKindChart
      kinds={kinds}
      formatLabel={(t) =>
        formatCustom(t, {
          weekday: "short",
          hour: "2-digit",
        })
      }
      empty={<Empty hint="No latency recorded this week." />}
      chartClassName="min-h-[140px] flex-1"
    />
  )
}
