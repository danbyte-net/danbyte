// A plan made from the Site map keeps the box of the map its grid spans
// (`plan.geo`, api/floor_plan_geo.py): linear in Web Mercator across the
// grid, like the background image stretched over it. Expand grows that box
// in whole cells that keep their size in Mercator units, so nothing already
// drawn is resampled; the server does the same sums and decides.

import type { FloorPlan, FloorPlanGeo } from "@/lib/api"
import {
  latOf,
  lngOf,
  MAX_GRID,
  mercX,
  mercY,
} from "@/components/site-map/plan-from-map"
import type { Bbox } from "@/components/site-map/plan-from-map"

/** Whole cells added on each side. */
export interface Sides {
  north: number
  east: number
  south: number
  west: number
}

export const NO_GROWTH: Sides = { north: 0, east: 0, south: 0, west: 0 }

/** Slack, in cells, when a box is turned into whole cells. */
const SLACK = 0.01

/** A plan that keeps a tie to the Site map. */
export type AnchoredPlan = Pick<
  FloorPlan,
  "grid_width" | "grid_height" | "cell_mm"
> & { geo: FloorPlanGeo }

export const bboxOf = (g: Pick<FloorPlanGeo, "bbox">): Bbox => ({
  south: g.bbox[0],
  west: g.bbox[1],
  north: g.bbox[2],
  east: g.bbox[3],
})

/** One cell's size in Mercator units, across and down. */
function cellUnits(plan: AnchoredPlan) {
  const b = bboxOf(plan.geo)
  return {
    b,
    cx: (mercX(b.east) - mercX(b.west)) / plan.grid_width,
    cy: (mercY(b.south) - mercY(b.north)) / plan.grid_height,
  }
}

/** The plan's box grown by whole cells on each side. */
export function grownBbox(plan: AnchoredPlan, s: Sides): Bbox {
  const { b, cx, cy } = cellUnits(plan)
  return {
    north: latOf(mercY(b.north) - s.north * cy),
    south: latOf(mercY(b.south) + s.south * cy),
    west: lngOf(mercX(b.west) - s.west * cx),
    east: lngOf(mercX(b.east) + s.east * cx),
  }
}

/** The whole cells a box adds on each side of the plan's (never less than
 * none: Expand only grows). */
export function sidesOf(plan: AnchoredPlan, target: Bbox): Sides {
  const { b, cx, cy } = cellUnits(plan)
  const whole = (v: number) => Math.max(0, Math.ceil(v - SLACK))
  return {
    north: whole((mercY(b.north) - mercY(target.north)) / cy),
    south: whole((mercY(target.south) - mercY(b.south)) / cy),
    west: whole((mercX(b.west) - mercX(target.west)) / cx),
    east: whole((mercX(target.east) - mercX(b.east)) / cx),
  }
}

/** Where a dragged side handle leaves that side, in whole cells out. */
export function sideFromDrag(
  plan: AnchoredPlan,
  side: keyof Sides,
  at: { lat: number; lng: number }
): number {
  const b = bboxOf(plan.geo)
  const target: Bbox = { ...b }
  if (side === "north" || side === "south") target[side] = at.lat
  else target[side] = at.lng
  return sidesOf(plan, target)[side]
}

/** Metres asked for on a side, as whole cells (rounded up). */
export function cellsFromMetres(plan: Pick<FloorPlan, "cell_mm">, m: number) {
  if (!Number.isFinite(m) || m <= 0) return 0
  return Math.max(0, Math.ceil((m * 1000) / plan.cell_mm - SLACK))
}

export interface ExpandFrame {
  sides: Sides
  bbox: Bbox
  gridWidth: number
  gridHeight: number
  widthM: number
  heightM: number
  /** Nothing to grow, or more than a plan holds. */
  error?: string
}

/** The plan grown by `s`: its box, its grid and why it can't be, if so. */
export function expandFrame(plan: AnchoredPlan, s: Sides): ExpandFrame {
  const gridWidth = plan.grid_width + s.west + s.east
  const gridHeight = plan.grid_height + s.north + s.south
  const cell = plan.cell_mm / 1000
  const out: ExpandFrame = {
    sides: s,
    bbox: grownBbox(plan, s),
    gridWidth,
    gridHeight,
    widthM: gridWidth * cell,
    heightM: gridHeight * cell,
  }
  if (!(s.north || s.east || s.south || s.west))
    out.error = "Move an edge out to grow the plan."
  else if (gridWidth > MAX_GRID || gridHeight > MAX_GRID)
    out.error =
      `That makes the plan ${gridWidth} × ${gridHeight} cells; a plan has at most ${MAX_GRID} a side, ` +
      `${(MAX_GRID * plan.cell_mm) / 1000} m at ${cell} m a cell. Expand less, or make a new plan from the Site map with larger cells.`
  return out
}

/** The most cells a side can still grow by, the opposite side as it is. */
export function roomOn(plan: AnchoredPlan, s: Sides, side: keyof Sides) {
  const across = side === "west" || side === "east"
  const used = across
    ? plan.grid_width + s.west + s.east - s[side]
    : plan.grid_height + s.north + s.south - s[side]
  return Math.max(0, MAX_GRID - used)
}
