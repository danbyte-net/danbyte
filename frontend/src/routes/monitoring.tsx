import { useEffect, useState } from "react"
import {
  createFileRoute,
  Link,
  redirect,
  useNavigate,
} from "@tanstack/react-router"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
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

import {
  api,
  type CheckStatus,
  type FlappingRow,
  type MonitoringStats,
  type StatsHours,
} from "@/lib/api"
import { labelTicks } from "@/lib/chart-axis"
import { TimeCell } from "@/components/cells/time-ago"
import { QueryError } from "@/components/query-error"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { useDateFormat } from "@/lib/datetime"
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
  type ChartConfig,
} from "@/components/ui/chart"
import {
  statusColor,
  statusLabel,
  useStatusLabels,
} from "@/components/monitoring/status-palette"
import { CheckStatusBadge } from "@/components/monitoring/status-badge"
import {
  MixedStatusBadge,
  StatePill,
  mixedEntries,
} from "@/components/monitoring/mixed-status-badge"
import { StateTip } from "@/components/monitoring/monitoring-bar"
import { Kpi } from "@/components/kpi-card"
import { ChecksList } from "@/components/monitoring/checks-list"
import { HistoryView } from "@/components/monitoring/history-view"
import { CertKeyHealthCard } from "@/components/monitoring/cert-key-health"
import { SourceBadge } from "@/components/monitoring/source-badge"
import { LatencyByKindChart } from "@/components/monitoring/latency-by-kind"
import { usePageTitle } from "@/lib/page-title"
import {
  legacyHref,
  legacyMonitoringTarget,
  type MonitoringSearch,
  monitoringSearch,
  STATUS_VIEWS,
  type StatusView,
} from "@/lib/monitoring-nav"
import { MonitoringTabs } from "@/components/monitoring/monitoring-tabs"

export const Route = createFileRoute("/monitoring")({
  component: MonitoringPage,
  validateSearch: monitoringSearch(STATUS_VIEWS),
  // The page used to hold every Monitoring tab; an old `?view=` (or `?tab=`)
  // link lands on the page that tab moved to, filters and all.
  beforeLoad: ({ location }) => redirectLegacy(location),
})

function redirectLegacy(location: { search: unknown; hash: string }): void {
  const target = legacyMonitoringTarget(
    location.search as Record<string, unknown>
  )
  if (target) throw redirect({ href: legacyHref(target, location.hash) })
}

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

function MonitoringPage() {
  usePageTitle("Monitoring")
  const { formatCustom } = useDateFormat()
  const search: MonitoringSearch<StatusView> = Route.useSearch()
  const view: StatusView = search.view ?? "overview"
  const labels = useStatusLabels()
  const nav = useNavigate()
  // Changing tab starts clean - a history filter has no business on the
  // Overview.
  const go = (next: StatusView) =>
    nav({
      to: "/monitoring",
      search: next === "overview" ? {} : { view: next },
    })

  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const [hours, setHours] = useState<StatsHours>(24)
  const stats = useQuery({
    queryKey: ["monitoring-stats", hours],
    queryFn: () =>
      api<MonitoringStats>(`/api/monitoring/stats/?hours=${hours}`),
    placeholderData: keepPreviousData,
    // The Overview's figures; History and Flapping read their own.
    enabled: view === "overview",
  })
  const d = stats.data

  const flapping = useQuery({
    queryKey: ["monitoring-flapping"],
    queryFn: () => api<{ results: FlappingRow[] }>("/api/monitoring/flapping/"),
    refetchInterval: 60_000,
  })
  const flaps = flapping.data?.results ?? []

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

  const statusData = d
    ? STATUS_ORDER.map((s) => ({
        status: s,
        value: d.by_status[s] ?? 0,
        fill: `var(--color-${s})`,
      })).filter((s) => s.value > 0)
    : []

  const kindData = d
    ? Object.entries(d.by_kind)
        .map(([k, v]) => ({
          kind: k,
          value: v as number,
          fill: `var(--color-${k})`,
        }))
        .sort((a, b) => b.value - a.value)
    : []

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

  const seriesData = (d?.series ?? []).map((p) => ({
    ...p,
    label:
      d?.series_bucket === "day"
        ? formatCustom(p.t, { month: "short", day: "numeric" })
        : hours > 24
          ? formatCustom(p.t, { weekday: "short", hour: "2-digit" })
          : formatCustom(p.t, { hour: "2-digit" }),
  }))
  const windowLabel =
    hours === 24 ? "24 hours" : hours === 168 ? "7 days" : "30 days"
  const latencyLabel = (t: string) =>
    d?.series_bucket === "day"
      ? formatCustom(t, { month: "short", day: "numeric" })
      : hours > 24
        ? formatCustom(t, { weekday: "short", hour: "2-digit" })
        : formatCustom(t, { hour: "2-digit" })
  const alertsData = (d?.alerts_series ?? []).map((p) => ({
    ...p,
    label: formatCustom(p.t, { month: "short", day: "numeric" }),
  }))

  const total = d?.total_checks ?? 0
  const pct = (n: number) => (total > 0 ? Math.round((n / total) * 100) : 0)

  return (
    <MonitoringTabs
      crumb={false}
      label="Status views"
      value={view}
      onValueChange={go}
      padded={view === "overview"}
      items={[
        { value: "overview", label: "Overview" },
        ...(flaps.length > 0 || view === "flapping"
          ? [
              {
                value: "flapping" as const,
                label: "Flapping",
                count: flaps.length,
              },
            ]
          : []),
        { value: "history", label: "History" },
      ]}
    >
      {stats.isError && view === "overview" && (
        <QueryError error={stats.error} />
      )}

      {view === "history" && <HistoryView />}
      {view === "flapping" && <ChecksList flappingOnly />}

      {view === "overview" && d && (
        <div className="mx-auto mb-4 flex max-w-7xl items-center gap-3 lg:mb-6">
          <h1 className="text-base font-semibold">Overview</h1>
          {total > 0 && (
            <span className="ml-auto inline-flex items-center gap-2 text-xs text-muted-foreground">
              <StatusSummary
                counts={d.by_status}
                onOpen={(status) =>
                  nav({
                    to: "/monitoring/checks",
                    search: status === "all" ? {} : { status },
                  })
                }
              />
              <span className="num whitespace-nowrap">
                {pct(d.by_status.up ?? 0)}% reachable
              </span>
            </span>
          )}
        </div>
      )}
      {view === "overview" && d && (
        <div className="mx-auto max-w-7xl space-y-4 lg:space-y-6">
          {/* KPI cards */}
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
            <Kpi label="Total checks" value={total} />
            <Kpi label="Monitored IPs" value={d.monitored_ips} />
            {d.availability_pct != null && (
              <Kpi
                label={`Availability · ${windowLabel}`}
                value={d.availability_pct}
                unit="%"
                tone={
                  d.availability_pct >= 99.9
                    ? "up"
                    : d.availability_pct >= 99
                      ? "flapping"
                      : "down"
                }
              />
            )}
            <Kpi
              label="Up"
              value={d.by_status.up ?? 0}
              tone="up"
              badge={`${pct(d.by_status.up ?? 0)}%`}
            />
            <Kpi
              label="Down"
              value={d.by_status.down ?? 0}
              tone="down"
              badge={(d.by_status.down ?? 0) > 0 ? "alert" : undefined}
            />
            <Kpi label="Stale" value={d.by_status.stale ?? 0} tone="stale" />
            <Kpi
              label="Skipped"
              value={d.by_status.skipped ?? 0}
              tone="skipped"
            />
            {d.fast_lane.fast_checks > 0 && (
              <Kpi
                label="Fast lane"
                value={d.fast_lane.fast_checks}
                tone={d.fast_lane.alive ? undefined : "down"}
                badge={
                  d.fast_lane.alive ? `${d.fast_lane.probes_per_s}/s` : "alert"
                }
              />
            )}
            {flaps.length > 0 && (
              <Link
                to="/monitoring"
                search={{ view: "flapping" }}
                className="block"
              >
                <Kpi
                  label="Flapping now"
                  value={flaps.length}
                  tone="flapping"
                  badge="alert"
                />
              </Link>
            )}
          </div>

          {/* Certificate & key health - expiry buckets, SSH drift, firing
                alerts, each opening the matching list. Hidden with no certs. */}
          <CertKeyHealthCard />

          {/* Hero: results over time (shadcn stacked area) */}
          <Card>
            <CardHeader>
              <CardTitle>Check results</CardTitle>
              <CardDescription>
                Outcomes per {d.series_bucket} over the last {windowLabel}
              </CardDescription>
              <CardAction>
                <SegmentedTabs
                  value={String(hours)}
                  onValueChange={(v) => setHours(Number(v) as StatsHours)}
                  items={[
                    { value: "24", label: "24h" },
                    { value: "168", label: "7d" },
                    { value: "720", label: "30d" },
                  ]}
                />
              </CardAction>
            </CardHeader>
            <CardContent>
              {!mounted || seriesData.length === 0 ? (
                <Placeholder
                  h="h-[250px]"
                  hint={`No results recorded in the last ${windowLabel}.`}
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
                        seriesData.map((p) =>
                          Math.max(p.up, p.degraded, p.down)
                        )
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

          {/* The estate's latency and the alert flow, over the same window */}
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
                  <Placeholder h="h-[200px]" hint="" />
                ) : (
                  <LatencyByKindChart
                    kinds={d.latency_by_kind ?? []}
                    formatLabel={latencyLabel}
                    empty={
                      <Placeholder
                        h="h-[200px]"
                        hint={`No latency recorded in the last ${windowLabel}.`}
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
                <CardDescription>
                  Opened against resolved, per day
                </CardDescription>
              </CardHeader>
              <CardContent>
                {!mounted || alertsData.length === 0 ? (
                  <Placeholder h="h-[200px]" hint="No alerts in this window." />
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
                      <Bar
                        dataKey="opened"
                        fill="var(--color-opened)"
                        radius={3}
                      />
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

          {/* Distribution + by-kind */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:gap-6">
            {/* Donut with text (shadcn) */}
            <Card className="flex flex-col">
              <CardHeader className="items-center pb-0">
                <CardTitle>Status distribution</CardTitle>
                <CardDescription>Current status of all checks</CardDescription>
              </CardHeader>
              <CardContent className="flex-1 pb-0">
                {!mounted || statusData.length === 0 ? (
                  <Placeholder h="h-[250px]" hint="No checks yet." />
                ) : (
                  <>
                    {/* The legend lives outside the chart on purpose. A
                          recharts Legend inside the PieChart shrinks the
                          plot area, the pie moves up, and the centre label
                          keeps the un-shrunk centre - so "22 checks" sat
                          below the ring. Outside, the ring, its label and
                          the legend each centre in their own box. */}
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
                  <Placeholder h="h-[250px]" hint="No checks yet." />
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

          {/* Recent changes */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:gap-6">
            <Card>
              <CardHeader>
                <CardTitle>Recent changes</CardTitle>
                <CardDescription>
                  The latest status changes, newest first
                </CardDescription>
                <CardAction>
                  <Link
                    to="/monitoring"
                    search={{ view: "history" }}
                    className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                  >
                    All history
                  </Link>
                </CardAction>
              </CardHeader>
              <CardContent>
                {d.recent_transitions.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    No status changes recorded yet.
                  </p>
                ) : (
                  <RecentChanges rows={d.recent_transitions} />
                )}
              </CardContent>
            </Card>
          </div>

          <p className="text-[11px] text-muted-foreground">
            Configure individual checks from an{" "}
            <Link to="/prefixes" className="underline underline-offset-2">
              IP or prefix
            </Link>{" "}
            page. Alerts go out via notification channels.
          </p>
        </div>
      )}
    </MonitoringTabs>
  )
}

/** Every check's state as the shared mixed badge, with the shared hover (a
 * pill and a count per state, worst first) and a click to the Checks tab -
 * filtered to the worst state when something is wrong. */
function StatusSummary({
  counts,
  onOpen,
}: {
  counts: Partial<Record<CheckStatus, number>>
  onOpen: (status: CheckStatus | "all") => void
}) {
  const entries = mixedEntries(counts).reverse()
  const worst = entries.find(([s]) => s !== "up" && s !== "skipped")?.[0]
  return (
    <StateTip
      content={
        <ul className="flex flex-col gap-1 text-[12px]">
          {entries.map(([s, n]) => (
            <li key={s} className="flex items-center gap-3">
              <StatePill state={s} />
              <span className="num ml-auto">{n}</span>
            </li>
          ))}
        </ul>
      }
    >
      <button
        type="button"
        className="inline-flex rounded-[5px] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        data-testid="monitoring-status-summary"
        onClick={() => onOpen((worst as CheckStatus | undefined) ?? "all")}
      >
        <MixedStatusBadge counts={counts} />
      </button>
    </StateTip>
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

function Placeholder({ h, hint }: { h: string; hint: string }) {
  return (
    <div
      className={`flex items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground ${h}`}
    >
      {hint}
    </div>
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
