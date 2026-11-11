import { useEffect, useState } from "react"
import { Link } from "@tanstack/react-router"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { ChevronDown, ChevronRight } from "lucide-react"
import {
  Bar,
  BarChart,
  CartesianGrid,
  Label,
  LabelList,
  Line,
  LineChart,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from "recharts"

import { api } from "@/lib/api"
import type { CheckStatus, MonitoringStats, StatsHours } from "@/lib/api"
import { labelTicks } from "@/lib/chart-axis"
import { useDateFormat } from "@/lib/datetime"
import { TimeCell } from "@/components/cells/time-ago"
import { EmptyState } from "@/components/empty-state"
import { Kpi } from "@/components/kpi-card"
import type { KpiTone } from "@/components/kpi-card"
import { KvTable } from "@/components/kv-card"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  countAxisWidth,
} from "@/components/ui/chart"
import type { ChartConfig } from "@/components/ui/chart"
import { InfoTip } from "@/components/ui/info-tip"
import { CertKeyHealthCard } from "./cert-key-health"
import { LatencyByKindChart } from "./latency-by-kind"
import { SourceBadge } from "./source-badge"
import { CheckStatusBadge } from "./status-badge"
import { statusColor, statusLabel, useStatusLabels } from "./status-palette"

// The newest changes the Overview lists; All history has the rest.
const RECENT = 8

const STATUS_ORDER: CheckStatus[] = [
  "up",
  "degraded",
  "down",
  "stale",
  "skipped",
  "unknown",
]

const ALERTS_CONFIG = {
  opened: { label: "Opened", color: "var(--color-red-500)" },
  resolved: { label: "Resolved", color: "var(--color-emerald-500)" },
} satisfies ChartConfig

// The brand chart palette (from the adopted preset) - used to colour the
// by-protocol bars, the shadcn way.
const KIND_PALETTE = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
]

// The tiles across the top, worst first: what is wrong now, then what is
// fine. Each opens the Checks list filtered to it.
const NOW: { status: CheckStatus; tone: KpiTone }[] = [
  { status: "down", tone: "down" },
  { status: "degraded", tone: "flapping" },
  { status: "stale", tone: "stale" },
  { status: "up", tone: "up" },
  { status: "skipped", tone: "skipped" },
]

/**
 * Monitoring → Status → Overview: what is wrong now first (the state tiles,
 * the latest changes, certificates and keys), then the trends over the window
 * picked beside the title, then the breakdowns behind a disclosure.
 */
export function MonitoringOverview({ flapping }: { flapping: number }) {
  const { formatCustom } = useDateFormat()
  const labels = useStatusLabels()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const [breakdown, setBreakdown] = useState(false)

  const [hours, setHours] = useState<StatsHours>(24)
  const stats = useQuery({
    queryKey: ["monitoring-stats", hours],
    queryFn: () =>
      api<MonitoringStats>(`/api/monitoring/stats/?hours=${hours}`),
    placeholderData: keepPreviousData,
  })
  const d = stats.data

  const windowLabel =
    hours === 24 ? "24 hours" : hours === 168 ? "7 days" : "30 days"
  const windowShort = hours === 24 ? "24h" : hours === 168 ? "7d" : "30d"

  const header = (
    <div className="flex min-h-8 items-center gap-3">
      <h1 className="text-base font-semibold">Overview</h1>
      <SegmentedTabs
        label="Window"
        className="ml-auto"
        value={String(hours)}
        onValueChange={(v) => setHours(Number(v) as StatsHours)}
        items={[
          { value: "24", label: "24h" },
          { value: "168", label: "7d" },
          { value: "720", label: "30d" },
        ]}
      />
    </div>
  )

  if (stats.isError)
    return (
      <div className="mx-auto max-w-7xl space-y-4">
        {header}
        <QueryError error={stats.error} />
      </div>
    )
  if (!d)
    return (
      <div className="mx-auto flex h-full max-w-7xl flex-col gap-4">
        {header}
        <Loading />
      </div>
    )

  // shadcn shape: each datum carries `fill: var(--color-<key>)`, and the config
  // maps <key> → { label, color } so ChartStyle injects the matching CSS var.
  // Both configs read the tenant's names, so the legend under a chart says the
  // same word as the badge in the table above it.
  const statusConfig = {
    value: { label: "Checks" },
    ...Object.fromEntries(
      STATUS_ORDER.map((s) => [
        s,
        { label: statusLabel(s, labels), color: statusColor(s, labels) },
      ])
    ),
  } satisfies ChartConfig

  const seriesConfig = Object.fromEntries(
    (["up", "degraded", "down"] as const).map((s) => [
      s,
      { label: statusLabel(s, labels), color: statusColor(s, labels) },
    ])
  ) satisfies ChartConfig

  const statusData = STATUS_ORDER.map((s) => ({
    status: s,
    value: d.by_status[s] ?? 0,
    fill: `var(--color-${s})`,
  })).filter((s) => s.value > 0)

  const kindData = Object.entries(d.by_kind)
    .map(([k, v]) => ({
      kind: k,
      value: v,
      fill: `var(--color-${k})`,
    }))
    .sort((a, b) => b.value - a.value)

  const kindConfig = {
    value: { label: "Checks" },
    ...Object.fromEntries(
      kindData.map((k, i) => [
        k.kind,
        {
          label: k.kind.toUpperCase(),
          color: KIND_PALETTE[i % KIND_PALETTE.length],
        },
      ])
    ),
  } satisfies ChartConfig

  const seriesData = d.series.map((p) => ({
    ...p,
    label:
      d.series_bucket === "day"
        ? formatCustom(p.t, { month: "short", day: "numeric" })
        : hours > 24
          ? formatCustom(p.t, { weekday: "short", hour: "2-digit" })
          : formatCustom(p.t, { hour: "2-digit" }),
  }))
  const latencyLabel = (t: string) =>
    d.series_bucket === "day"
      ? formatCustom(t, { month: "short", day: "numeric" })
      : hours > 24
        ? formatCustom(t, { weekday: "short", hour: "2-digit" })
        : formatCustom(t, { hour: "2-digit" })
  const alertsData = d.alerts_series.map((p) => ({
    ...p,
    label: formatCustom(p.t, { month: "short", day: "numeric" }),
  }))

  const total = d.total_checks
  const pct = (n: number) => (total > 0 ? Math.round((n / total) * 100) : 0)

  return (
    <div className="mx-auto max-w-7xl space-y-4 lg:space-y-6">
      {header}

      {/* Now: one tile per state, worst first, each a way into the list. */}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(8.5rem,1fr))] gap-4">
        {NOW.slice(0, 3).map(({ status, tone }) => (
          <StateTile
            key={status}
            status={status}
            tone={tone}
            value={d.by_status[status] ?? 0}
            label={statusLabel(status, labels)}
          />
        ))}
        {flapping > 0 && (
          <Link
            to="/monitoring"
            search={{ view: "flapping" }}
            className="block rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <Kpi label="Flapping" value={flapping} tone="flapping" />
          </Link>
        )}
        {NOW.slice(3).map(({ status, tone }) => (
          <StateTile
            key={status}
            status={status}
            tone={tone}
            value={d.by_status[status] ?? 0}
            label={statusLabel(status, labels)}
          />
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3 lg:gap-6">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Recent changes</CardTitle>
            <CardAction>
              <Link
                to="/monitoring"
                search={{ view: "history" }}
                className="link text-xs text-muted-foreground"
              >
                All history
              </Link>
            </CardAction>
          </CardHeader>
          <CardContent>
            {d.recent_transitions.length === 0 ? (
              <EmptyState title="No status changes yet." />
            ) : (
              <RecentChanges rows={d.recent_transitions.slice(0, RECENT)} />
            )}
          </CardContent>
        </Card>

        <div className="space-y-4 lg:space-y-6">
          <Card size="sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-1.5">
                Coverage
                <InfoTip>
                  Configure individual checks from an{" "}
                  <Link to="/prefixes" className="link">
                    IP or prefix
                  </Link>{" "}
                  page, or for many at once under Policies. Alerts go out via
                  notification channels.
                </InfoTip>
              </CardTitle>
            </CardHeader>
            <CardContent className="px-0">
              <KvTable
                inset
                rows={[
                  { label: "Checks", value: <Num n={total} /> },
                  {
                    label: "Monitored IPs",
                    value: <Num n={d.monitored_ips} />,
                  },
                  {
                    label: "Reachable",
                    value: <Num n={pct(d.by_status.up ?? 0)} unit="%" />,
                  },
                  ...(d.availability_pct != null
                    ? [
                        {
                          label: `Availability ${windowShort}`,
                          value: (
                            <Num
                              n={d.availability_pct}
                              unit="%"
                              tone={
                                d.availability_pct >= 99.9
                                  ? "up"
                                  : d.availability_pct >= 99
                                    ? "flapping"
                                    : "down"
                              }
                            />
                          ),
                        },
                      ]
                    : []),
                  ...(d.fast_lane.fast_checks > 0
                    ? [
                        {
                          label: "Fast lane",
                          value: (
                            <span className="num">
                              {d.fast_lane.fast_checks.toLocaleString()}
                              <span className="ml-2 text-muted-foreground">
                                {d.fast_lane.alive ? (
                                  `${d.fast_lane.probes_per_s}/s`
                                ) : (
                                  <span className="text-red-600 dark:text-red-400">
                                    stalled
                                  </span>
                                )}
                              </span>
                            </span>
                          ),
                        },
                      ]
                    : []),
                ]}
              />
            </CardContent>
          </Card>
          <CertKeyHealthCard />
        </div>
      </div>

      {/* Trends over the window beside the title. */}
      <Card>
        <CardHeader>
          <CardTitle>Check results</CardTitle>
          <CardDescription>
            Outcomes per {d.series_bucket} over the last {windowLabel}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!mounted ? (
            <div className="h-[250px]" />
          ) : seriesData.length === 0 ? (
            <ChartEmpty
              h="h-[250px]"
              title={`No results in the last ${windowLabel}.`}
            />
          ) : (
            <ChartContainer
              config={seriesConfig}
              className="aspect-auto h-[250px] w-full"
            >
              <LineChart
                accessibilityLayer
                data={seriesData}
                margin={{ left: 12, right: 12 }}
              >
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="t"
                  tickFormatter={labelTicks(seriesData, "t")}
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  minTickGap={32}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  width={countAxisWidth(
                    seriesData.map((p) => Math.max(p.up, p.degraded, p.down))
                  )}
                  allowDecimals={false}
                />
                <ChartTooltip
                  cursor={false}
                  content={<ChartTooltipContent indicator="line" />}
                />
                {(["up", "degraded", "down"] as const).map((k) => (
                  <Line
                    key={k}
                    dataKey={k}
                    type="monotone"
                    stroke={`var(--color-${k})`}
                    strokeWidth={2}
                    dot={false}
                  />
                ))}
                <ChartLegend content={<ChartLegendContent />} />
              </LineChart>
            </ChartContainer>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Latency</CardTitle>
            <CardDescription>
              Median and 95th percentile per check kind, per{" "}
              {d.series_bucket === "day" ? "day" : "bucket"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!mounted ? (
              <div className="h-[200px]" />
            ) : (
              <LatencyByKindChart
                kinds={d.latency_by_kind}
                formatLabel={latencyLabel}
                empty={
                  <ChartEmpty
                    h="h-[200px]"
                    title={`No latency in the last ${windowLabel}.`}
                  />
                }
                chartClassName="h-[200px]"
              />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Alerts</CardTitle>
            <CardDescription>Opened against resolved, per day</CardDescription>
          </CardHeader>
          <CardContent>
            {!mounted ? (
              <div className="h-[200px]" />
            ) : alertsData.length === 0 ? (
              <ChartEmpty h="h-[200px]" title="No alerts in this window." />
            ) : (
              <ChartContainer
                config={ALERTS_CONFIG}
                className="aspect-auto h-[200px] w-full"
              >
                <BarChart
                  accessibilityLayer
                  data={alertsData}
                  margin={{ left: 0, right: 12 }}
                >
                  <CartesianGrid vertical={false} />
                  <XAxis
                    dataKey="t"
                    tickFormatter={labelTicks(alertsData, "t")}
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    minTickGap={24}
                  />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    width={countAxisWidth(
                      alertsData.map((p) => Math.max(p.opened, p.resolved))
                    )}
                    allowDecimals={false}
                  />
                  <ChartTooltip
                    cursor={false}
                    content={<ChartTooltipContent />}
                  />
                  <Bar dataKey="opened" fill="var(--color-opened)" radius={3} />
                  <Bar
                    dataKey="resolved"
                    fill="var(--color-resolved)"
                    radius={3}
                  />
                  <ChartLegend content={<ChartLegendContent />} />
                </BarChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* How the estate breaks down - reference, not news, so it waits
          behind a disclosure. */}
      <section className="rounded-lg border border-border bg-card">
        <Button
          type="button"
          variant="ghost"
          className="h-11 w-full justify-start gap-2 rounded-lg px-4 text-sm font-semibold"
          aria-expanded={breakdown}
          aria-controls="monitoring-breakdown"
          onClick={() => setBreakdown((o) => !o)}
        >
          {breakdown ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
          Breakdown
          <span className="font-normal text-muted-foreground">
            Status distribution, checks by type
          </span>
        </Button>
        {breakdown && (
          <div
            id="monitoring-breakdown"
            className="grid grid-cols-1 gap-4 border-t border-border p-4 lg:grid-cols-2 lg:gap-6"
          >
            <Card className="flex flex-col">
              <CardHeader className="items-center pb-0">
                <CardTitle>Status distribution</CardTitle>
                <CardDescription>Current status of all checks</CardDescription>
              </CardHeader>
              <CardContent className="flex-1 pb-0">
                {!mounted || statusData.length === 0 ? (
                  <ChartEmpty h="h-[250px]" title="No checks yet." />
                ) : (
                  <>
                    {/* The legend lives outside the chart on purpose. A
                        recharts Legend inside the PieChart shrinks the plot
                        area, the pie moves up, and the centre label keeps
                        the un-shrunk centre - so "22 checks" sat below the
                        ring. Outside, the ring, its label and the legend
                        each centre in their own box. */}
                    <ChartContainer
                      config={statusConfig}
                      className="mx-auto aspect-square max-h-[220px]"
                    >
                      <PieChart>
                        <ChartTooltip
                          cursor={false}
                          content={<ChartTooltipContent hideLabel />}
                        />
                        <Pie
                          data={statusData}
                          dataKey="value"
                          nameKey="status"
                          innerRadius={60}
                          strokeWidth={5}
                        >
                          <Label content={<TotalLabel total={total} />} />
                        </Pie>
                      </PieChart>
                    </ChartContainer>
                    <ul className="mt-2 flex flex-wrap justify-center gap-x-4 gap-y-1 pb-3 text-xs">
                      {statusData.map((s) => (
                        <li
                          key={s.status}
                          className="flex items-center gap-1.5 text-muted-foreground"
                        >
                          <span
                            className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                            style={{
                              backgroundColor: statusColor(s.status, labels),
                            }}
                          />
                          {statusLabel(s.status, labels)}
                          <span className="num text-foreground">{s.value}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </CardContent>
            </Card>

            {/* Horizontal bars, one colour per protocol (shadcn) */}
            <Card>
              <CardHeader>
                <CardTitle>Checks by type</CardTitle>
                <CardDescription>
                  How the checks break down by protocol
                </CardDescription>
              </CardHeader>
              <CardContent>
                {!mounted || kindData.length === 0 ? (
                  <ChartEmpty h="h-[250px]" title="No checks yet." />
                ) : (
                  <ChartContainer
                    config={kindConfig}
                    className="aspect-auto h-[250px] w-full"
                  >
                    <BarChart
                      accessibilityLayer
                      data={kindData}
                      layout="vertical"
                      margin={{ left: 8, right: 24 }}
                    >
                      <CartesianGrid horizontal={false} />
                      <XAxis type="number" dataKey="value" hide />
                      <YAxis
                        type="category"
                        dataKey="kind"
                        width={64}
                        tickLine={false}
                        axisLine={false}
                        tickFormatter={(v: string) => v.toUpperCase()}
                      />
                      <ChartTooltip
                        cursor={false}
                        content={<ChartTooltipContent hideLabel />}
                      />
                      <Bar dataKey="value" radius={5}>
                        <LabelList
                          dataKey="value"
                          position="right"
                          offset={8}
                          fill="var(--foreground)"
                          fontSize={12}
                        />
                      </Bar>
                    </BarChart>
                  </ChartContainer>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </section>
    </div>
  )
}

/** One state's count, opening the Checks list filtered to it. */
function StateTile({
  status,
  tone,
  value,
  label,
}: {
  status: CheckStatus
  tone: KpiTone
  value: number
  label: string
}) {
  return (
    <Link
      to="/monitoring/checks"
      search={{ status }}
      className="block rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      {/* A zero is not news: it stays muted, whatever the state. */}
      <Kpi label={label} value={value} tone={value > 0 ? tone : "muted"} />
    </Link>
  )
}

function Num({ n, unit, tone }: { n: number; unit?: string; tone?: KpiTone }) {
  const color =
    tone === "up"
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "flapping"
        ? "text-amber-600 dark:text-amber-400"
        : tone === "down"
          ? "text-red-600 dark:text-red-400"
          : undefined
  return (
    <span className={`num ${color ?? ""}`}>
      {n.toLocaleString()}
      {unit}
    </span>
  )
}

function ChartEmpty({ h, title }: { h: string; title: string }) {
  return (
    <EmptyState
      title={title}
      className={`flex flex-col items-center justify-center ${h}`}
    />
  )
}

function TotalLabel({
  total,
  viewBox,
}: {
  total: number
  viewBox?: { cx?: number; cy?: number }
}) {
  if (!viewBox || viewBox.cx == null || viewBox.cy == null) return null
  return (
    <text x={viewBox.cx} y={viewBox.cy} textAnchor="middle">
      <tspan
        x={viewBox.cx}
        y={viewBox.cy - 2}
        className="fill-foreground"
        style={{
          fontSize: 26,
          fontWeight: 700,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {total.toLocaleString()}
      </tspan>
      <tspan
        x={viewBox.cx}
        y={viewBox.cy + 18}
        className="fill-muted-foreground"
        style={{ fontSize: 12, letterSpacing: "0.04em" }}
      >
        checks
      </tspan>
    </text>
  )
}

/** The overview's latest changes, grouped by the hour they landed in so a
 * burst reads as one event and a lone change as one line. */
function RecentChanges({
  rows,
}: {
  rows: MonitoringStats["recent_transitions"]
}) {
  const groups: { key: string; label: string; rows: typeof rows }[] = []
  for (const t of rows) {
    const at = new Date(t.at)
    const key = `${at.toDateString()} ${at.getHours()}`
    let g = groups[groups.length - 1]
    if (!g || g.key !== key) {
      g = {
        key,
        label: at.toLocaleString([], {
          weekday: "short",
          hour: "2-digit",
          minute: "2-digit",
        }),
        rows: [],
      }
      groups.push(g)
    }
    g.rows.push(t)
  }
  return (
    <div className="-my-1 space-y-2">
      {groups.map((g) => (
        <div key={g.key}>
          <div className="flex items-center gap-2 py-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
            {g.label}
            <span className="font-normal normal-case">
              · {g.rows.length} change{g.rows.length === 1 ? "" : "s"}
            </span>
          </div>
          <ul className="divide-y divide-border">
            {g.rows.map((t) => (
              <li
                key={t.id}
                className="flex items-center gap-2 py-1.5 text-[13px]"
              >
                <CheckStatusBadge status={t.from_status} />
                <span className="text-muted-foreground">→</span>
                <CheckStatusBadge status={t.to_status} />
                {t.target_ip ? (
                  <Link
                    to="/ips/$id"
                    params={{ id: t.target_ip.id }}
                    search={{ tab: "monitoring" }}
                    className="link ml-2 truncate font-mono font-medium"
                  >
                    {t.target_ip.ip_address}
                  </Link>
                ) : (
                  <span className="ml-2 text-muted-foreground">-</span>
                )}
                <span className="truncate text-muted-foreground">
                  {t.template_name ?? t.kind}
                </span>
                <SourceBadge source={t.source} engine={t.engine} />
                <span className="ml-auto shrink-0">
                  <TimeCell iso={t.at} />
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}
