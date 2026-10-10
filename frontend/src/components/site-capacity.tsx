import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type {
  PortCountRow,
  RackPower,
  SiteCapacity,
  SiteCapacityPlan,
  SiteCapacityRack,
  SiteCapacityTotals,
} from "@/lib/api"
import { CapacityBar } from "@/components/cells/capacity-bar"
import { PortsFigure } from "@/components/cells/ports-figure"
import { PowerFigure } from "@/components/cells/power-figure"
import { EmptyState } from "@/components/empty-state"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { SegmentedTabs } from "@/components/segmented-tabs"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { COLOR_BY_LABEL, metricRatio } from "@/components/floorplan/tile-paint"
import type {
  CapacityMetric,
  RackFigures,
} from "@/components/floorplan/tile-paint"
import {
  CAPACITY_HEX,
  CAPACITY_NONE_HEX,
  capacityBandLabel,
  capacityColor,
  capacityLevel,
  capacityRatio,
  useCapacityThresholds,
} from "@/lib/rack-capacity"
import { useUrlTab } from "@/lib/use-url-tab"
import { cn } from "@/lib/utils"

/** The site page shows its Capacity tab when the site has racks and you
 * may view racks. */
export function showCapacityTab(
  site: { rack_count: number },
  canViewRacks: boolean
): boolean {
  return site.rack_count > 0 && canViewRacks
}

const METRICS: readonly CapacityMetric[] = [
  "space",
  "power",
  "ports",
  "panel_ports",
]

/** A rack of the capacity answer as the floor plan's colouring reads one. */
export function siteRackFigures(r: SiteCapacityRack): RackFigures {
  return {
    used_units: r.u_used,
    u_height: r.u_height,
    power: r.power,
    ports: r.ports,
    panel_ports: r.panel_ports,
    role: r.role,
    status: r.status,
  }
}

/**
 * The site page's **Capacity** tab (#247): one card per floor plan of the
 * site - a thumbnail of its rack tiles coloured by the picked measure, and
 * how full its racks are - and one for the racks on no floor plan. The
 * figures are the rack page's, added up (`GET /api/sites/{id}/capacity/`).
 */
export function SiteCapacityTab({ siteId }: { siteId: string }) {
  const [metric, setMetric] = useUrlTab<CapacityMetric>(
    "space",
    "measure",
    METRICS
  )
  const q = useQuery({
    queryKey: ["site-capacity", siteId],
    queryFn: () => api<SiteCapacity>(`/api/sites/${siteId}/capacity/`),
  })
  if (q.isLoading) return <Loading />
  if (q.isError) return <QueryError error={q.error} />
  const data = q.data
  if (!data) return null

  const plans = [...data.floor_plans].sort(
    (a, b) => Number(b.racks.length > 0) - Number(a.racks.length > 0)
  )
  const unplaced = data.unplaced
  if (plans.length === 0 && unplaced.racks.length === 0)
    return (
      <EmptyState title="No racks to show.">
        The site's racks stand on floor plans you cannot view.
      </EmptyState>
    )

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <SegmentedTabs<CapacityMetric>
          value={metric}
          onValueChange={setMetric}
          items={METRICS.map((m) => ({ value: m, label: COLOR_BY_LABEL[m] }))}
        />
        <LevelKey />
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {plans.map((plan) => (
          <PlanCard key={plan.id} plan={plan} metric={metric} siteId={siteId} />
        ))}
        {unplaced.racks.length > 0 && (
          <Card size="sm" data-slot="capacity-card">
            <CardHeader>
              <CardTitle>Not on a floor plan</CardTitle>
              <CardDescription>
                <RackNames racks={unplaced.racks} />
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Totals totals={unplaced.totals} siteId={siteId} />
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}

/** The thumbnails' colours, in a line: the tenant's capacity levels and No
 * data. */
function LevelKey() {
  const t = useCapacityThresholds()
  const keys = [
    { color: CAPACITY_HEX.good, label: capacityBandLabel("good", t) },
    { color: CAPACITY_HEX.warn, label: capacityBandLabel("warn", t) },
    { color: CAPACITY_HEX.critical, label: capacityBandLabel("critical", t) },
    { color: CAPACITY_NONE_HEX, label: "No data" },
  ]
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
      {keys.map((k) => (
        <span
          key={k.label}
          className="inline-flex items-center gap-1.5 whitespace-nowrap"
        >
          <span
            aria-hidden
            className="h-3 w-4 rounded-[3px] border"
            style={{ backgroundColor: `${k.color}59`, borderColor: k.color }}
          />
          {k.label}
        </span>
      ))}
    </div>
  )
}

function PlanCard({
  plan,
  metric,
  siteId,
}: {
  plan: SiteCapacityPlan
  metric: CapacityMetric
  siteId: string
}) {
  return (
    <Card size="sm" data-slot="capacity-card">
      <CardHeader>
        <CardTitle>
          <Link to="/floorplans/$id" params={{ id: plan.id }} className="link">
            {plan.name}
          </Link>
        </CardTitle>
        <CardDescription>{plan.location.name}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <Link
          to="/floorplans/$id"
          params={{ id: plan.id }}
          aria-label={`Open ${plan.name}`}
          className="block rounded-md border border-border bg-muted/30 p-2"
        >
          <PlanThumb plan={plan} metric={metric} />
        </Link>
        {plan.racks.length > 0 ? (
          <Totals totals={plan.totals} siteId={siteId} />
        ) : (
          <p className="text-[12px] text-muted-foreground">
            No racks on this plan.
          </p>
        )}
      </CardContent>
    </Card>
  )
}

/** A floor plan in small: its grid and its rack tiles only, each filled
 * with the rack's level on the measure, its front edge drawn. */
export function PlanThumb({
  plan,
  metric,
}: {
  plan: Pick<SiteCapacityPlan, "grid_width" | "grid_height" | "racks" | "tiles">
  metric: CapacityMetric
}) {
  const byId = new Map(plan.racks.map((r) => [r.id, r]))
  const gw = Math.max(1, plan.grid_width)
  const gh = Math.max(1, plan.grid_height)
  // Thin lines in cells, whatever the plan's size.
  const line = Math.max(gw, gh) / 160
  return (
    <svg
      viewBox={`${-line} ${-line} ${gw + line * 2} ${gh + line * 2}`}
      preserveAspectRatio="xMidYMid meet"
      className="h-40 w-full"
      role="img"
      aria-label="Rack tiles"
    >
      <rect
        width={gw}
        height={gh}
        rx={line * 2}
        className="fill-background stroke-border"
        strokeWidth={line}
      />
      {plan.tiles.map((t, i) => {
        const rack = byId.get(t.rack_id)
        const ratio = rack ? metricRatio(siteRackFigures(rack), metric) : null
        const color = capacityColor(ratio)
        const g = Math.min(0.08, t.w / 6, t.h / 6)
        return (
          <g
            key={`${t.rack_id}-${i}`}
            data-rack={t.rack_id}
            data-level={ratio == null ? "none" : capacityLevel(ratio)}
          >
            <rect
              x={t.x + g}
              y={t.y + g}
              width={t.w - g * 2}
              height={t.h - g * 2}
              rx={0.12}
              fill={color}
              fillOpacity={0.55}
              stroke={color}
              strokeWidth={line}
            />
            <FrontEdge t={t} g={g} color={color} />
          </g>
        )
      })}
    </svg>
  )
}

/** A tile's front edge, as the plan marks it: a bar inside the edge its
 * front faces (0 up, 90 right, 180 down, 270 left). */
function FrontEdge({
  t,
  g,
  color,
}: {
  t: SiteCapacityPlan["tiles"][number]
  g: number
  color: string
}) {
  const th = Math.min(0.14, t.w / 5, t.h / 5)
  const x0 = t.x + g
  const y0 = t.y + g
  const w = t.w - g * 2
  const h = t.h - g * 2
  const bar =
    t.orientation === 90
      ? { x: x0 + w - th, y: y0, width: th, height: h }
      : t.orientation === 180
        ? { x: x0, y: y0 + h - th, width: w, height: th }
        : t.orientation === 270
          ? { x: x0, y: y0, width: th, height: h }
          : { x: x0, y: y0, width: w, height: th }
  return <rect {...bar} fill={color} />
}

/** Racks on no floor plan, by name: the first dozen as links. */
function RackNames({ racks }: { racks: readonly SiteCapacityRack[] }) {
  const shown = racks.slice(0, 12)
  return (
    <span className="flex flex-wrap gap-x-2 gap-y-0.5">
      {shown.map((r) => (
        <Link
          key={r.id}
          to="/racks/$id"
          params={{ id: r.id }}
          className="link text-[12px]"
        >
          {r.name}
        </Link>
      ))}
      {racks.length > shown.length && (
        <span className="num text-[12px]">
          +{racks.length - shown.length} more
        </span>
      )}
    </span>
  )
}

/** A card's figures: racks and devices, the units in use, power as demand
 * over supply, and the ports - which open the site's Port utilization. */
function Totals({
  totals,
  siteId,
}: {
  totals: SiteCapacityTotals
  siteId: string
}) {
  const p = totals.power
  const power: RackPower = {
    available_w: p.available_w,
    allocated_w: p.allocated_w,
    maximum_w: p.maximum_w,
    supply: p.available_w > 0 ? "feed" : null,
  }
  // How many racks the supply leans on their PDUs for, or has none for.
  const supplyNote =
    p.available_w > 0
      ? [
          (p.budget ?? 0) > 0 && `Budget: ${p.budget}`,
          p.pdu_rating > 0 && `PDU rating: ${p.pdu_rating}`,
          p.no_supply > 0 && `No supply: ${p.no_supply}`,
        ]
          .filter(Boolean)
          .join(" · ")
      : ""
  const ports = (row: PortCountRow) => (
    <Link
      to="/port-utilization"
      search={{ site: siteId }}
      className="hover:underline"
    >
      <PortsFigure row={row} bar />
    </Link>
  )
  const rows: { label: string; value: React.ReactNode }[] = [
    { label: "Racks", value: <span className="num">{totals.racks}</span> },
    { label: "Devices", value: <span className="num">{totals.devices}</span> },
    {
      label: "Space",
      value: (
        <span className="inline-flex items-center gap-2 whitespace-nowrap">
          <CapacityBar ratio={capacityRatio(totals.u_used, totals.u_height)} />
          <span className="num text-[11px] text-muted-foreground">
            {totals.u_used}/{totals.u_height}U
            {totals.u_pct != null && ` · ${totals.u_pct}%`}
          </span>
        </span>
      ),
    },
    {
      label: "Power",
      value: (
        <span className="grid gap-0.5">
          <PowerFigure power={power} bar />
          {supplyNote && (
            <span className="text-[11px] text-muted-foreground">
              {supplyNote}
            </span>
          )}
        </span>
      ),
    },
    { label: "Ports", value: ports(totals.ports) },
    ...(totals.panel_ports.total > 0
      ? [{ label: "Panel ports", value: ports(totals.panel_ports) }]
      : []),
  ]
  return (
    <dl className="-mx-1.5 grid overflow-hidden rounded-md text-[13px]">
      {rows.map((r, i) => (
        <div
          key={r.label}
          className={cn(
            "grid grid-cols-[6rem_1fr] items-center gap-2 px-1.5 py-1",
            i % 2 === 1 && "bg-muted/30"
          )}
        >
          <dt className="text-[11px] whitespace-nowrap text-muted-foreground">
            {r.label}
          </dt>
          <dd className="min-w-0">{r.value}</dd>
        </div>
      ))}
    </dl>
  )
}
