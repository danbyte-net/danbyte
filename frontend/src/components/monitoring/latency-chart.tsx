import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
} from "recharts"

import { api } from "@/lib/api"
import type { LatencyResponse, StatsHours } from "@/lib/api"
import { SegmentedTabs } from "@/components/segmented-tabs"
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart"
import type { ChartConfig } from "@/components/ui/chart"

const WINDOWS: { hours: StatsHours; label: string }[] = [
  { hours: 24, label: "24h" },
  { hours: 168, label: "7d" },
  { hours: 720, label: "30d" },
]

const CONFIG = {
  avg: { label: "Average", color: "var(--chart-1)" },
  range: { label: "Min–max", color: "var(--chart-1)" },
  loss: { label: "Loss %", color: "var(--color-red-500)" },
} satisfies ChartConfig

/**
 * Latency over time for one check on one address, to scale: the average
 * as a line, the bucket's min–max as a band behind it, and packet loss as
 * bars on their own axis. Fast-lane windows carry their own min/max and
 * loss, so a one-second ping and a five-minute one draw the same way. The
 * inline sparkline stays for a glance; this is the one you read.
 */
export function LatencyChart({
  ipId,
  templateId,
  className,
}: {
  ipId: string
  templateId: string
  className?: string
}) {
  const [hours, setHours] = useState<StatsHours>(24)
  const q = useQuery({
    queryKey: ["ip-latency", ipId, templateId, hours],
    queryFn: () =>
      api<LatencyResponse>(
        `/api/monitoring/ips/${ipId}/latency/?template=${templateId}&hours=${hours}`
      ),
    staleTime: 60_000,
  })
  const points = q.data?.points ?? []
  const data = points.map((p) => ({
    t: p.t,
    label:
      hours === 24
        ? new Date(p.t).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })
        : new Date(p.t).toLocaleString([], {
            month: "short",
            day: "numeric",
            hour: "2-digit",
          }),
    avg: p.avg,
    range: p.min != null && p.max != null ? [p.min, p.max] : null,
    loss: p.loss,
    samples: p.samples,
  }))
  const hasLoss = points.some((p) => p.loss > 0)

  return (
    <div className={className}>
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          Latency
        </span>
        <SegmentedTabs
          className="ml-auto"
          value={String(hours)}
          onValueChange={(v) => setHours(Number(v) as StatsHours)}
          items={WINDOWS.map((w) => ({
            value: String(w.hours),
            label: w.label,
          }))}
        />
      </div>
      {q.isLoading ? (
        <p className="py-6 text-center text-xs text-muted-foreground">
          Loading…
        </p>
      ) : data.length === 0 ? (
        <p className="py-6 text-center text-xs text-muted-foreground">
          No results in this window.
        </p>
      ) : (
        <ChartContainer
          config={CONFIG}
          className="aspect-auto h-[180px] w-full"
        >
          <ComposedChart
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
              yAxisId="ms"
              tickLine={false}
              axisLine={false}
              width={36}
              tickFormatter={(v: number) => `${v}`}
              unit=" ms"
            />
            {hasLoss && (
              <YAxis
                yAxisId="loss"
                orientation="right"
                domain={[0, 100]}
                tickLine={false}
                axisLine={false}
                width={32}
                unit="%"
              />
            )}
            <ChartTooltip
              cursor={false}
              content={
                <ChartTooltipContent
                  formatter={(value, name, item) => {
                    if (name === "range") {
                      const [lo, hi] = value as unknown as [number, number]
                      return (
                        <span className="num">
                          {lo}–{hi} ms
                        </span>
                      )
                    }
                    if (name === "loss")
                      return <span className="num">{String(value)}%</span>
                    const samples = (
                      item.payload as { samples?: number } | undefined
                    )?.samples
                    return (
                      <span className="num">
                        {String(value)} ms
                        {samples ? (
                          <span className="text-muted-foreground">
                            {" "}
                            · {samples} probes
                          </span>
                        ) : null}
                      </span>
                    )
                  }}
                />
              }
            />
            <Area
              yAxisId="ms"
              dataKey="range"
              type="monotone"
              fill="var(--color-range)"
              fillOpacity={0.15}
              stroke="none"
              isAnimationActive={false}
            />
            <Line
              yAxisId="ms"
              dataKey="avg"
              type="monotone"
              stroke="var(--color-avg)"
              strokeWidth={2}
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
            {hasLoss && (
              <Bar
                yAxisId="loss"
                dataKey="loss"
                fill="var(--color-loss)"
                fillOpacity={0.6}
                radius={2}
                isAnimationActive={false}
              />
            )}
            <ChartLegend content={<ChartLegendContent />} />
          </ComposedChart>
        </ChartContainer>
      )}
    </div>
  )
}
