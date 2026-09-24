import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from "recharts"

import { labelTicks } from "@/lib/chart-axis"
import type { DayAvailability } from "@/lib/api"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart"
import type { ChartConfig } from "@/components/ui/chart"
import { useDateFormat } from "@/lib/datetime"

const CONFIG = {
  uptime: { label: "Availability", color: "var(--color-emerald-500)" },
} satisfies ChartConfig

// The same tiers the SLA card colours by: three nines emerald, two amber,
// anything less red. A day with nothing measured draws as an empty slot.
function tone(pct: number | null): string {
  if (pct == null) return "var(--muted)"
  if (pct >= 99.9) return "var(--color-emerald-500)"
  if (pct >= 99) return "var(--color-amber-500)"
  return "var(--color-red-500)"
}

/**
 * One bar per calendar day, availability as height and tier as colour, so
 * "fine except Tuesday" is visible without reading a table. Cut from the
 * same segments the uptime figure integrates.
 */
export function DailyAvailability({
  days,
  className,
}: {
  days: DayAvailability[]
  className?: string
}) {
  const { formatCustom } = useDateFormat()
  if (days.length === 0) return null
  const data = days.map((d) => ({
    ...d,
    // The bare date formats on its own calendar day, never shifted by a zone.
    label: formatCustom(d.date, { month: "short", day: "numeric" }),
    // A day with nothing measured sits at the floor so it reads as a gap.
    uptime: d.uptime_pct ?? 0,
  }))
  // Below the worst day by a margin: a floor at the worst day's own value
  // drew that day as an empty slot, indistinguishable from "not measured".
  const lowest = Math.min(...days.map((d) => d.uptime_pct ?? 100))
  // The nines zoomed; a deep drop from 0, so its bar shows its true size.
  const floor = lowest >= 90 ? Math.min(95, Math.floor(lowest) - 5) : 0
  return (
    <div className={className}>
      <ChartContainer config={CONFIG} className="aspect-auto h-[120px] w-full">
        <BarChart
          accessibilityLayer
          data={data}
          margin={{ left: 0, right: 8, top: 4 }}
        >
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="date"
            tickFormatter={labelTicks(data, "date")}
            tickLine={false}
            axisLine={false}
            tickMargin={6}
            minTickGap={24}
          />
          <YAxis
            domain={[floor, 100]}
            tickLine={false}
            axisLine={false}
            width={44}
            tickFormatter={(v: number) => `${v}%`}
          />
          <ChartTooltip
            cursor={false}
            content={
              <ChartTooltipContent
                formatter={(_v, _n, item) => {
                  const d = item.payload as
                    | (DayAvailability & { uptime: number })
                    | undefined
                  if (!d || d.uptime_pct == null)
                    return (
                      <span className="text-muted-foreground">
                        nothing measured
                      </span>
                    )
                  return (
                    <span className="num">
                      {d.uptime_pct}%
                      <span className="text-muted-foreground">
                        {" "}
                        · {d.incidents} incident{d.incidents === 1 ? "" : "s"}
                        {d.down_s > 0 ? ` · ${fmtDown(d.down_s)} down` : ""}
                      </span>
                    </span>
                  )
                }}
              />
            }
          />
          <Bar dataKey="uptime" radius={2} isAnimationActive={false}>
            {data.map((d) => (
              <Cell key={d.date} fill={tone(d.uptime_pct)} />
            ))}
          </Bar>
        </BarChart>
      </ChartContainer>
    </div>
  )
}

function fmtDown(s: number): string {
  if (s < 90) return `${s}s`
  if (s < 5400) return `${Math.round(s / 60)}m`
  return `${(s / 3600).toFixed(1)}h`
}
