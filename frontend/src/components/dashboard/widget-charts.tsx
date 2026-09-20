import { Link, useNavigate } from "@tanstack/react-router"
import {
  Bar,
  BarChart,
  CartesianGrid,
  Label,
  LabelList,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from "recharts"

import type { DashActivity, DashDist, DashTopPrefix } from "@/lib/api"
import { STATUS_COLOR } from "@/components/monitoring/charts"
import {
  statusColor,
  statusLabel,
} from "@/components/monitoring/status-palette"
import { useDateFormat } from "@/lib/datetime"
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

// A chart segment/bar → its filtered-list destination. Returns the route + the
// search params (built from the datum's `key`) so a click lands on the matching
// pre-filtered list, or undefined to make the segment non-clickable.
export type DistLink = (
  d: DashDist
) => { to: string; search?: Record<string, string | undefined> } | undefined

/** Donut + side legend that fills its tile height. `link` (optional) turns each
 * legend row into a jump to the matching list page. */
export function DistDonut({
  data,
  unit = "total",
  link,
}: {
  data: DashDist[]
  unit?: string
  link?: DistLink
}) {
  if (!data.length) return <Empty />
  const sum = data.reduce((n, d) => n + d.count, 0)
  const chartData = data.map((d) => ({ ...d, fill: d.color }))
  return (
    // A container query, not a viewport one (#156). A dashboard widget can be
    // narrow while the screen is wide, so `sm:flex-row` put the legend beside
    // the donut in a tile with no room for it and the text ran outside the
    // card. The query has to live on a parent: an element cannot respond to
    // its own width.
    <div className="@container h-full">
      <div className="flex h-full flex-col items-center gap-2 @md:flex-row @md:justify-center @md:gap-6">
        {/* Grows with the tile: height follows the row, width follows via
            aspect-square. Fixed 170px made a 3x3 tile look mostly empty.
            Safe re #42: tile size only changes between gestures - bodies are
            unmounted placeholders while a drag/resize is in flight. */}
        {/* Stacked (a narrow tile): the ring takes what the legend leaves,
            or the legend lands below the body's edge and is never seen.
            Side by side: the ring takes the height and the legend only the
            width its rows need, so a short legend leaves the ring the room
            and a long one grows into it - up to half the tile. */}
        <ChartContainer
          config={configFor(data)}
          className="mx-auto aspect-square min-h-[120px] w-auto max-w-full flex-1 @md:mx-0 @md:h-full @md:max-h-[300px] @md:flex-none"
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
              innerRadius="64%"
              outerRadius="96%"
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
        {/* Stacked: entries flow in a centred row and wrap, so four short
            ones cost one line and the ring keeps the rest. Side by side: one
            entry per row, counts aligned at the legend's own right edge. */}
        <ul className="flex w-full min-w-0 shrink-0 flex-wrap justify-center gap-x-4 gap-y-1 text-[12px] @md:grid @md:w-auto @md:min-w-28 @md:max-w-[50%] @md:grid-cols-[minmax(0,1fr)] @md:gap-x-3">
          {data.slice(0, 6).map((d) => {
            const target = link?.(d)
            const row = (
              <>
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
                  style={{ backgroundColor: d.color }}
                />
                <span className="truncate text-muted-foreground">{d.name}</span>
                <span className="num ml-auto font-medium text-foreground tabular-nums">
                  {d.count.toLocaleString()}
                </span>
              </>
            )
            return (
              <li key={d.name} className="min-w-0 max-w-full">
                {target ? (
                  <Link
                    to={target.to}
                    search={target.search}
                    className="-mx-1 flex items-center gap-1.5 rounded px-1 hover:bg-muted/50"
                  >
                    {row}
                  </Link>
                ) : (
                  <span className="flex items-center gap-1.5">{row}</span>
                )}
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}

/** Horizontal bars sized to their content. `link` (optional) makes a bar click
 * jump to the matching list page. */
export function DistBar({ data, link }: { data: DashDist[]; link?: DistLink }) {
  const navigate = useNavigate()
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
        <Bar
          dataKey="count"
          radius={5}
          cursor={link ? "pointer" : undefined}
          onClick={
            link
              ? (d: { name?: string }) => {
                  const datum = d as unknown as DashDist
                  const target = datum?.name ? link(datum) : undefined
                  if (target) navigate({ to: target.to, search: target.search })
                }
              : undefined
          }
        >
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

/** A percentage ring - the "hero" KPI.
 *
 * Same visual language as DistDonut (ring geometry, size, centre type scale):
 * it used to be a RadialBarChart with its own sizing, which made this one
 * tile read as a different product from the donuts beside it. */
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
  const data = [
    { name: label, value, fill: color },
    { name: "remainder", value: 100 - value, fill: "var(--muted)" },
  ]
  return (
    // The same box as DistDonut's ring: without max-w-full a square that
    // follows the tile's height overflows a tile narrower than it is tall
    // and the ring is clipped at the edges.
    <div className="flex h-full items-center justify-center">
      <ChartContainer
        config={{ value: { label } }}
        className="mx-auto aspect-square h-full max-h-[300px] min-h-[150px] w-auto max-w-full shrink-0"
      >
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            nameKey="name"
            innerRadius="62%"
            strokeWidth={4}
            startAngle={90}
            endAngle={-270}
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
                      {value}%
                    </tspan>
                    <tspan
                      x={cx}
                      y={cy + 16}
                      className="fill-muted-foreground"
                      style={{ fontSize: 11 }}
                    >
                      {label}
                    </tspan>
                  </text>
                )
              }}
            />
          </Pie>
        </PieChart>
      </ChartContainer>
    </div>
  )
}

/** Top prefixes by utilisation - fills the tile. */
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
              className="link w-32 shrink-0 truncate font-mono"
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

/** Object-count panel - a dense table of model counts + links. */
const COUNT_ROWS: { key: string; label: string; to?: string }[] = [
  { key: "sites", label: "Sites", to: "/sites" },
  { key: "prefixes", label: "Prefixes", to: "/prefixes" },
  { key: "ips", label: "IP addresses" },
  { key: "vlans", label: "VLANs", to: "/vlans" },
  { key: "vrfs", label: "VRFs", to: "/vrfs" },
  { key: "devices", label: "Devices", to: "/devices" },
  { key: "interfaces", label: "Interfaces", to: "/interfaces" },
  { key: "cables", label: "Cables", to: "/cables" },
  { key: "bgp_sessions", label: "BGP sessions", to: "/bgp-sessions" },
  { key: "static_routes", label: "Static routes", to: "/static-routes" },
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

/** Recent monitoring status changes - the recent-changes feed. */
export function RecentActivity({ rows }: { rows: DashActivity[] }) {
  const { formatCustom } = useDateFormat()
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
              className="link ml-1 truncate font-mono font-medium"
            >
              {r.ip}
            </Link>
          ) : (
            <span className="ml-1 font-mono">{r.ip}</span>
          )}
          <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
            {formatCustom(r.at, {
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
      title={statusLabel(status)}
    >
      <span
        className="h-2 w-2 rounded-full"
        style={{ backgroundColor: statusColor(status) }}
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
