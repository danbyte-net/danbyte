import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts"

import { useState } from "react"

import type { LatencyByKind } from "@/lib/api"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { SeriesLegend } from "@/components/monitoring/series-legend"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart"
import type { ChartConfig } from "@/components/ui/chart"
import { cn } from "@/lib/utils"

// Median and 95th percentile latency, one check kind at a time. A ping and an
// HTTPS fetch on one curve tell you which kind has more checks, not how
// either is doing - so the kinds are picked, never mixed.

const LATENCY = {
  p50: { label: "Median", color: "var(--chart-1)" },
  p95: { label: "95th percentile", color: "var(--chart-3)" },
} satisfies ChartConfig

const SERIES = (["p50", "p95"] as const).map((k) => ({
  key: k,
  label: LATENCY[k].label,
  color: LATENCY[k].color,
}))

const KIND_LABEL: Record<string, string> = {
  icmp: "ICMP",
  tcp: "TCP",
  udp: "UDP",
  http: "HTTP",
  snmp: "SNMP",
  ssh: "SSH",
  telnet: "Telnet",
  tls_cert: "TLS",
  exec: "Exec",
}

export function LatencyByKindChart({
  kinds,
  formatLabel,
  empty,
  chartClassName,
}: {
  kinds: LatencyByKind[]
  formatLabel: (t: string) => string
  /** Rendered in place of the chart when nothing was recorded. */
  empty: React.ReactNode
  chartClassName?: string
}) {
  const [picked, setPicked] = useState<string | null>(null)
  const [hidden, setHidden] = useState<Set<string>>(() => new Set())
  if (!kinds.length) return <>{empty}</>
  // The busiest kind first, unless one was picked and is still there.
  const current = kinds.find((k) => k.kind === picked) ?? kinds[0]
  const data = current.series.map((p) => ({ ...p, label: formatLabel(p.t) }))
  return (
    <div className="flex h-full flex-col gap-2">
      {kinds.length > 1 && (
        <SegmentedTabs
          wrap
          value={current.kind}
          onValueChange={setPicked}
          items={kinds.map((k) => ({
            value: k.kind,
            label: KIND_LABEL[k.kind] ?? k.kind,
          }))}
        />
      )}
      <ChartContainer
        config={LATENCY}
        className={cn("aspect-auto w-full", chartClassName)}
      >
        <LineChart
          accessibilityLayer
          data={data}
          margin={{ left: 0, right: 12, top: 4 }}
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
      <SeriesLegend items={SERIES} hidden={hidden} onChange={setHidden} />
    </div>
  )
}
