import {
  LegendFrame,
  LegendPills,
  LegendRow,
  LegendStatuses,
} from "@/components/map-legend"
import type { StatusMini } from "@/lib/api"
import {
  CAPACITY_HEX,
  CAPACITY_NONE_HEX,
  capacityBandLabel,
  capacityLevel,
  useCapacityThresholds,
} from "@/lib/rack-capacity"
import type { CapacityLevel } from "@/lib/rack-capacity"
import { naturalCompare } from "@/lib/natural-sort"

import { COLOR_BY_LABEL, isCapacityMetric, metricRatio } from "./tile-paint"
import type { CapacityMetric, ColorBy, RackFigures } from "./tile-paint"

/** What each measure counts, beside its name in the legend. */
const BASIS: Record<CapacityMetric, string> = {
  space: "units used",
  power: "demand of supply",
  ports: "in use",
  panel_ports: "in use",
}

const LEVELS: (CapacityLevel | "none")[] = ["good", "warn", "critical", "none"]

/** The pill for a rack with no status: the grey its tile is filled with. */
const NO_STATUS: StatusMini = {
  id: "__none__",
  name: "No status",
  color: CAPACITY_NONE_HEX,
  text_color: "",
}

/** How many of the racks fall in each level of a measure. */
export function levelCounts(
  figures: readonly (RackFigures | null)[],
  metric: CapacityMetric
): Record<CapacityLevel | "none", number> {
  const out = { good: 0, warn: 0, critical: 0, none: 0 }
  for (const f of figures) {
    const ratio = f ? metricRatio(f, metric) : null
    out[ratio == null ? "none" : capacityLevel(ratio)]++
  }
  return out
}

/** A tile's fill as a legend swatch: the colour at the tile's strength,
 * outlined in it. */
function FillSwatch({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      className="h-3 w-5 shrink-0 rounded-[3px] border"
      style={{ backgroundColor: `${color}59`, borderColor: color }}
    />
  )
}

/**
 * The key to the plan's Color by (#247): the tenant's capacity levels
 * (80 / 95 % unless changed) with how many
 * racks sit in each, or the roles and statuses as their pills - with what
 * the outline means while a rack is alarming. Drawn inside the export area
 * with no Hide button, so the PNG carries it.
 */
export function ColorByLegend({
  colorBy,
  figures,
  alarm = false,
}: {
  colorBy: ColorBy
  /** One per rack on the plan (null: nothing known about it yet). */
  figures: readonly (RackFigures | null)[]
  /** Some rack's outline is a monitoring alarm. */
  alarm?: boolean
}) {
  const thresholds = useCapacityThresholds()
  if (colorBy === "type") return null
  const outline = alarm && (
    <LegendRow
      className="pt-1"
      swatch={
        <span
          aria-hidden
          className="h-3 w-5 shrink-0 rounded-[3px] border-2"
          style={{ borderColor: CAPACITY_HEX.critical }}
        />
      }
      label={<span className="whitespace-nowrap">Outline: monitoring</span>}
    />
  )

  if (isCapacityMetric(colorBy)) {
    const counts = levelCounts(figures, colorBy)
    return (
      <LegendFrame hideable={false} className="w-48">
        <p className="pb-1 whitespace-nowrap text-muted-foreground">
          <span className="font-medium text-foreground">
            {COLOR_BY_LABEL[colorBy]}
          </span>{" "}
          · {BASIS[colorBy]}
        </p>
        <div className="space-y-0.5">
          {LEVELS.map((level) => (
            <LegendRow
              key={level}
              swatch={
                <FillSwatch
                  color={
                    level === "none" ? CAPACITY_NONE_HEX : CAPACITY_HEX[level]
                  }
                />
              }
              label={
                <span
                  data-level={level}
                  className="flex w-28 items-baseline justify-between gap-2 whitespace-nowrap"
                >
                  {level === "none"
                    ? "No data"
                    : capacityBandLabel(level, thresholds)}
                  <span className="num text-muted-foreground">
                    {counts[level]}
                  </span>
                </span>
              }
            />
          ))}
        </div>
        {outline}
      </LegendFrame>
    )
  }

  // Rack role / Status: the catalog's own colours, as their pills - and
  // the grey a rack without one is filled with.
  const missing = figures.some((f) =>
    colorBy === "role" ? !f?.role : !f?.status
  )
  let pills: React.ReactNode
  if (colorBy === "role") {
    const roles = new Map<string, { name: string; color: string }>()
    for (const f of figures) if (f?.role) roles.set(f.role.name, f.role)
    const items = [...roles.values()].sort((a, b) =>
      naturalCompare(a.name, b.name)
    )
    if (missing) items.push({ name: "No role", color: CAPACITY_NONE_HEX })
    pills = <LegendPills className="pb-0" items={items} />
  } else {
    const statuses = new Map<string, StatusMini>()
    for (const f of figures) if (f?.status) statuses.set(f.status.id, f.status)
    const items = [...statuses.values()].sort((a, b) =>
      naturalCompare(a.name, b.name)
    )
    if (missing) items.push(NO_STATUS)
    pills = <LegendStatuses className="pb-0" statuses={items} />
  }
  return (
    <LegendFrame hideable={false} className="w-fit max-w-64">
      <p className="pb-1 font-medium whitespace-nowrap">
        {COLOR_BY_LABEL[colorBy]}
      </p>
      {pills}
      {outline}
    </LegendFrame>
  )
}
