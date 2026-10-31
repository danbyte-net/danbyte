import { DynamicIcon } from "@/components/dynamic-icon"
import { LegendFrame, LegendRow } from "@/components/map-legend"
import type { AreaTypeRef } from "@/lib/api"
import { naturalCompare } from "@/lib/natural-sort"

import { AREA_NEUTRAL, PATTERN_STROKE, areaTypeOf, patternRuns } from "./shapes"
import type { PlanShape } from "./shapes"

/** The area types the plan's plain areas wear, by name - each once. */
export function areaTypesInUse(shapes: readonly PlanShape[]): AreaTypeRef[] {
  const seen = new Map<string, AreaTypeRef>()
  for (const s of shapes) {
    if (s.kind !== "area") continue
    const t = areaTypeOf(s)
    if (t) seen.set(t.id, t)
  }
  return [...seen.values()].sort((a, b) => naturalCompare(a.name, b.name))
}

/** The legend as data, for the PDF's sheet (api/floor_plan_pdf.py's
 * `area_legend`): a swatch of each type's colour and pattern. Null when no
 * area on the plan has a type. */
export function areaLegendEntries(shapes: readonly PlanShape[]): {
  title: string
  items: { label: string; color: string; pattern: AreaTypeRef["pattern"] }[]
} | null {
  const types = areaTypesInUse(shapes)
  if (!types.length) return null
  return {
    title: "Areas",
    items: types.map((t) => ({
      label: t.name,
      color: t.color || AREA_NEUTRAL,
      pattern: t.pattern,
    })),
  }
}

/** An area type as a legend swatch: its tint, its pattern over it and its
 * outline - as the plan draws its areas. */
export function AreaSwatch({ type }: { type: AreaTypeRef }) {
  const color = type.color || AREA_NEUTRAL
  const runs = patternRuns(type.pattern, 0, 0, 20, 12, { gap: 4 })
  return (
    <svg
      aria-hidden
      width={20}
      height={12}
      viewBox="0 0 20 12"
      className="shrink-0"
      data-pattern={type.pattern}
    >
      <rect
        x={0.5}
        y={0.5}
        width={19}
        height={11}
        rx={2}
        fill={color}
        fillOpacity={0.35}
        stroke={color}
      />
      <g
        stroke={color}
        strokeOpacity={PATTERN_STROKE.opacity + 0.2}
        strokeWidth={1}
      >
        {runs.map((run, r) => (
          <g key={r} strokeDasharray={run.dash}>
            {/* The swatch's own box clips the lines. */}
            {run.lines.map(([x1, y1, x2, y2], i) => (
              <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} />
            ))}
          </g>
        ))}
      </g>
    </svg>
  )
}

/**
 * The key to the plan's area types (parking, fence…): each type a plain
 * area on the plan wears, as its swatch, icon and name. Beside the Color by
 * and cables' legends, inside the export area.
 */
export function AreaLegend({ types }: { types: readonly AreaTypeRef[] }) {
  if (!types.length) return null
  return (
    <LegendFrame hideable={false} className="w-fit max-w-64">
      <p className="pb-1 font-medium whitespace-nowrap">Areas</p>
      <div className="space-y-0.5">
        {types.map((t) => (
          <LegendRow
            key={t.id}
            swatch={<AreaSwatch type={t} />}
            label={
              <span
                data-area-type={t.id}
                className="flex items-center gap-1.5 whitespace-nowrap"
              >
                {t.icon && (
                  <DynamicIcon
                    name={t.icon}
                    className="h-3 w-3 text-muted-foreground"
                  />
                )}
                {t.name}
              </span>
            }
          />
        ))}
      </div>
    </LegendFrame>
  )
}
