import { useState } from "react"
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts"

import { labelTicks } from "@/lib/chart-axis"
import type { SlaAnalysis, SlaBreakdownRow } from "@/lib/api"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart"
import type { ChartConfig } from "@/components/ui/chart"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { StatusStrip, fmtSpan } from "@/components/monitoring/status-strip"
import { fmtBudget, fmtSla } from "@/components/monitoring/sla-figure"
import { useDateFormat } from "@/lib/datetime"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

// The analysis view's charts. Every chart reads the same filtered analysis
// payload; the clickable ones report what was clicked and the page decides
// what that means (drill into a day, filter to a member, open a panel).

function useBucketLabel(bucket: "day" | "hour") {
  const { formatCustom } = useDateFormat()
  return (t: string) =>
    bucket === "hour"
      ? formatCustom(t, { hour: "2-digit", minute: "2-digit" })
      : formatCustom(t, { month: "short", day: "numeric" })
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex h-[160px] items-center justify-center text-sm text-muted-foreground">
      {children}
    </p>
  )
}

const AVAIL = {
  value: { label: "Availability", color: "var(--color-emerald-500)" },
} satisfies ChartConfig

/** Availability per bucket against the target line; a bar is clickable. */
export function AvailabilityOverTime({
  data,
  onPick,
}: {
  data: SlaAnalysis
  onPick?: (point: SlaAnalysis["series"][number]) => void
}) {
  const label = useBucketLabel(data.bucket)
  const target = data.figures.target
  const measured = data.series.filter((p) => p.availability != null)
  if (!measured.length) return <Empty>Nothing measured in this window.</Empty>
  const low = Math.min(target, ...measured.map((p) => p.availability ?? 100))
  // A zoomed axis shows the nines; a deep drop shows its true size from 0,
  // or a 50% day would draw as a sliver at the bottom.
  const floor = low >= 90 ? Math.max(0, Math.floor(low) - 2) : 0
  const tone = (av: number) =>
    av >= target ? "var(--color-emerald-500)" : "var(--color-red-500)"
  // A window still running ends in a bucket that is only partly measured:
  // today so far. It is drawn hollow-ish so it never reads as a full day.
  const running = data.period_end > data.until
  const last = data.series.length - 1
  const rows = data.series.map((p, i) => ({
    ...p,
    label: label(p.t),
    value: p.availability ?? floor,
    fill: p.availability == null ? "var(--muted)" : tone(p.availability),
    forecast: false,
    current: running && i === last,
  }))
  // The days still to come, drawn hollow at the trailing week's figure.
  const fc = data.forecast
  for (const t of fc?.buckets ?? []) {
    rows.push({
      t,
      end: t,
      availability: fc?.trailing ?? null,
      down_s: 0,
      measured_s: 0,
      incidents: 0,
      label: label(t),
      value: fc?.trailing ?? floor,
      fill: tone(fc?.trailing ?? 100),
      forecast: true,
      current: false,
    })
  }
  return (
    <ChartContainer config={AVAIL} className="aspect-auto h-[200px] w-full">
      <BarChart data={rows} margin={{ left: 0, right: 8, top: 6 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="t"
          tickFormatter={labelTicks(rows, "t")}
          tickLine={false}
          axisLine={false}
          tickMargin={6}
          minTickGap={16}
        />
        <YAxis
          domain={[floor, 100]}
          allowDataOverflow
          tickLine={false}
          axisLine={false}
          width={48}
          tickFormatter={(v: number) => `${v}%`}
        />
        <ReferenceLine
          y={target}
          stroke="var(--muted-foreground)"
          strokeDasharray="4 4"
        />
        <ChartTooltip
          cursor={{ fill: "var(--muted)", opacity: 0.4 }}
          content={
            <ChartTooltipContent
              hideIndicator
              formatter={(_v, _n, item) => {
                const p = item.payload as unknown as (typeof rows)[number]
                if (p.forecast)
                  return `Forecast ${fmtSla(p.availability)}, like the last 7 days`
                const soFar = p.current
                  ? `${data.bucket === "day" ? "Today" : "This hour"}, in progress · `
                  : ""
                return (
                  soFar +
                  (p.availability == null
                    ? "Nothing measured"
                    : `${fmtSla(p.availability)} · ${fmtSpan(p.down_s * 1000)} down · ${p.incidents} incident${p.incidents === 1 ? "" : "s"}`)
                )
              }}
            />
          }
        />
        {/* The click sits on the bars, which know their own index; the
            chart-level event carries none when no tooltip is active. */}
        <Bar
          dataKey="value"
          radius={2}
          onClick={(_bar, index) => {
            if (onPick && index >= 0 && index < data.series.length)
              onPick(data.series[index])
          }}
          className={onPick ? "cursor-pointer" : undefined}
        >
          {rows.map((r) =>
            r.forecast ? (
              <Cell
                key={r.t}
                fill="transparent"
                stroke={r.fill}
                strokeDasharray="3 2"
              />
            ) : (
              <Cell
                key={r.t}
                fill={r.fill}
                fillOpacity={r.current ? 0.45 : 1}
                stroke={r.current ? r.fill : undefined}
                strokeWidth={r.current ? 1.5 : 0}
              />
            )
          )}
        </Bar>
      </BarChart>
    </ChartContainer>
  )
}

const BURN = {
  spent: { label: "Spent", color: "var(--color-red-500)" },
  pace: { label: "On pace", color: "var(--muted-foreground)" },
} satisfies ChartConfig

/** Budget spent so far against the line that would spend it exactly. */
export function BurnDown({ data }: { data: SlaAnalysis }) {
  const label = useBucketLabel(data.bucket)
  if (!data.burn.length) return <Empty>No budget to show.</Empty>
  const budget = data.burn[0].budget_s
  const rows = data.burn.map((p) => ({
    t: p.t,
    label: label(p.t),
    spent: Math.round(p.spent_s / 60),
    pace: Math.round(p.pace_s / 60),
  }))
  return (
    <ChartContainer config={BURN} className="aspect-auto h-[200px] w-full">
      <LineChart data={rows} margin={{ left: 0, right: 8, top: 6 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="t"
          tickFormatter={labelTicks(rows, "t")}
          tickLine={false}
          axisLine={false}
          tickMargin={6}
          minTickGap={24}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={52}
          tickFormatter={(v: number) => `${v}m`}
        />
        <ReferenceLine
          y={Math.round(budget / 60)}
          stroke="var(--color-red-500)"
          strokeOpacity={0.5}
          strokeDasharray="2 3"
        />
        <ChartTooltip
          cursor={false}
          content={<ChartTooltipContent indicator="line" />}
        />
        <Line
          dataKey="pace"
          type="monotone"
          stroke="var(--color-pace)"
          strokeDasharray="4 4"
          dot={false}
        />
        <Line
          dataKey="spent"
          type="stepAfter"
          stroke="var(--color-spent)"
          strokeWidth={2}
          dot={false}
        />
      </LineChart>
    </ChartContainer>
  )
}

export type BreakdownKind = "member" | "group" | "site" | "kind"

/** Where the down time went, one dimension at a time; a row filters the page. */
export function DowntimeBreakdown({
  data,
  onPick,
}: {
  data: SlaAnalysis
  onPick: (kind: BreakdownKind, key: string) => void
}) {
  const [kind, setKind] = useState<BreakdownKind>("member")
  const rows: SlaBreakdownRow[] =
    kind === "member"
      ? data.by_member.map((m) => ({ ...m, key: m.object_id }))
      : kind === "group"
        ? data.by_group
        : kind === "site"
          ? data.by_site
          : data.by_kind
  const top = rows.slice(0, 12)
  const max = Math.max(1, ...top.map((r) => r.down_s))
  return (
    <div className="space-y-3">
      <SegmentedTabs
        value={kind}
        onValueChange={(v) => setKind(v)}
        items={[
          { value: "member", label: "Member" },
          { value: "group", label: "Group" },
          { value: "site", label: "Site" },
          { value: "kind", label: "Check type" },
        ]}
      />
      {top.length === 0 ? (
        <Empty>Nothing measured.</Empty>
      ) : (
        <ul className="space-y-1.5 text-[13px]">
          {top.map((r) => (
            <li key={r.key ?? "none"}>
              <button
                type="button"
                disabled={r.key == null}
                onClick={() => r.key && onPick(kind, r.key)}
                className="grid w-full grid-cols-[minmax(0,10rem)_1fr_4.5rem_4.5rem] items-center gap-2 rounded-md px-1 py-0.5 text-left hover:bg-muted/60 disabled:cursor-default"
              >
                <span
                  className={`truncate ${kind === "kind" ? "font-mono text-[11px] uppercase" : ""}`}
                >
                  {r.name}
                </span>
                <span className="h-2 overflow-hidden rounded-sm bg-muted">
                  <span
                    className="block h-full bg-red-500/80"
                    style={{ width: `${(100 * r.down_s) / max}%` }}
                  />
                </span>
                <span className="num text-right text-muted-foreground">
                  {r.down_s ? fmtSpan(r.down_s * 1000) : "-"}
                </span>
                <span className="num text-right">{fmtSla(r.availability)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const CLS = { up: "up", down: "down", unmeasured: "unknown" } as const

/** One strip per member across the window; a name opens its panel. */
export function MemberStrips({
  data,
  onPick,
}: {
  data: SlaAnalysis
  onPick: (key: string) => void
}) {
  if (!data.strips.length) return <Empty>No members.</Empty>
  return (
    <div className="space-y-1.5">
      {data.strips.map((s) => (
        <div
          key={s.key}
          className="grid grid-cols-[minmax(0,9rem)_1fr_4rem] items-center gap-2 text-[12px]"
        >
          <button
            type="button"
            onClick={() => onPick(s.key)}
            className="link truncate text-left"
          >
            {s.name}
          </button>
          <StatusStrip
            segments={s.segments.map(([start, end, c]) => ({
              start,
              end,
              status: CLS[c],
            }))}
            since={data.since}
            until={data.until}
          />
          <span className="num text-right text-muted-foreground">
            {fmtSla(s.availability)}
          </span>
        </div>
      ))}
    </div>
  )
}

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

/** Down time by weekday and hour: patterns (a nightly job, Monday changes)
 * stand out that a timeline hides. */
function heatColor(v: number, max: number) {
  return v
    ? `color-mix(in oklab, var(--color-red-500) ${Math.round(15 + (85 * v) / max)}%, transparent)`
    : "var(--muted)"
}

/** Down time by weekday and hour of day, in the agreement's timezone. */
export function DowntimeHeatmap({ data }: { data: SlaAnalysis }) {
  const { settings } = useDateFormat()
  const twelve = settings.time_style === "12h"
  const hourLabel = (h: number) =>
    twelve
      ? `${((h + 11) % 12) + 1} ${h < 12 ? "AM" : "PM"}`
      : `${String(h).padStart(2, "0")}:00`
  const cells = new Map(
    data.heatmap.map((c) => [`${c.dow}:${c.hour}`, c.down_s])
  )
  const max = Math.max(1, ...data.heatmap.map((c) => c.down_s))
  const total = data.heatmap.reduce((n, c) => n + c.down_s, 0)
  if (!data.heatmap.length) return <Empty>No down time in this window.</Empty>
  return (
    <TooltipProvider delayDuration={0} skipDelayDuration={0}>
      <div className="space-y-2">
        <div className="overflow-x-auto">
          <div className="inline-grid min-w-full grid-cols-[2.5rem_repeat(24,minmax(0.9rem,1fr))] gap-[2px] text-[10px]">
            <span />
            {Array.from({ length: 24 }, (_, h) => (
              <span key={h} className="text-center text-muted-foreground">
                {h % 3 === 0 ? (twelve ? ((h + 11) % 12) + 1 : h) : ""}
              </span>
            ))}
            {DAYS.map((d, dow) => (
              <div key={d} className="contents">
                <span className="pr-1 text-right text-muted-foreground">
                  {d}
                </span>
                {Array.from({ length: 24 }, (_, h) => {
                  const v = cells.get(`${dow}:${h}`) ?? 0
                  return (
                    <Tooltip key={h}>
                      <TooltipTrigger asChild>
                        <span
                          className="h-4 rounded-[2px] hover:ring-1 hover:ring-foreground"
                          style={{ background: heatColor(v, max) }}
                          aria-label={`${d} ${hourLabel(h)}, ${fmtSpan(v * 1000)} down`}
                        />
                      </TooltipTrigger>
                      <TooltipContent>
                        <span className="num">
                          {d} {hourLabel(h)}-{hourLabel((h + 1) % 24)}
                          {" · "}
                          {v
                            ? `${fmtSpan(v * 1000)} down (${Math.round((100 * v) / total)}%)`
                            : "no down time"}
                        </span>
                      </TooltipContent>
                    </Tooltip>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
        <div className="flex items-center justify-end gap-1.5 text-[11px] text-muted-foreground">
          <span>None</span>
          {[0, 0.25, 0.5, 0.75, 1].map((f) => (
            <span
              key={f}
              className="h-3 w-4 rounded-[2px]"
              style={{ background: heatColor(f * max, max) }}
            />
          ))}
          <span className="num">{fmtSpan(max * 1000)} in one hour</span>
        </div>
      </div>
    </TooltipProvider>
  )
}

const DUR = {
  count: { label: "Incidents", color: "var(--color-red-500)" },
} satisfies ChartConfig

/** How long outages last, and the mean time to recover. */
export function IncidentLengths({ data }: { data: SlaAnalysis }) {
  const total = data.durations.reduce((n, d) => n + d.count, 0)
  if (!total) return <Empty>No incidents in this window.</Empty>
  const mttr =
    data.incidents.reduce((n, i) => n + i.seconds, 0) /
    Math.max(1, data.incidents.length)
  return (
    <div className="space-y-2">
      <p className="text-[13px] text-muted-foreground">
        {total} incident{total === 1 ? "" : "s"} · mean time to recover{" "}
        <span className="num text-foreground">{fmtSpan(mttr * 1000)}</span>
      </p>
      <ChartContainer config={DUR} className="aspect-auto h-[150px] w-full">
        <BarChart data={data.durations} margin={{ left: 0, right: 8, top: 4 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="label" tickLine={false} axisLine={false} />
          <YAxis
            tickLine={false}
            axisLine={false}
            width={28}
            allowDecimals={false}
          />
          <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
          <Bar dataKey="count" fill="var(--color-count)" radius={2} />
        </BarChart>
      </ChartContainer>
    </div>
  )
}

const LAT = {
  p95: { label: "p95", color: "var(--chart-3)" },
  p50: { label: "Median", color: "var(--chart-1)" },
} satisfies ChartConfig

/** p95 per check kind against its objective. */
export function LatencyAgainstObjective({ data }: { data: SlaAnalysis }) {
  const label = useBucketLabel(data.bucket)
  const [picked, setPicked] = useState<string | null>(null)
  if (!data.latency.length) return <Empty>No latency recorded.</Empty>
  const cur = data.latency.find((l) => l.kind === picked) ?? data.latency[0]
  const rows = cur.points.map((p) => ({ ...p, label: label(p.t) }))
  return (
    <div className="space-y-2">
      {data.latency.length > 1 && (
        <SegmentedTabs
          value={cur.kind}
          onValueChange={setPicked}
          items={data.latency.map((l) => ({
            value: l.kind,
            label: (
              <span className="font-mono text-[11px] uppercase">{l.kind}</span>
            ),
          }))}
        />
      )}
      <ChartContainer config={LAT} className="aspect-auto h-[170px] w-full">
        <LineChart data={rows} margin={{ left: 0, right: 8, top: 6 }}>
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="t"
            tickFormatter={labelTicks(rows, "t")}
            tickLine={false}
            axisLine={false}
            tickMargin={6}
            minTickGap={24}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            width={52}
            tickFormatter={(v: number) => `${v} ms`}
          />
          {cur.objective != null && (
            <ReferenceLine
              y={cur.objective}
              stroke="var(--color-red-500)"
              strokeDasharray="4 4"
            />
          )}
          {cur.objectives.map((o) => (
            <ReferenceLine
              key={o.threshold_ms}
              y={o.threshold_ms}
              stroke="var(--color-amber-500)"
              strokeDasharray="2 3"
              ifOverflow="extendDomain"
            />
          ))}
          <ChartTooltip
            cursor={false}
            content={
              <ChartTooltipContent
                indicator="line"
                labelFormatter={(value, payload) => {
                  const within = (
                    payload[0]?.payload as (typeof rows)[number] | undefined
                  )?.within
                  const parts = cur.objectives
                    .map((o) => {
                      const v = within?.[String(o.threshold_ms)]
                      return v == null
                        ? null
                        : `${v}% within ${o.threshold_ms} ms`
                    })
                    .filter(Boolean)
                  return [value, ...parts].join(" · ")
                }}
              />
            }
          />
          <Line
            dataKey="p50"
            stroke="var(--color-p50)"
            dot={false}
            connectNulls
          />
          <Line
            dataKey="p95"
            stroke="var(--color-p95)"
            strokeWidth={2}
            dot={false}
            connectNulls
          />
        </LineChart>
      </ChartContainer>
      {(cur.objective != null || cur.objectives.length > 0) && (
        <p className="text-[11px] text-muted-foreground">
          {[
            cur.objective != null && `p95 alert ${cur.objective} ms (red)`,
            ...cur.objectives.map(
              (o) => `${o.target_pct}% within ${o.threshold_ms} ms (amber)`
            ),
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}
    </div>
  )
}

/** A headline figure with its change since the previous window. */
export function Delta({
  now,
  before,
  kind,
}: {
  now: number | null | undefined
  before: number | null | undefined
  kind: "pct" | "seconds" | "count"
}) {
  if (now == null || before == null) return null
  const d = now - before
  if (Math.abs(d) < (kind === "pct" ? 0.0005 : 0.5)) {
    return <span className="text-[11px] text-muted-foreground">no change</span>
  }
  // Up is good for availability and coverage; bad for down time and incidents.
  const good = kind === "pct" ? d > 0 : d < 0
  const text =
    kind === "pct"
      ? `${d > 0 ? "+" : ""}${d.toFixed(Math.abs(d) < 0.1 ? 3 : 2)} pts`
      : kind === "seconds"
        ? `${d > 0 ? "+" : "-"}${fmtBudget(Math.abs(d))}`
        : `${d > 0 ? "+" : ""}${d}`
  return (
    <span
      className={`text-[11px] ${good ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}
    >
      {text} vs before
    </span>
  )
}
