import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"

import { labelTicks } from "@/lib/chart-axis"
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
import { useNavigate } from "@tanstack/react-router"

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
  const navigate = useNavigate()
  if (!rows.length) return <Empty hint="No alerts this week." />
  // A day's bars open that day's state changes on the History view.
  const openDay = (i: number) => {
    const p = rows[i] as (typeof rows)[number] | undefined
    if (!p) return
    const end = new Date(new Date(p.t).getTime() + 86_400_000).toISOString()
    void navigate({
      to: "/monitoring",
      search: { view: "history", status: "all", since: p.t, until: end },
    })
  }
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
          dataKey="t"
          tickFormatter={labelTicks(data, "t")}
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
        <Bar
          dataKey="opened"
          fill="var(--color-opened)"
          radius={3}
          className="cursor-pointer"
          onClick={(_b, i) => openDay(i)}
        />
        <Bar
          dataKey="resolved"
          fill="var(--color-resolved)"
          radius={3}
          className="cursor-pointer"
          onClick={(_b, i) => openDay(i)}
        />
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
  const navigate = useNavigate()
  const series = kinds[0]?.series ?? []
  const longFrame =
    series.length > 1 &&
    new Date(series[series.length - 1].t).getTime() -
      new Date(series[0].t).getTime() >
      7 * 86_400_000
  return (
    <LatencyByKindChart
      onPick={() =>
        void navigate({
          to: "/monitoring",
          search: { view: "latency", status: "all" },
        })
      }
      kinds={kinds}
      formatLabel={(t) =>
        // Past a week a weekday repeats; the date keeps each label unique.
        formatCustom(
          t,
          longFrame
            ? { month: "short", day: "numeric", hour: "2-digit" }
            : { weekday: "short", hour: "2-digit" }
        )
      }
      empty={<Empty hint="No latency recorded this week." />}
      chartClassName="min-h-[140px] flex-1"
    />
  )
}
