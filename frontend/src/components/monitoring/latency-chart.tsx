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

import { labelTicks } from "@/lib/chart-axis"
import { api } from "@/lib/api"
import type { LatencyResponse, StatsHours } from "@/lib/api"
import { SegmentedTabs } from "@/components/segmented-tabs"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart"
import type { ChartConfig } from "@/components/ui/chart"
import { SeriesLegend } from "./series-legend"
import { useDateFormat } from "@/lib/datetime"

const WINDOWS: { hours: StatsHours; label: string }[] = [
  { hours: 24, label: "24h" },
  { hours: 168, label: "7d" },
  { hours: 720, label: "30d" },
]

// Three colours for three things: the average is the line you read, the
// band is the spread behind it, loss is the red that should not be there.
const CONFIG = {
  avg: { label: "Average", color: "var(--chart-1)" },
  range: { label: "Min–max", color: "var(--chart-2)" },
  loss: { label: "Loss %", color: "var(--color-red-500)" },
} satisfies ChartConfig

const SERIES = (["avg", "range", "loss"] as const).map((k) => ({
  key: k,
  label: CONFIG[k].label,
  color: CONFIG[k].color,
}))

/**
 * Latency over time for one check on one address, to scale: the average
 * as a line, the bucket's min–max as a band behind it, and packet loss as
 * bars on their own axis. Fast-lane windows carry their own min/max and
 * loss, so a one-second ping and a five-minute one draw the same way. The
 * row's strip is the glance; this is the one you read.
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
  const { formatCustom } = useDateFormat()
  const [hours, setHours] = useState<StatsHours>(24)
  const [hidden, setHidden] = useState<Set<string>>(() => new Set())
  const q = useQuery({
    queryKey: ["ip-latency", ipId, templateId, hours],
    queryFn: () =>
      api<LatencyResponse>(
        `/api/monitoring/ips/${ipId}/latency/?template=${templateId}&hours=${hours}`
      ),
    staleTime: 60_000,
  })
  const points = q.data?.points ?? []
  const bucketMs = (q.data?.bucket_seconds ?? 300) * 1000
  const time = (ms: number) =>
    formatCustom(ms, { hour: "2-digit", minute: "2-digit" })
  const dayTime = (ms: number) =>
    formatCustom(ms, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })
  const data = points.map((p) => {
    const from = new Date(p.t).getTime()
    const to = from + bucketMs
    const sameDay =
      new Date(from).toDateString() === new Date(to).toDateString()
    return {
      t: p.t,
      label:
        hours === 24
          ? time(from)
          : formatCustom(from, {
              month: "short",
              day: "numeric",
              hour: "2-digit",
            }),
      // The bucket as a span, for the tooltip: a point is five minutes, an
      // hour or six hours of probes, not an instant.
      span: `${hours === 24 ? time(from) : dayTime(from)} – ${sameDay ? time(to) : dayTime(to)}`,
      avg: p.avg,
      range: p.min != null && p.max != null ? [p.min, p.max] : null,
      loss: p.loss,
      samples: p.samples,
    }
  })
  const hasLoss = points.some((p) => p.loss > 0)
  const legend = hasLoss ? SERIES : SERIES.filter((s) => s.key !== "loss")

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
              dataKey="t"
              tickFormatter={labelTicks(data, "t")}
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
                  labelFormatter={(_label, items) =>
                    (items[0]?.payload as { span?: string } | undefined)
                      ?.span ?? _label
                  }
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
              fillOpacity={0.25}
              stroke="none"
              isAnimationActive={false}
              hide={hidden.has("range")}
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
              hide={hidden.has("avg")}
            />
            {hasLoss && (
              <Bar
                yAxisId="loss"
                dataKey="loss"
                fill="var(--color-loss)"
                fillOpacity={0.5}
                radius={2}
                isAnimationActive={false}
                hide={hidden.has("loss")}
              />
            )}
          </ComposedChart>
        </ChartContainer>
      )}
      {data.length > 0 && (
        <SeriesLegend
          items={legend}
          hidden={hidden}
          onChange={setHidden}
          className="mt-1"
        />
      )}
    </div>
  )
}
