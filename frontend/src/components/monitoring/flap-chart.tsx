import { useQuery } from "@tanstack/react-query"
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"

import { api, transitionsQuery } from "@/lib/api"
import type { TransitionsResponse } from "@/lib/api"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart"
import type { ChartConfig } from "@/components/ui/chart"
import { statusColor, statusLabel, useStatusLabels } from "./status-palette"

/**
 * Flaps per hour over the last day for the checks flagged right now - so
 * you can see whether the bouncing is getting worse or settling before you
 * confirm it. The bad transitions only: a flap is a change *into* a bad
 * state, which is what the sweep counted.
 */
export function FlapChart({ className }: { className?: string }) {
  const labels = useStatusLabels()
  const q = useQuery({
    queryKey: ["monitoring-transitions", "flapping-chart"],
    queryFn: () =>
      api<TransitionsResponse>(
        `/api/monitoring/transitions/${transitionsQuery({
          flapping: "1",
          days: 1,
          to_status: "down,degraded,stale",
          page_size: 1,
        })}`
      ),
    refetchInterval: 60_000,
  })
  const series = q.data?.series ?? []
  if (series.length === 0) return null
  const config = {
    down: {
      label: statusLabel("down", labels),
      color: statusColor("down", labels),
    },
    degraded: {
      label: statusLabel("degraded", labels),
      color: statusColor("degraded", labels),
    },
    stale: {
      label: statusLabel("stale", labels),
      color: statusColor("stale", labels),
    },
  } satisfies ChartConfig
  const data = series.map((p) => ({
    ...p,
    label: new Date(p.t).toLocaleTimeString([], { hour: "2-digit" }),
  }))
  return (
    <div className={className}>
      <div className="mb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        Flaps per hour · 24h
      </div>
      <ChartContainer config={config} className="aspect-auto h-[120px] w-full">
        <BarChart accessibilityLayer data={data} margin={{ left: 0, right: 8 }}>
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            tickMargin={6}
            minTickGap={28}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            width={28}
            allowDecimals={false}
          />
          <ChartTooltip content={<ChartTooltipContent />} />
          {(["down", "degraded", "stale"] as const).map((s) => (
            <Bar key={s} dataKey={s} stackId="a" fill={`var(--color-${s})`} />
          ))}
        </BarChart>
      </ChartContainer>
    </div>
  )
}
