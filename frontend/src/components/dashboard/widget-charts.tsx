import { Link } from "@tanstack/react-router"
import {
  Bar,
  BarChart,
  CartesianGrid,
  Label,
  LabelList,
  Pie,
  PieChart,
  PolarGrid,
  PolarRadiusAxis,
  RadialBar,
  RadialBarChart,
  XAxis,
  YAxis,
} from "recharts"

import type { DashActivity, DashDist, DashTopPrefix } from "@/lib/api"
import { STATUS_COLOR, STATUS_LABEL } from "@/components/monitoring/charts"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"

// A shadcn ChartConfig keyed by each category name so tooltips/legends resolve.
function configFor(data: DashDist[]): ChartConfig {
  const cfg: ChartConfig = { count: { label: "Count" } }
  for (const d of data) cfg[d.name] = { label: d.name, color: d.color }
  return cfg
}

/** Donut + side legend that fills its tile height. */
export function DistDonut({
  data,
  unit = "total",
}: {
  data: DashDist[]
  unit?: string
}) {
  if (!data.length) return <Empty />
  const sum = data.reduce((n, d) => n + d.count, 0)
  const chartData = data.map((d) => ({ ...d, fill: d.color }))
  return (
    <div className="flex flex-col items-center gap-2 sm:flex-row">
      <ChartContainer
        config={configFor(data)}
        className="mx-auto aspect-square h-[170px] shrink-0"
      >
        <PieChart>
          <ChartTooltip
            cursor={false}
            content={<ChartTooltipContent hideLabel />}
          />
          <Pie
            data={chartData}
            dataKey="count"
            nameKey="name"
            innerRadius="62%"
            strokeWidth={4}
          >
            <Label
              content={({ viewBox }) => {
                if (!viewBox || !("cx" in viewBox) || viewBox.cx == null)
                  return null
                const { cx, cy } = viewBox as { cx: number; cy: number }
                return (
                  <text x={cx} y={cy} textAnchor="middle">
                    <tspan
                      x={cx}
                      y={cy - 2}
                      className="fill-foreground"
                      style={{ fontSize: 22, fontWeight: 700 }}
                    >
                      {sum.toLocaleString()}
                    </tspan>
                    <tspan
                      x={cx}
                      y={cy + 16}
                      className="fill-muted-foreground"
                      style={{ fontSize: 11 }}
                    >
                      {unit}
                    </tspan>
                  </text>
                )
              }}
            />
          </Pie>
        </PieChart>
      </ChartContainer>
      <ul className="grid w-full grid-cols-2 gap-x-3 gap-y-1 text-[12px] sm:flex-1 sm:grid-cols-1">
        {data.slice(0, 6).map((d) => (
          <li key={d.name} className="flex items-center gap-1.5">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
              style={{ backgroundColor: d.color }}
            />
            <span className="truncate text-muted-foreground">{d.name}</span>
            <span className="num ml-auto font-medium text-foreground tabular-nums">
              {d.count.toLocaleString()}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Horizontal bars sized to their content. */
export function DistBar({ data }: { data: DashDist[] }) {
  if (!data.length) return <Empty />
  const chartData = data.map((d) => ({ ...d, fill: d.color }))
  const h = Math.max(120, data.length * 38 + 8)
  return (
    <ChartContainer
      config={configFor(data)}
      className="aspect-auto w-full"
      style={{ height: h }}
    >
      <BarChart
        accessibilityLayer
        data={chartData}
        layout="vertical"
        margin={{ left: 8, right: 28 }}
      >
        <CartesianGrid horizontal={false} />
        <XAxis type="number" dataKey="count" hide />
        <YAxis
          type="category"
          dataKey="name"
          width={92}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v: string) =>
            v.length > 13 ? v.slice(0, 12) + "…" : v
          }
        />
        <ChartTooltip
          cursor={false}
          content={<ChartTooltipContent hideLabel />}
        />
        <Bar dataKey="count" radius={5}>
          <LabelList
            dataKey="count"
            position="right"
            offset={8}
            fill="var(--foreground)"
            fontSize={12}
          />
        </Bar>
      </BarChart>
    </ChartContainer>
  )
}

/** A radial gauge with a big % in the centre — the "hero" KPI. */
export function RadialGauge({
  value,
  label,
  color = "var(--primary)",
}: {
  value: number | null
  label: string
  color?: string
}) {
  if (value == null) return <Empty hint="No checks yet." />
  const data = [{ name: label, value, fill: color }]
  const angle = 90 + (value / 100) * 360
  return (
    <ChartContainer
      config={{ value: { label } }}
      className="mx-auto aspect-square h-[180px]"
    >
      <RadialBarChart
        data={data}
        startAngle={90}
        endAngle={angle}
        innerRadius="72%"
        outerRadius="100%"
      >
        <PolarGrid
          gridType="circle"
          radialLines={false}
          stroke="none"
          className="first:fill-muted last:fill-background"
          polarRadius={[86, 70]}
        />
        <RadialBar dataKey="value" background cornerRadius={12} />
        <PolarRadiusAxis tick={false} tickLine={false} axisLine={false}>
          <Label
            content={({ viewBox }) => {
              if (!viewBox || !("cx" in viewBox) || viewBox.cx == null)
                return null
              const { cx, cy } = viewBox as { cx: number; cy: number }
              return (
                <text x={cx} y={cy} textAnchor="middle">
                  <tspan
                    x={cx}
                    y={cy - 2}
                    className="fill-foreground"
                    style={{ fontSize: 30, fontWeight: 700 }}
                  >
                    {value}%
                  </tspan>
                  <tspan
                    x={cx}
                    y={cy + 18}
                    className="fill-muted-foreground"
                    style={{ fontSize: 11 }}
                  >
                    {label}
                  </tspan>
                </text>
              )
            }}
          />
        </PolarRadiusAxis>
      </RadialBarChart>
    </ChartContainer>
  )
}

/** Top prefixes by utilisation — fills the tile. */
export function TopPrefixes({ data }: { data: DashTopPrefix[] }) {
  if (!data.length) return <Empty />
  return (
    <ul className="space-y-2.5">
      {data.slice(0, 8).map((p) => {
        const pct = p.utilisation_pct ?? 0
        const tier =
          pct > 95 ? "bg-red-500" : pct > 80 ? "bg-amber-500" : "bg-primary"
        return (
          <li key={p.id} className="flex items-center gap-3 text-[13px]">
            <Link
              to="/prefixes/$id"
              params={{ id: p.id }}
              className="w-32 shrink-0 truncate font-mono hover:underline"
            >
              {p.cidr}
            </Link>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className={`h-full rounded-full ${tier}`}
                style={{ width: `${Math.min(100, pct)}%` }}
              />
            </div>
            <span className="num w-10 shrink-0 text-right text-muted-foreground tabular-nums">
              {pct}%
            </span>
          </li>
        )
      })}
    </ul>
  )
}

/** Object-count panel — a dense table of model counts + links. */
const COUNT_ROWS: { key: string; label: string; to?: string }[] = [
  { key: "sites", label: "Sites", to: "/sites" },
  { key: "prefixes", label: "Prefixes", to: "/prefixes" },
  { key: "ips", label: "IP addresses" },
  { key: "vlans", label: "VLANs", to: "/vlans" },
  { key: "vrfs", label: "VRFs", to: "/vrfs" },
  { key: "devices", label: "Devices", to: "/devices" },
  { key: "interfaces", label: "Interfaces", to: "/interfaces" },
  { key: "cables", label: "Cables", to: "/cables" },
]

export function ObjectCounts({ counts }: { counts: Record<string, number> }) {
  return (
    <ul className="divide-y divide-border/60">
      {COUNT_ROWS.map((r) => {
        const body = (
          <span className="flex items-baseline justify-between py-1.5">
            <span className="text-[13px] text-muted-foreground">{r.label}</span>
            <span className="num text-[15px] font-semibold tabular-nums">
              {(counts[r.key] ?? 0).toLocaleString()}
            </span>
          </span>
        )
        return (
          <li key={r.key}>
            {r.to ? (
              <Link
                to={r.to}
                className="block rounded px-1 transition-colors hover:bg-muted/50"
              >
                {body}
              </Link>
            ) : (
              <div className="px-1">{body}</div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/** Recent monitoring status changes — the recent-changes feed. */
export function RecentActivity({ rows }: { rows: DashActivity[] }) {
  if (!rows.length) return <Empty hint="No recent changes." />
  return (
    <ul className="divide-y divide-border/60">
      {rows.slice(0, 8).map((r, i) => (
        <li key={i} className="flex items-center gap-2 py-1.5 text-[13px]">
          <Dot status={r.from_status} />
          <span className="text-muted-foreground">→</span>
          <Dot status={r.to_status} />
          {r.ip_id ? (
            <Link
              to="/ips/$id"
              params={{ id: r.ip_id }}
              className="ml-1 truncate font-mono font-medium hover:underline"
            >
              {r.ip}
            </Link>
          ) : (
            <span className="ml-1 font-mono">{r.ip}</span>
          )}
          <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
            {new Date(r.at).toLocaleString([], {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        </li>
      ))}
    </ul>
  )
}

function Dot({ status }: { status: keyof typeof STATUS_COLOR }) {
  return (
    <span
      className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"
      title={STATUS_LABEL[status]}
    >
      <span
        className="h-2 w-2 rounded-full"
        style={{ backgroundColor: STATUS_COLOR[status] }}
      />
    </span>
  )
}

function Empty({ hint = "No data yet." }: { hint?: string }) {
  return (
    <div className="flex h-full min-h-[120px] items-center justify-center text-sm text-muted-foreground">
      {hint}
    </div>
  )
}
