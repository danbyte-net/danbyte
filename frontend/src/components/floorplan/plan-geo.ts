// A plan made from the Site map keeps the box of the map its grid spans
// (`plan.geo`, api/floor_plan_geo.py): linear in Web Mercator across the
// grid, like the background image stretched over it. Expand grows that box
// in whole cells that keep their size in Mercator units, so nothing already
// drawn is resampled; the server does the same sums and decides.

import type { FloorPlan, FloorPlanGeo } from "@/lib/api"
import {
  EARTH_CIRCUMFERENCE_M,
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

/** The box a grid of `widthM` × `heightM` metres covers with its centre at
 * `center` - how a plan with no geo anchor is framed on the map, at true
 * scale (the server checks the box against the grid's size). */
export function frameAt(
  center: { lat: number; lng: number },
  widthM: number,
  heightM: number
): Bbox {
  const per = EARTH_CIRCUMFERENCE_M * Math.cos((center.lat * Math.PI) / 180)
  const dx = widthM / per
  const dy = heightM / per
  const x0 = mercX(center.lng) - dx / 2
  const y0 = mercY(center.lat) - dy / 2
  return {
    west: lngOf(x0),
    east: lngOf(x0 + dx),
    north: latOf(y0),
    south: latOf(y0 + dy),
  }
}

/** The most cells a side can still grow by, the opposite side as it is. */
export function roomOn(plan: AnchoredPlan, s: Sides, side: keyof Sides) {
  const across = side === "west" || side === "east"
  const used = across
    ? plan.grid_width + s.west + s.east - s[side]
    : plan.grid_height + s.north + s.south - s[side]
  return Math.max(0, MAX_GRID - used)
}

// ── a frame in whole cells ──────────────────────────────────────────────────
// The frame both Expand and From site map draw: a dashed box inside a frame
// of whole cells. Corner and edge handles resize the frame; it never gets
// smaller than the dashed box. In Expand the dashed box is the grid as it
// is; in From site map it is what is drawn on the plan (its levels too), so
// the frame may shrink to it, and the frame goes anywhere on the map.

/** A frame on the map in whole cells, with the grid as it is inside it. */
export interface CellFrame {
  /** The frame's north-west corner, Mercator units. */
  x: number
  y: number
  /** One cell, Mercator units across and down. */
  cx: number
  cy: number
  /** The frame's size, cells. */
  w: number
  h: number
  /** The dashed box: its place in the frame and its size, cells. */
  ix: number
  iy: number
  iw: number
  ih: number
  /** Where the dashed box is on the plan's grid now, cells (none: at its
   * corner). Everything on the plan moves by `ix - ex`, `iy - ey`. */
  ex?: number
  ey?: number
  /** A cell in metres, when the frame is placed by hand (no anchor): its
   * Mercator size is worked out again where it is moved to. */
  cellM?: number
}

export type FrameHandle = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw"

export const FRAME_HANDLES: FrameHandle[] = [
  "n",
  "ne",
  "e",
  "se",
  "s",
  "sw",
  "w",
  "nw",
]

const unitsAt = (lat: number, cellM: number) =>
  cellM / (EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180))

/** A frame of the grid's own size, centred on `center` - a plan with no
 * geo anchor, at true scale (the server checks the box's size). */
export function frameAround(
  center: { lat: number; lng: number },
  gridWidth: number,
  gridHeight: number,
  cellMm: number
): CellFrame {
  const cellM = cellMm / 1000
  const c = unitsAt(center.lat, cellM)
  return {
    x: mercX(center.lng) - (gridWidth * c) / 2,
    y: mercY(center.lat) - (gridHeight * c) / 2,
    cx: c,
    cy: c,
    w: gridWidth,
    h: gridHeight,
    ix: 0,
    iy: 0,
    iw: gridWidth,
    ih: gridHeight,
    cellM,
  }
}

/** What is drawn on a plan (and the levels that go with it), in whole
 * cells: the read's `frame_extent`. */
export interface Extent {
  x: number
  y: number
  w: number
  h: number
}

/**
 * The frame From site map opens with: the grid's own size at true scale -
 * on a plan tied to the map from its box's north-west corner, else centred
 * on `center` - with `extent` (what is drawn on it; null for an empty
 * plan, undefined for the whole grid) as the dashed box, where it is.
 */
export function snapshotFrame(
  plan: Pick<FloorPlan, "grid_width" | "grid_height" | "cell_mm"> & {
    geo?: Pick<FloorPlanGeo, "bbox"> | null
  },
  center: { lat: number; lng: number },
  extent: Extent | null | undefined
): CellFrame {
  const base = frameAround(
    center,
    plan.grid_width,
    plan.grid_height,
    plan.cell_mm
  )
  if (plan.geo) {
    const b = bboxOf(plan.geo)
    // The cells at their real size from the box's corner: an anchor gone
    // stale (a grid resized before it followed) is put right here.
    const c = unitsAt((b.north + b.south) / 2, plan.cell_mm / 1000)
    base.x = mercX(b.west)
    base.y = mercY(b.north)
    base.cx = base.cy = c
  }
  const e =
    extent === undefined
      ? { x: 0, y: 0, w: plan.grid_width, h: plan.grid_height }
      : (extent ?? { x: 0, y: 0, w: 0, h: 0 })
  return { ...base, ix: e.x, iy: e.y, iw: e.w, ih: e.h, ex: e.x, ey: e.y }
}

/** The cells everything on the plan moves by in frame `f`. */
export const frameOffset = (f: CellFrame): [number, number] => [
  f.ix - (f.ex ?? 0),
  f.iy - (f.ey ?? 0),
]

/** An anchored plan's box grown by `s`, as a frame. */
export function frameOfPlan(
  plan: AnchoredPlan,
  s: Sides = NO_GROWTH
): CellFrame {
  const { b, cx, cy } = cellUnits(plan)
  return {
    x: mercX(b.west) - s.west * cx,
    y: mercY(b.north) - s.north * cy,
    cx,
    cy,
    w: plan.grid_width + s.west + s.east,
    h: plan.grid_height + s.north + s.south,
    ix: s.west,
    iy: s.north,
    iw: plan.grid_width,
    ih: plan.grid_height,
  }
}

/** The cells the frame adds on each side of the grid. */
export function sidesOfFrame(f: CellFrame): Sides {
  return {
    west: f.ix,
    north: f.iy,
    east: f.w - f.iw - f.ix,
    south: f.h - f.ih - f.iy,
  }
}

const boxOf = (x: number, y: number, w: number, h: number): Bbox => ({
  west: lngOf(x),
  east: lngOf(x + w),
  north: latOf(y),
  south: latOf(y + h),
})

/** The frame's box. */
export const frameBbox = (f: CellFrame): Bbox =>
  boxOf(f.x, f.y, f.w * f.cx, f.h * f.cy)

/** The box of the grid as it is, inside the frame. */
export const innerBbox = (f: CellFrame): Bbox =>
  boxOf(f.x + f.ix * f.cx, f.y + f.iy * f.cy, f.iw * f.cx, f.ih * f.cy)

/** Where a handle sits on the map: a corner, or the middle of an edge. */
export function handleAt(f: CellFrame, h: FrameHandle) {
  const b = frameBbox(f)
  const lat = h.includes("n")
    ? b.north
    : h.includes("s")
      ? b.south
      : latOf(f.y + (f.h * f.cy) / 2)
  const lng = h.includes("w")
    ? b.west
    : h.includes("e")
      ? b.east
      : lngOf(f.x + (f.w * f.cx) / 2)
  return { lat, lng }
}

/** `f` with handle `h` dragged to `at`: its sides on whole cells, never
 * inside the dashed box and never under one cell. */
export function resizeFrame(
  f: CellFrame,
  h: FrameHandle,
  at: { lat: number; lng: number }
): CellFrame {
  const px = mercX(at.lng)
  const py = mercY(at.lat)
  const out = { ...f }
  if (h.includes("w")) {
    const k = Math.min(f.ix, f.w - 1, Math.round((px - f.x) / f.cx))
    out.x = f.x + k * f.cx
    out.w = f.w - k
    out.ix = f.ix - k
  } else if (h.includes("e")) {
    out.w = Math.max(f.ix + f.iw, 1, Math.round((px - f.x) / f.cx))
  }
  if (h.includes("n")) {
    const k = Math.min(f.iy, f.h - 1, Math.round((py - f.y) / f.cy))
    out.y = f.y + k * f.cy
    out.h = f.h - k
    out.iy = f.iy - k
  } else if (h.includes("s")) {
    out.h = Math.max(f.iy + f.ih, 1, Math.round((py - f.y) / f.cy))
  }
  return out
}

/** `f` moved by (dx, dy) Mercator units, the grid with it. */
export function moveFrame(f: CellFrame, dx: number, dy: number): CellFrame {
  const out = { ...f, x: f.x + dx, y: f.y + dy }
  if (f.cellM) {
    // Its cells keep their real size where it now is.
    const mx = out.x + (f.w * f.cx) / 2
    const my = out.y + (f.h * f.cy) / 2
    const c = unitsAt(latOf(my), f.cellM)
    out.cx = out.cy = c
    out.x = mx - (f.w * c) / 2
    out.y = my - (f.h * c) / 2
  }
  return out
}

/** The grid moved inside `f` by (dx, dy) Mercator units, in whole cells,
 * kept inside the frame. */
export function moveInner(f: CellFrame, dx: number, dy: number): CellFrame {
  const clamp = (v: number, hi: number) => Math.max(0, Math.min(hi, v))
  return {
    ...f,
    ix: clamp(f.ix + Math.round(dx / f.cx), f.w - f.iw),
    iy: clamp(f.iy + Math.round(dy / f.cy), f.h - f.ih),
  }
}

/** The grid in the middle of the frame (to the cell, rounded down). */
export const centreInner = (f: CellFrame): CellFrame => ({
  ...f,
  ix: Math.floor((f.w - f.iw) / 2),
  iy: Math.floor((f.h - f.ih) / 2),
})

/** Why the frame can't be captured, if so. */
export function frameError(f: CellFrame): string | undefined {
  if (f.w > MAX_GRID || f.h > MAX_GRID)
    return `At most ${MAX_GRID} cells a side`
  return undefined
}

/**
 * The frame Edit area opens with: the plan's own box in its own cells (so
 * the frame's edges stay on the plan's cell lines and everything placed
 * keeps its place on the map), with `extent` - what is drawn on it and the
 * levels that go with it - as the dashed box it may shrink to. An empty
 * plan's dashed box is a point in the middle, so any side can come in.
 */
export function areaFrame(
  plan: AnchoredPlan,
  extent: Extent | null | undefined
): CellFrame {
  const f = frameOfPlan(plan)
  const e =
    extent === undefined
      ? { x: 0, y: 0, w: plan.grid_width, h: plan.grid_height }
      : (extent ?? {
          x: Math.floor(plan.grid_width / 2),
          y: Math.floor(plan.grid_height / 2),
          w: 0,
          h: 0,
        })
  return { ...f, ix: e.x, iy: e.y, iw: e.w, ih: e.h, ex: e.x, ey: e.y }
}

/** "N +1 · W +2 · E −3": the cells frame `f` adds (or trims) on each side
 * of a `gridWidth` × `gridHeight` grid; "" when none. */
export function sidesReadout(
  f: CellFrame,
  gridWidth: number,
  gridHeight: number
): string {
  const [ox, oy] = frameOffset(f)
  const sides: [string, number][] = [
    ["N", oy],
    ["E", f.w - gridWidth - ox],
    ["S", f.h - gridHeight - oy],
    ["W", ox],
  ]
  return sides
    .filter(([, n]) => n !== 0)
    .map(([s, n]) => `${s} ${n > 0 ? "+" : "−"}${Math.abs(n)}`)
    .join(" · ")
}
