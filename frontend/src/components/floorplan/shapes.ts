import type {
  FloorPlanArea,
  FloorPlanLabel,
  FloorPlanLabelColor,
  FloorPlanTile,
} from "@/lib/api"
import { readableText } from "@/lib/color"

// Areas (rooms, locations, plain areas) and labels drawn on a floor - their
// geometry, in cell units: boxes that turn about their centre, polygons,
// the eight resize handles and the rotate handle, snapping, and the free
// placement of tiles. Pure functions, shared by the canvas, the export and
// the tests.

/** An area or a label in the editor's draft. */
export type PlanShape =
  ({ kind: "area" } & FloorPlanArea) | ({ kind: "label" } & FloorPlanLabel)
export type AreaShape = Extract<PlanShape, { kind: "area" }>
export type LabelShape = Extract<PlanShape, { kind: "label" }>

/** A rectangle that turns about its centre, in cell units. */
export interface Box {
  x: number
  y: number
  width: number
  height: number
  /** Degrees, clockwise. */
  rotation: number
}

export type Pt = [number, number]

/** The resize handles: the corners and the middles of the sides. */
export const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const
export type Handle = (typeof HANDLES)[number]

/** An area with nothing linked and no colour of its own. */
export const AREA_NEUTRAL = "#71717a"
/** The smallest box a resize leaves, in cells. */
export const MIN_SIZE = 0.25

const round3 = (v: number) => Math.round(v * 1000) / 1000

/** An angle in [0, 360). */
export function normAngle(deg: number): number {
  const a = deg % 360
  return a < 0 ? a + 360 : a
}

/** The saved areas and labels as the editor's draft keeps them. */
export function shapesOf(
  areas: FloorPlanArea[] | undefined,
  labels: FloorPlanLabel[] | undefined
): PlanShape[] {
  return [
    ...(areas ?? []).map((a) => ({ ...a, kind: "area" as const })),
    ...(labels ?? []).map((l) => ({ ...l, kind: "label" as const })),
  ]
}

// ── Areas ─────────────────────────────────────────────────────────────────

/** An area's colour: its room's, else its location's, else its own, else
 * neutral - from the linked object's data, never from a name. */
export function areaColor(
  a: Pick<FloorPlanArea, "room" | "location" | "color">
): string {
  return a.room?.color || a.location?.color || a.color || AREA_NEUTRAL
}

/** The ink for an area's name: its own colour over a light fill, or black
 * or white - whichever reads - once the fill is strong enough to swallow it. */
export function areaLabelColor(
  a: Pick<FloorPlanArea, "room" | "location" | "color" | "fill_opacity">
): string {
  const color = areaColor(a)
  return a.fill_opacity >= 50 && /^#[0-9a-f]{6}$/i.test(color)
    ? readableText(color)
    : color
}

/** What an area is called on the plan: its own label, else its room's or
 * location's name. */
export function areaName(
  a: Pick<FloorPlanArea, "label" | "room" | "location">
): string {
  return a.label || a.room?.name || a.location?.name || ""
}

// ── Labels ────────────────────────────────────────────────────────────────

/** The label size presets, as a share of the plan's cell: on a 600 mm grid
 * S, M, L and XL are 150, 300, 450 and 750 mm tall. */
export const LABEL_SIZES = [
  { key: "S", share: 0.25 },
  { key: "M", share: 0.5 },
  { key: "L", share: 0.75 },
  { key: "XL", share: 1.25 },
] as const
export type LabelSizeKey = (typeof LABEL_SIZES)[number]["key"]

/** The text height a preset gives on a plan with cells `cellMm` wide. */
export function labelPresetMm(key: LabelSizeKey, cellMm: number): number {
  const p = LABEL_SIZES.find((s) => s.key === key)!
  return Math.max(20, Math.round(cellMm * p.share))
}

/** The preset a text height matches, if any. */
export function labelPresetOf(
  fontMm: number,
  cellMm: number
): LabelSizeKey | null {
  return (
    LABEL_SIZES.find((s) => labelPresetMm(s.key, cellMm) === fontMm)?.key ??
    null
  )
}

/** The label's text height in cells. */
export function labelFontCells(fontMm: number, cellMm: number): number {
  return fontMm / Math.max(1, cellMm)
}

/** ~Average glyph width of the plan's sans, per em. */
const GLYPH_EM = 0.58
const LINE_EM = 1.25
const PAD_EM = 0.3

/** The box a label takes: its own size, or sized to its text. */
export function labelBox(
  l: Pick<
    FloorPlanLabel,
    "text" | "x" | "y" | "width" | "height" | "rotation" | "font_mm"
  >,
  cellMm: number
): Box {
  const f = labelFontCells(l.font_mm, cellMm)
  const lines = (l.text || " ").split("\n")
  const longest = Math.max(1, ...lines.map((s) => s.length))
  return {
    x: l.x,
    y: l.y,
    width: l.width ?? longest * GLYPH_EM * f + PAD_EM * 2 * f,
    height: l.height ?? lines.length * LINE_EM * f + PAD_EM * f,
    rotation: l.rotation,
  }
}

/** The palette a label's colour token names: for the screen (a class
 * following the theme) and for paper (a fixed ink). */
export const LABEL_COLORS: Record<
  FloorPlanLabelColor,
  { name: string; className: string; paper: string }
> = {
  "": { name: "Ink", className: "fill-foreground", paper: "#18181b" },
  muted: {
    name: "Muted",
    className: "fill-muted-foreground",
    paper: "#71717a",
  },
  red: {
    name: "Red",
    className: "fill-red-600 dark:fill-red-400",
    paper: "#dc2626",
  },
  amber: {
    name: "Amber",
    className: "fill-amber-600 dark:fill-amber-400",
    paper: "#d97706",
  },
  green: {
    name: "Green",
    className: "fill-green-600 dark:fill-green-400",
    paper: "#16a34a",
  },
  blue: {
    name: "Blue",
    className: "fill-blue-600 dark:fill-blue-400",
    paper: "#2563eb",
  },
  violet: {
    name: "Violet",
    className: "fill-violet-600 dark:fill-violet-400",
    paper: "#7c3aed",
  },
}

/** A label's colour, ink for a token this build does not know. */
export function labelColor(token: string): (typeof LABEL_COLORS)[""] {
  return token in LABEL_COLORS
    ? LABEL_COLORS[token as FloorPlanLabelColor]
    : LABEL_COLORS[""]
}

// ── Boxes ─────────────────────────────────────────────────────────────────

export function boxCenter(b: Box): Pt {
  return [b.x + b.width / 2, b.y + b.height / 2]
}

/** `p` turned `deg` degrees clockwise about `c` (y points down). */
export function rotatePoint(p: Pt, c: Pt, deg: number): Pt {
  if (!deg) return p
  const r = (deg * Math.PI) / 180
  const cos = Math.cos(r)
  const sin = Math.sin(r)
  const dx = p[0] - c[0]
  const dy = p[1] - c[1]
  return [c[0] + dx * cos - dy * sin, c[1] + dx * sin + dy * cos]
}

/** The box's four corners on the plan, clockwise from its top left. */
export function boxCorners(b: Box): Pt[] {
  const c = boxCenter(b)
  return (
    [
      [b.x, b.y],
      [b.x + b.width, b.y],
      [b.x + b.width, b.y + b.height],
      [b.x, b.y + b.height],
    ] as Pt[]
  ).map((p) => rotatePoint(p, c, b.rotation))
}

export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export function pointsBounds(pts: readonly Pt[]): Bounds {
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  }
}

/** The upright rectangle round a turned box. */
export function boxBounds(b: Box): Bounds {
  return pointsBounds(boxCorners(b))
}

/** Whether `p` lies in the turned box. */
export function pointInBox(p: Pt, b: Box): boolean {
  const [lx, ly] = rotatePoint(p, boxCenter(b), -b.rotation)
  return lx >= b.x && lx <= b.x + b.width && ly >= b.y && ly <= b.y + b.height
}

/** Even-odd point-in-polygon. */
export function pointInPolygon(p: Pt, pts: readonly Pt[]): boolean {
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]
    const [xj, yj] = pts[j]
    if (yi > p[1] !== yj > p[1]) {
      const x = ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi
      if (p[0] < x) inside = !inside
    }
  }
  return inside
}

function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const cross = (o: Pt, p: Pt, q: Pt) =>
    (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0])
  const d1 = cross(c, d, a)
  const d2 = cross(c, d, b)
  const d3 = cross(a, b, c)
  const d4 = cross(a, b, d)
  return d1 * d2 < 0 && d3 * d4 < 0
}

/** Whether a closed outline crosses itself (the server refuses those). */
export function polygonCrossesItself(pts: readonly Pt[]): boolean {
  const n = pts.length
  for (let i = 0; i < n; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % n]
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(i - j) <= 1 || (i === 0 && j === n - 1)) continue
      if (segmentsCross(a, b, pts[j], pts[(j + 1) % n])) return true
    }
  }
  return false
}

/** The point at the middle of a polygon's area (its name sits there). */
export function polygonCentroid(pts: readonly Pt[]): Pt {
  let a = 0
  let cx = 0
  let cy = 0
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const f = pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1]
    a += f
    cx += (pts[j][0] + pts[i][0]) * f
    cy += (pts[j][1] + pts[i][1]) * f
  }
  if (Math.abs(a) < 1e-9) {
    const b = pointsBounds(pts)
    return [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2]
  }
  return [cx / (3 * a), cy / (3 * a)]
}

/** A handle's place on the box: -1, 0 or 1 along each of its axes. */
export function handleSigns(h: Handle): [number, number] {
  return [
    h.includes("w") ? -1 : h.includes("e") ? 1 : 0,
    h.includes("n") ? -1 : h.includes("s") ? 1 : 0,
  ]
}

/** Where a handle sits on the plan. */
export function handlePoint(b: Box, h: Handle): Pt {
  const [sx, sy] = handleSigns(h)
  const c = boxCenter(b)
  return rotatePoint(
    [c[0] + (sx * b.width) / 2, c[1] + (sy * b.height) / 2],
    c,
    b.rotation
  )
}

/** The rotate handle: above the middle of the top edge, `gap` cells out. */
export function rotateHandlePoint(b: Box, gap: number): Pt {
  const c = boxCenter(b)
  return rotatePoint([c[0], b.y - gap], c, b.rotation)
}

/**
 * The box after dragging handle `h` to `p`: the opposite side or corner
 * stays where it is, in the box's own turned frame. `keepAspect` keeps the
 * width to height ratio (a corner handle).
 */
export function resizeBox(
  b: Box,
  h: Handle,
  p: Pt,
  opts: { keepAspect?: boolean; min?: number } = {}
): Box {
  const min = opts.min ?? MIN_SIZE
  const [sx, sy] = handleSigns(h)
  const c = boxCenter(b)
  // The pointer in the box's frame, about its centre.
  const [lx, ly] = rotatePoint(p, c, -b.rotation)
  const px = lx - c[0]
  const py = ly - c[1]
  // The fixed side or corner, in the same frame.
  const ax = (-sx * b.width) / 2
  const ay = (-sy * b.height) / 2
  let w = sx ? Math.max(min, sx * (px - ax)) : b.width
  let hgt = sy ? Math.max(min, sy * (py - ay)) : b.height
  if (opts.keepAspect && sx && sy && b.width > 0 && b.height > 0) {
    const k = Math.max(w / b.width, hgt / b.height)
    w = Math.max(min, b.width * k)
    hgt = Math.max(min, b.height * k)
  }
  // The new centre, in the frame, then back on the plan.
  const ncx = sx ? ax + (sx * w) / 2 : 0
  const ncy = sy ? ay + (sy * hgt) / 2 : 0
  const [wx, wy] = rotatePoint([c[0] + ncx, c[1] + ncy], c, b.rotation)
  return {
    x: round3(wx - w / 2),
    y: round3(wy - hgt / 2),
    width: round3(w),
    height: round3(hgt),
    rotation: b.rotation,
  }
}

/**
 * The angle the rotate handle gives with the pointer at `p`: the handle
 * points from the centre to the pointer. `step` rounds it (Shift: 15°);
 * otherwise it settles on a quarter turn within `magnet` degrees.
 */
export function rotateAngle(
  b: Box,
  p: Pt,
  opts: { step?: number; magnet?: number } = {}
): number {
  const [cx, cy] = boxCenter(b)
  let a = normAngle((Math.atan2(p[1] - cy, p[0] - cx) * 180) / Math.PI + 90)
  if (opts.step) a = Math.round(a / opts.step) * opts.step
  else {
    const q = Math.round(a / 90) * 90
    if (Math.abs(a - q) <= (opts.magnet ?? 4)) a = q
  }
  return normAngle(Math.round(a * 10) / 10)
}

// ── Snapping ──────────────────────────────────────────────────────────────

/** Lines a moving edge may settle on: x positions and y positions. */
export interface SnapLines {
  xs: number[]
  ys: number[]
}

/** The lines other things on the plan offer: their edges and middles. */
export function snapLinesOf(bounds: readonly Bounds[]): SnapLines {
  const xs: number[] = []
  const ys: number[] = []
  for (const b of bounds) {
    xs.push(b.minX, (b.minX + b.maxX) / 2, b.maxX)
    ys.push(b.minY, (b.minY + b.maxY) / 2, b.maxY)
  }
  return { xs, ys }
}

/** The nearest grid line to `v` with lines every `step`. */
const gridLine = (v: number, step: number) => Math.round(v / step) * step

export interface SnapResult {
  /** How far to shift. */
  dx: number
  dy: number
  /** The lines it settled on, for guides (null: none). */
  gx: number | null
  gy: number | null
}

/**
 * Snap a moving rectangle: whichever of its left, middle and right (top,
 * middle, bottom) is nearest a grid line or another shape's line within
 * `threshold` moves onto it. `hardStep` (a grid plan's half cell) always
 * settles the top left on that lattice instead of the grid lines.
 */
export function snapBounds(
  b: Bounds,
  lines: SnapLines,
  opts: { step: number; threshold: number; hardStep?: number }
): SnapResult {
  const out: SnapResult = { dx: 0, dy: 0, gx: null, gy: null }
  const axis = (
    lo: number,
    hi: number,
    others: number[]
  ): [number, number | null] => {
    if (opts.hardStep) {
      const d = gridLine(lo, opts.hardStep) - lo
      // A shape's line within reach still wins over the lattice.
      let best: [number, number | null] = [d, null]
      let bestAbs = opts.threshold
      for (const edge of [lo, (lo + hi) / 2, hi])
        for (const o of others) {
          const dd = o - edge
          if (Math.abs(dd) < bestAbs) {
            bestAbs = Math.abs(dd)
            best = [dd, o]
          }
        }
      return best
    }
    let best: [number, number | null] = [0, null]
    let bestAbs = opts.threshold
    for (const edge of [lo, (lo + hi) / 2, hi]) {
      const candidates = [gridLine(edge, opts.step), ...others]
      for (const o of candidates) {
        const dd = o - edge
        if (Math.abs(dd) < bestAbs) {
          bestAbs = Math.abs(dd)
          best = [dd, o]
        }
      }
    }
    return best
  }
  ;[out.dx, out.gx] = axis(b.minX, b.maxX, lines.xs)
  ;[out.dy, out.gy] = axis(b.minY, b.maxY, lines.ys)
  return out
}

/** Snap a single point (a polygon's vertex, a corner being drawn). */
export function snapPoint(
  p: Pt,
  lines: SnapLines,
  opts: { step: number; threshold: number; hardStep?: number }
): Pt {
  const s = snapBounds(
    { minX: p[0], maxX: p[0], minY: p[1], maxY: p[1] },
    lines,
    opts
  )
  return [round3(p[0] + s.dx), round3(p[1] + s.dy)]
}

// ── Free placement of tiles ───────────────────────────────────────────────

/**
 * On a free plan a tile turns to any whole degree. Its stored footprint is
 * the one at the nearest quarter turn (as on a grid plan, where a quarter
 * turn swaps width and height), and it is drawn turned by what is left over
 * - at most 45° either way. A tile at a quarter turn therefore looks and
 * stores exactly as on a grid plan, so "Snap all" only rounds.
 */
export function tileQuarter(orientation: number): number {
  return normAngle(Math.round(orientation / 90) * 90)
}

/** The turn a free tile is drawn with beyond its quarter turn. */
export function tileResidual(orientation: number): number {
  let r = normAngle(orientation) - tileQuarter(orientation)
  if (r > 180) r -= 360
  if (r <= -180) r += 360
  return r
}

/** A tile as a turned box (its footprint turned by its residual). */
export function tileBox(
  t: Pick<FloorPlanTile, "x" | "y" | "width" | "height" | "orientation">
): Box {
  return {
    x: t.x,
    y: t.y,
    width: t.width,
    height: t.height,
    rotation: tileResidual(t.orientation),
  }
}

/** The patch that turns a free tile to `angle`: when its quarter turn
 * changes parity, the footprint swaps width and height about its centre -
 * the same shape on the plan. */
export function tileAnglePatch(
  t: Pick<FloorPlanTile, "x" | "y" | "width" | "height" | "orientation">,
  angle: number
): Pick<FloorPlanTile, "x" | "y" | "width" | "height" | "orientation"> {
  const orientation = Math.round(normAngle(angle)) % 360
  const before = tileQuarter(t.orientation)
  const after = tileQuarter(orientation)
  const swap = (after - before + 360) % 180 !== 0
  if (!swap)
    return { x: t.x, y: t.y, width: t.width, height: t.height, orientation }
  const cx = t.x + t.width / 2
  const cy = t.y + t.height / 2
  return {
    x: round3(cx - t.height / 2),
    y: round3(cy - t.width / 2),
    width: t.height,
    height: t.width,
    orientation,
  }
}

/** A tile's box turned back into its fields after a free resize. */
export function tileFromBox(
  b: Box
): Pick<FloorPlanTile, "x" | "y" | "width" | "height"> {
  return { x: b.x, y: b.y, width: b.width, height: b.height }
}

// ── Shapes ────────────────────────────────────────────────────────────────

/** A shape as a box: a rectangle area or a label. Polygons have none. */
export function shapeBox(s: PlanShape, cellMm: number): Box | null {
  if (s.kind === "label") return labelBox(s, cellMm)
  if (s.shape === "polygon") return null
  return {
    x: s.x,
    y: s.y,
    width: s.width,
    height: s.height,
    rotation: s.rotation,
  }
}

/** The upright rectangle round a shape. */
export function shapeBounds(s: PlanShape, cellMm: number): Bounds {
  if (s.kind === "area" && s.shape === "polygon" && s.points.length)
    return pointsBounds(s.points)
  return boxBounds(shapeBox(s, cellMm)!)
}

/** A shape moved by (dx, dy) cells. */
export function moveShapePatch(
  s: PlanShape,
  dx: number,
  dy: number
): Partial<PlanShape> {
  if (s.kind === "area" && s.shape === "polygon")
    return {
      points: s.points.map(([x, y]): Pt => [round3(x + dx), round3(y + dy)]),
      x: round3(s.x + dx),
      y: round3(s.y + dy),
    }
  return { x: round3(s.x + dx), y: round3(s.y + dy) }
}

/** The polygon's bounding box fields, to keep with its points. */
export function polygonPatch(points: Pt[]): Partial<FloorPlanArea> {
  const b = pointsBounds(points)
  return {
    points: points.map(([x, y]) => [round3(x), round3(y)]),
    x: round3(b.minX),
    y: round3(b.minY),
    width: round3(b.maxX - b.minX),
    height: round3(b.maxY - b.minY),
  }
}

/** Draw order: areas by z, labels by z, each list stable. */
export function byZ<T extends { z: number }>(a: T, b: T): number {
  return a.z - b.z
}
