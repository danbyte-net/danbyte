import { useEffect, useState } from "react"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { Activity, AlertTriangle } from "lucide-react"
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
} from "@/lib/api"
import { QueryError } from "@/components/query-error"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { EngineHealthBanner } from "@/components/monitoring/engine-health-banner"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { STATUS_COLOR, STATUS_LABEL } from "@/components/monitoring/charts"
import { CheckStatusBadge } from "@/components/monitoring/status-badge"
import { MonitoringSettingsForm } from "@/components/monitoring/settings-form"
import { ChecksList } from "@/components/monitoring/checks-list"
import { TemplatesList } from "@/components/monitoring/templates-list"
import { MonitoringConfiguration } from "@/components/monitoring/configuration"

type MonitoringView = "overview" | "checks" | "templates" | "configuration"
interface MonitoringSearch {
  view: MonitoringView
  status: CheckStatus | "all"
}

const VIEWS: MonitoringView[] = [
  "overview",
  "checks",
  "templates",
  "configuration",
]

export const Route = createFileRoute("/monitoring")({
  component: MonitoringPage,
  validateSearch: (s: Record<string, unknown>): MonitoringSearch => ({
    view: VIEWS.includes(s.view as MonitoringView)
      ? (s.view as MonitoringView)
      : "overview",
    status:
      typeof s.status === "string" ? (s.status as CheckStatus | "all") : "all",
  }),
})

const STATUS_ORDER: CheckStatus[] = [
  "up",
  "degraded",
  "down",
  "stale",
  "skipped",
  "unknown",
]

const SERIES_CONFIG = {
  up: { label: "Up", color: STATUS_COLOR.up },
  degraded: { label: "Degraded", color: STATUS_COLOR.degraded },
  down: { label: "Down", color: STATUS_COLOR.down },
} satisfies ChartConfig

// The brand chart palette (from the adopted preset) — used to colour the
// by-protocol bars, the shadcn way.
const KIND_PALETTE = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
]

function MonitoringPage() {
  const { view, status } = Route.useSearch()
  const nav = useNavigate()
  const go = (next: Partial<MonitoringSearch>) =>
    nav({
      to: "/monitoring",
      search: (prev: Partial<MonitoringSearch>): MonitoringSearch => ({
        view: next.view ?? prev.view ?? "overview",
        status: next.status ?? prev.status ?? "all",
      }),
    })

  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const stats = useQuery({
    queryKey: ["monitoring-stats"],
    queryFn: () => api<MonitoringStats>("/api/monitoring/stats/"),
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
  const statusConfig = {
    value: { label: "Checks" },
    ...Object.fromEntries(
      STATUS_ORDER.map((s) => [
        s,
        { label: STATUS_LABEL[s], color: STATUS_COLOR[s] },
      ])
    ),
  } satisfies ChartConfig

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
    label: new Date(p.t).toLocaleTimeString([], { hour: "2-digit" }),
  }))

  const total = d?.total_checks ?? 0
  const pct = (n: number) => (total > 0 ? Math.round((n / total) * 100) : 0)

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-muted/30">
      <header className="flex h-14 shrink-0 [scrollbar-width:none] items-center gap-3 overflow-x-auto border-b border-border bg-background px-4 lg:px-6 [&::-webkit-scrollbar]:hidden [&>*]:shrink-0">
        <h1 className="flex items-center gap-2 text-base font-semibold">
          <Activity className="h-4 w-4 text-muted-foreground" />
          Monitoring
        </h1>
        <SegmentedTabs
          className="ml-2"
          value={view}
          onValueChange={(v) => go({ view: v as MonitoringView })}
          items={[
            { value: "overview", label: "Overview" },
            { value: "checks", label: "Checks" },
            { value: "templates", label: "Templates" },
            { value: "configuration", label: "Configuration" },
          ]}
        />
        {d && (
          <Badge variant="secondary" className="ml-auto">
            {pct(d.by_status.up ?? 0)}% reachable
          </Badge>
        )}
      </header>

      {/* Dead-Outpost banner — impossible to miss when checks are stalling. */}
      <EngineHealthBanner />

      {/* Configuration lays out its own full-height rail + table shell (like
          /prefixes), so the shared padding lives on the other views instead. */}
      <div
        className={
          view === "configuration"
            ? "flex min-h-0 flex-1 flex-col"
            : "min-h-0 flex-1 overflow-auto p-4 lg:p-6"
        }
      >
        {stats.isError && <QueryError error={stats.error} />}

        {view === "checks" && (
          <div className="mx-auto max-w-7xl">
            <ChecksList
              status={status}
              onStatusChange={(s) => go({ status: s })}
            />
          </div>
        )}

        {view === "templates" && (
          <div className="mx-auto max-w-7xl">
            <TemplatesList />
          </div>
        )}

        {view === "configuration" && <MonitoringConfiguration />}

        {view === "overview" && d && (
          <div className="mx-auto max-w-7xl space-y-4 lg:space-y-6">
            {/* KPI cards */}
            <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
              <Kpi label="Total checks" value={total} />
              <Kpi label="Monitored IPs" value={d.monitored_ips} />
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
            </div>

            {/* Hero: results over time (shadcn stacked area) */}
            <Card>
              <CardHeader>
                <CardTitle>Check results</CardTitle>
                <CardDescription>
                  Outcomes per hour over the last 24 hours
                </CardDescription>
              </CardHeader>
              <CardContent>
                {!mounted || seriesData.length === 0 ? (
                  <Placeholder
                    h="h-[250px]"
                    hint="No results recorded in the last 24 hours."
                  />
                ) : (
                  <ChartContainer
                    config={SERIES_CONFIG}
                    className="aspect-auto h-[250px] w-full"
                  >
                    <LineChart
                      accessibilityLayer
                      data={seriesData}
                      margin={{ left: 12, right: 12 }}
                    >
                      <CartesianGrid vertical={false} />
                      <XAxis
                        dataKey="label"
                        tickLine={false}
                        axisLine={false}
                        tickMargin={8}
                        minTickGap={32}
                      />
                      <YAxis
                        tickLine={false}
                        axisLine={false}
                        width={32}
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

            {/* Distribution + by-kind */}
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:gap-6">
              {/* Donut with text (shadcn) */}
              <Card className="flex flex-col">
                <CardHeader className="items-center pb-0">
                  <CardTitle>Status distribution</CardTitle>
                  <CardDescription>
                    Current status of all checks
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex-1 pb-0">
                  {!mounted || statusData.length === 0 ? (
                    <Placeholder h="h-[250px]" hint="No checks yet." />
                  ) : (
                    <ChartContainer
                      config={statusConfig}
                      className="mx-auto aspect-square max-h-[250px]"
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
                        <ChartLegend
                          content={<ChartLegendContent nameKey="status" />}
                          className="-translate-y-2 flex-wrap gap-2 *:basis-1/4 *:justify-center"
                        />
                      </PieChart>
                    </ChartContainer>
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

            {/* Recent changes + flapping share a row */}
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:gap-6">
              <Card>
                <CardHeader>
                  <CardTitle>Recent status changes</CardTitle>
                  <CardDescription>
                    Latest transitions across the tenant
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {d.recent_transitions.length === 0 ? (
                    <p className="py-8 text-center text-sm text-muted-foreground">
                      No status changes recorded yet.
                    </p>
                  ) : (
                    <ul className="-my-1 divide-y divide-border">
                      {d.recent_transitions.map((t) => (
                        <li
                          key={t.id}
                          className="flex items-center gap-2 py-2 text-[13px]"
                        >
                          <CheckStatusBadge status={t.from_status} />
                          <span className="text-muted-foreground">→</span>
                          <CheckStatusBadge status={t.to_status} />
                          {t.target_ip ? (
                            <Link
                              to="/ips/$id"
                              params={{ id: t.target_ip.id }}
                              className="ml-2 truncate font-mono font-medium hover:underline"
                            >
                              {t.target_ip.ip_address}
                            </Link>
                          ) : (
                            <span className="ml-2 text-muted-foreground">
                              —
                            </span>
                          )}
                          <span className="truncate text-muted-foreground">
                            {t.template_name ?? t.kind}
                          </span>
                          <span className="num ml-auto shrink-0 text-[11px] text-muted-foreground">
                            {new Date(t.at).toLocaleString()}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>

              {flaps.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4 text-amber-500" />
                    Flapping a lot — maybe check on these
                  </CardTitle>
                  <CardDescription>
                    IPs bouncing repeatedly over the flap window. Tune the
                    threshold or exclude expected-churn statuses in settings.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <ul className="-my-1 divide-y divide-border">
                    {flaps.map((f) => (
                      <li
                        key={`${f.ip_id}:${f.template_id}`}
                        className="flex items-center gap-2 py-2 text-[13px]"
                      >
                        <Link
                          to="/ips/$id"
                          params={{ id: f.ip_id }}
                          className="truncate font-mono font-medium hover:underline"
                        >
                          {f.ip_address}
                        </Link>
                        {f.dns_name && (
                          <span className="truncate text-muted-foreground">
                            {f.dns_name}
                          </span>
                        )}
                        <span className="truncate text-muted-foreground">
                          {f.template_name ?? f.kind}
                        </span>
                        <span className="ml-auto shrink-0">
                          <Badge variant="warning">
                            <span className="num">{f.flap_count}</span> flaps /{" "}
                            {f.window_minutes}m
                          </Badge>
                        </span>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
              )}
            </div>

            {/* Settings — full width so its two-column form isn't cramped */}
            <Card>
              <CardHeader>
                <CardTitle>Settings &amp; defaults</CardTitle>
                <CardDescription>
                  Stale thresholds, the skip policy, and the global schedule
                </CardDescription>
              </CardHeader>
              <CardContent>
                <MonitoringSettingsForm />
              </CardContent>
            </Card>

            <p className="text-[11px] text-muted-foreground">
              Configure individual checks from an{" "}
              <Link to="/prefixes" className="underline underline-offset-2">
                IP or prefix
              </Link>{" "}
              page. Alerts go out via notification channels.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

const TONE: Record<string, string> = {
  up: "text-emerald-600 dark:text-emerald-400",
  down: "text-red-600 dark:text-red-400",
  stale: "text-red-700 dark:text-red-400",
  skipped: "text-muted-foreground",
}

function Kpi({
  label,
  value,
  tone,
  badge,
}: {
  label: string
  value: number
  tone?: keyof typeof TONE
  badge?: string
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle
          className={`text-2xl font-semibold tabular-nums ${
            tone ? TONE[tone] : ""
          }`}
        >
          {value.toLocaleString()}
        </CardTitle>
        {badge && (
          <CardAction>
            <Badge
              variant={
                badge === "alert"
                  ? "destructive"
                  : tone === "up"
                    ? "success"
                    : "secondary"
              }
            >
              {badge === "alert" ? "needs attention" : badge}
            </Badge>
          </CardAction>
        )}
      </CardHeader>
    </Card>
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
