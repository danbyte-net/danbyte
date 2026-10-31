import type {
  FloorPlanTray,
  FloorPlanWall,
  FloorPlanWallOpening,
  RaisedFloorArea,
} from "@/lib/api"

import { boxCorners } from "./shapes"
import type { AreaShape, Pt } from "./shapes"

// Walls, raised floors and trays in the editor's draft, and the geometry the
// canvas edits them with: walls from an area's outline, doors placed,
// resized, slid and flipped along their wall, polylines split and joined,
// and the snapping that pulls a dragged point onto the lattice and onto other
// runs. Pure functions, shared by the canvas, the inspectors and the tests.

/** A wall, a raised floor or a tray in the editor's draft. */
export type StructShape =
  | ({ part: "wall" } & FloorPlanWall)
  | ({ part: "tray" } & FloorPlanTray)
  | ({ part: "raised_floor" } & RaisedFloorArea)
export type WallRow = Extract<StructShape, { part: "wall" }>
export type TrayRow = Extract<StructShape, { part: "tray" }>
export type RaisedRow = Extract<StructShape, { part: "raised_floor" }>
/** A wall or a tray: a polyline on the half-cell lattice. */
export type RunRow = WallRow | TrayRow

/** The saved walls, trays and raised floors as the draft keeps them. */
export function structureOf(
  walls: FloorPlanWall[] | undefined,
  trays: FloorPlanTray[] | undefined,
  raised: RaisedFloorArea[] | undefined
): StructShape[] {
  return [
    ...(walls ?? []).map((w) => ({ ...w, part: "wall" as const })),
    ...(trays ?? []).map((t) => ({ ...t, part: "tray" as const })),
    ...(raised ?? []).map((r) => ({ ...r, part: "raised_floor" as const })),
  ]
}

/** The draft's structure, one list per kind. */
export function structureLists(structure: readonly StructShape[]) {
  const walls: WallRow[] = []
  const trays: TrayRow[] = []
  const raised: RaisedRow[] = []
  for (const s of structure) {
    if (s.part === "wall") walls.push(s)
    else if (s.part === "tray") trays.push(s)
    else raised.push(s)
  }
  return { walls, trays, raised }
}

/** A wall with no thickness of its own is this thick. */
export const WALL_DEFAULT_MM = 100
/** A door placed with a click is this wide. */
export const DOOR_DEFAULT_MM = 900
/** The narrowest door a drag leaves. */
export const DOOR_MIN_MM = 100
/** Walls and trays: the half-cell lattice their points sit on. */
export const LATTICE = 0.5
/** Two points closer than this (cells) are the same point. */
export const SAME_PT = 1e-6

export const wallThicknessMm = (w: Pick<FloorPlanWall, "thickness_mm">) =>
  w.thickness_mm ?? WALL_DEFAULT_MM

const r3 = (v: number) => Math.round(v * 1000) / 1000
const r2 = (v: number) => Math.round(v * 100) / 100
export const onLattice = (v: number, step = LATTICE) =>
  Math.round(v / step) * step
const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v))
const same = (a: Pt, b: Pt, tol = SAME_PT) =>
  Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol

/** The plan's grid, in cells: where points may go. */
export interface GridSize {
  w: number
  h: number
}

/** A point on the lattice, inside the grid. */
export function latticePoint(p: Pt, grid: GridSize, step = LATTICE): Pt {
  return [
    clamp(onLattice(p[0], step), 0, grid.w),
    clamp(onLattice(p[1], step), 0, grid.h),
  ]
}

export function segLength(points: readonly Pt[], seg: number): number {
  const a = points[seg]
  const b = points[seg + 1]
  return a && b ? Math.hypot(b[0] - a[0], b[1] - a[1]) : 0
}

export function runLength(points: readonly Pt[]): number {
  let n = 0
  for (let i = 0; i < points.length - 1; i++) n += segLength(points, i)
  return n
}

/** The point `t` cells along segment `seg`. */
export function pointAlong(points: readonly Pt[], seg: number, t: number): Pt {
  const [ax, ay] = points[seg]
  const [bx, by] = points[seg + 1]
  const len = Math.hypot(bx - ax, by - ay) || 1
  return [ax + ((bx - ax) * t) / len, ay + ((by - ay) * t) / len]
}

/** Where a point falls on segment `seg`: how far along (clamped to it) and
 * how far off. */
export function projectOnSegment(
  points: readonly Pt[],
  seg: number,
  p: Pt
): { t: number; dist: number } {
  const [ax, ay] = points[seg]
  const [bx, by] = points[seg + 1]
  const dx = bx - ax
  const dy = by - ay
  const len = Math.hypot(dx, dy)
  if (len < SAME_PT)
    return { t: 0, dist: Math.hypot(p[0] - ax, p[1] - ay) }
  const t = clamp(((p[0] - ax) * dx + (p[1] - ay) * dy) / len, 0, len)
  const q = pointAlong(points, seg, t)
  return { t, dist: Math.hypot(p[0] - q[0], p[1] - q[1]) }
}

/** The segment of a polyline nearest a point. */
export function nearestSegment(
  points: readonly Pt[],
  p: Pt
): { seg: number; t: number; dist: number } | null {
  let best: { seg: number; t: number; dist: number } | null = null
  for (let seg = 0; seg < points.length - 1; seg++) {
    const r = projectOnSegment(points, seg, p)
    if (!best || r.dist < best.dist) best = { seg, ...r }
  }
  return best
}

// ── Walls from an outline ────────────────────────────────────────────────

/** An area's outline, its corners in order, in cell units: a rectangle's
 * four (turned about its centre), a polygon's points. */
export function areaOutline(a: AreaShape): Pt[] {
  if (a.shape === "polygon") return a.points.map((p) => [p[0], p[1]] as Pt)
  return boxCorners(a)
}

/** How much of segment a→b (as [from, to] cells along it) runs along the
 * given segments - collinear with it, within `tol` of its line. */
function coveredOn(
  a: Pt,
  b: Pt,
  segs: readonly [Pt, Pt][],
  tol: number
): [number, number][] {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1])
  if (len < SAME_PT) return []
  const ux = (b[0] - a[0]) / len
  const uy = (b[1] - a[1]) / len
  const off = (p: Pt) => Math.abs((p[0] - a[0]) * uy - (p[1] - a[1]) * ux)
  const along = (p: Pt) => (p[0] - a[0]) * ux + (p[1] - a[1]) * uy
  const out: [number, number][] = []
  for (const [c, d] of segs) {
    if (off(c) > tol || off(d) > tol) continue
    const lo = Math.max(0, Math.min(along(c), along(d)))
    const hi = Math.min(len, Math.max(along(c), along(d)))
    if (hi - lo > SAME_PT) out.push([lo, hi])
  }
  out.sort((x, y) => x[0] - y[0])
  const merged: [number, number][] = []
  for (const iv of out) {
    const last = merged.at(-1)
    if (last && iv[0] <= last[1] + tol) last[1] = Math.max(last[1], iv[1])
    else merged.push([iv[0], iv[1]])
  }
  return merged
}

const segmentsOf = (runs: readonly { points: readonly Pt[] }[]) =>
  runs.flatMap((r) =>
    r.points.slice(0, -1).map((p, i) => [p, r.points[i + 1]] as [Pt, Pt])
  )

/**
 * The walls to draw around outlines: one polyline per unbroken run of their
 * edges, joined at the corners (a whole outline is one closed run), on the
 * lattice walls use. Where a wall already runs along an edge (collinear,
 * within `tol` cells) that stretch is left out - so is one the outlines
 * share, drawn once. Stretches shorter than `tol` are dropped.
 */
export function wallsAround(
  outlines: readonly Pt[][],
  existing: readonly { points: readonly Pt[] }[],
  grid: GridSize,
  tol = 0.25
): Pt[][] {
  const made: Pt[][] = []
  for (const raw of outlines) {
    // Corners on the lattice; repeats (a sliver edge snapped away) go.
    const ring: Pt[] = []
    for (const p of raw) {
      const q = latticePoint(p, grid)
      if (!ring.length || !same(ring[ring.length - 1], q)) ring.push(q)
    }
    while (ring.length > 1 && same(ring[0], ring[ring.length - 1])) ring.pop()
    if (ring.length < 2) continue
    const covered = segmentsOf([...existing, ...made.map((points) => ({ points }))])
    // The uncovered stretches of each edge, in order around the outline.
    const pieces: [Pt, Pt][] = []
    const n = ring.length
    for (let i = 0; i < n; i++) {
      const a = ring[i]
      const b = ring[(i + 1) % n]
      if (n === 2 && i === 1) break
      const len = Math.hypot(b[0] - a[0], b[1] - a[1])
      let cursor = 0
      const gaps: [number, number][] = []
      for (const [lo, hi] of coveredOn(a, b, covered, tol)) {
        if (lo - cursor > tol) gaps.push([cursor, lo])
        cursor = Math.max(cursor, hi)
      }
      if (len - cursor > tol) gaps.push([cursor, len])
      const at = (t: number): Pt =>
        latticePoint(
          [a[0] + ((b[0] - a[0]) * t) / len, a[1] + ((b[1] - a[1]) * t) / len],
          grid
        )
      for (const [lo, hi] of gaps) {
        const p = lo < SAME_PT ? a : at(lo)
        const q = len - hi < SAME_PT ? b : at(hi)
        if (!same(p, q)) pieces.push([p, q])
      }
    }
    // Pieces that meet at a corner are one wall.
    const runs: Pt[][] = []
    for (const [p, q] of pieces) {
      const cur = runs.at(-1)
      if (cur && same(cur[cur.length - 1], p)) cur.push(q)
      else runs.push([p, q])
    }
    if (runs.length > 1) {
      const first = runs[0]
      const last = runs[runs.length - 1]
      if (same(last[last.length - 1], first[0])) {
        runs[0] = [...last, ...first.slice(1)]
        runs.pop()
      }
    }
    made.push(...runs)
  }
  return made
}

// ── Doors ────────────────────────────────────────────────────────────────

/** The free stretch of segment `seg` around `at` - between the doors either
 * side of it (one may be left out, the door being edited). Null when `at`
 * is inside another door. */
export function freeGap(
  points: readonly Pt[],
  openings: readonly FloorPlanWallOpening[],
  seg: number,
  at: number,
  ignore?: number
): [number, number] | null {
  let lo = 0
  let hi = segLength(points, seg)
  for (let i = 0; i < openings.length; i++) {
    const o = openings[i]
    if (i === ignore || o.seg !== seg) continue
    if (at > o.from + SAME_PT && at < o.to - SAME_PT) return null
    if (o.to <= at + SAME_PT) lo = Math.max(lo, o.to)
    else hi = Math.min(hi, o.from)
  }
  return hi > lo ? [lo, hi] : null
}

/**
 * A door dragged from `t0` to `t1` along segment `seg` - inside the wall
 * and clear of the other doors; a drag shorter than the narrowest door is
 * a click: a door of the default width centred on `t0`. Null when no door
 * fits there.
 */
export function doorFromDrag(
  points: readonly Pt[],
  openings: readonly FloorPlanWallOpening[],
  seg: number,
  t0: number,
  t1: number,
  cellMm: number
): { from: number; to: number } | null {
  const gap = freeGap(points, openings, seg, t0)
  if (!gap) return null
  const min = DOOR_MIN_MM / cellMm
  if (gap[1] - gap[0] < min - SAME_PT) return null
  let from: number
  let to: number
  if (Math.abs(t1 - t0) < min) {
    const w = Math.min(DOOR_DEFAULT_MM / cellMm, gap[1] - gap[0])
    from = clamp(t0 - w / 2, gap[0], gap[1] - w)
    to = from + w
  } else {
    from = clamp(Math.min(t0, t1), gap[0], gap[1])
    to = clamp(Math.max(t0, t1), gap[0], gap[1])
    if (to - from < min) return null
  }
  return { from: r2(from), to: r2(to) }
}

/** One end of door `index` dragged to `t`: inside its gap, no narrower
 * than the narrowest door. */
export function resizeDoor(
  points: readonly Pt[],
  openings: readonly FloorPlanWallOpening[],
  index: number,
  end: "from" | "to",
  t: number,
  cellMm: number
): FloorPlanWallOpening {
  const o = openings[index]
  const gap = freeGap(points, openings, o.seg, (o.from + o.to) / 2, index) ?? [
    o.from,
    o.to,
  ]
  const min = DOOR_MIN_MM / cellMm
  if (end === "from")
    return { ...o, from: r2(clamp(t, gap[0], o.to - min)) }
  return { ...o, to: r2(clamp(t, o.from + min, gap[1])) }
}

/** Door `index` slid `delta` cells along its segment, stopping at the
 * wall's ends and the doors either side. */
export function slideDoor(
  points: readonly Pt[],
  openings: readonly FloorPlanWallOpening[],
  index: number,
  delta: number
): FloorPlanWallOpening {
  const o = openings[index]
  const gap = freeGap(points, openings, o.seg, (o.from + o.to) / 2, index) ?? [
    o.from,
    o.to,
  ]
  const w = o.to - o.from
  const from = clamp(o.from + delta, gap[0], gap[1] - w)
  return { ...o, from: r2(from), to: r2(from + w) }
}

/** The next way a door swings: hinged at the start, opening left, then
 * right; hinged at the end, opening right, then left; round again. A plain
 * opening gets its first leaf. */
export function flipDoor(o: FloorPlanWallOpening): FloorPlanWallOpening {
  const order: [NonNullable<FloorPlanWallOpening["hinge"]>, NonNullable<FloorPlanWallOpening["side"]>][] = [
    ["start", "left"],
    ["start", "right"],
    ["end", "right"],
    ["end", "left"],
  ]
  const i = order.findIndex(([h, s]) => h === o.hinge && s === o.side)
  const [hinge, side] = order[(i + 1) % order.length]
  return { ...o, hinge, side }
}

/** A door's leaf in plan, cell units: the hinge, where the leaf stands
 * open (square to the wall) and the jamb it closes on - the 2D swing arc
 * runs from the open leaf to that jamb. Null for a plain opening. */
export function doorLeaf(
  points: readonly Pt[],
  o: FloorPlanWallOpening
): { hinge: Pt; open: Pt; jamb: Pt; sweep: 0 | 1 } | null {
  if (!o.hinge || !o.side || !points[o.seg + 1]) return null
  const a = pointAlong(points, o.seg, o.from)
  const b = pointAlong(points, o.seg, o.to)
  const [hinge, jamb] = o.hinge === "start" ? [a, b] : [b, a]
  const w = Math.hypot(b[0] - a[0], b[1] - a[1])
  const [ax, ay] = points[o.seg]
  const [bx, by] = points[o.seg + 1]
  const len = Math.hypot(bx - ax, by - ay) || 1
  // Left of the segment's direction, on a y-down plan.
  const sgn = o.side === "left" ? 1 : -1
  const nx = ((by - ay) / len) * sgn
  const ny = (-(bx - ax) / len) * sgn
  const open: Pt = [hinge[0] + nx * w, hinge[1] + ny * w]
  // The arc turns from the open leaf back to the jamb.
  const cross =
    (open[0] - hinge[0]) * (jamb[1] - hinge[1]) -
    (open[1] - hinge[1]) * (jamb[0] - hinge[0])
  return { hinge, open, jamb, sweep: cross > 0 ? 1 : 0 }
}

/** Doors kept inside their segments when a wall's points move: each keeps
 * its width and slides in where its segment got shorter; one wider than
 * its segment now goes. */
export function fitOpenings(
  points: readonly Pt[],
  openings: readonly FloorPlanWallOpening[]
): FloorPlanWallOpening[] {
  const out: FloorPlanWallOpening[] = []
  const bySeg = new Map<number, FloorPlanWallOpening[]>()
  for (const o of openings) {
    if (o.seg < 0 || o.seg >= points.length - 1) continue
    bySeg.set(o.seg, [...(bySeg.get(o.seg) ?? []), o])
  }
  for (const [seg, list] of bySeg) {
    const len = segLength(points, seg)
    // From the far end back, each door stops short of the one after it.
    let limit = len
    const kept: FloorPlanWallOpening[] = []
    for (const o of [...list].sort((x, y) => y.from - x.from)) {
      const w = o.to - o.from
      const to = Math.min(o.to, limit)
      const from = to - w
      if (from < -SAME_PT) continue
      kept.push({ ...o, from: r2(Math.max(0, from)), to: r2(to) })
      limit = Math.max(0, from)
    }
    out.push(...kept.reverse())
  }
  return out.sort((x, y) => x.seg - y.seg || x.from - y.from)
}

// ── Polylines: move, split, join ─────────────────────────────────────────

export function translatePoints(
  points: readonly Pt[],
  dx: number,
  dy: number,
  grid: GridSize
): Pt[] {
  // The whole run stays on the plan: the shift is held at its edges.
  const xs = points.map((p) => p[0])
  const ys = points.map((p) => p[1])
  const ddx = clamp(dx, -Math.min(...xs), grid.w - Math.max(...xs))
  const ddy = clamp(dy, -Math.min(...ys), grid.h - Math.max(...ys))
  return points.map(([x, y]) => [r3(x + ddx), r3(y + ddy)])
}

/** Segment `seg` moved by (dx, dy): both its ends, the segments either side
 * stretching to follow. */
export function moveSegment(
  points: readonly Pt[],
  seg: number,
  dx: number,
  dy: number,
  grid: GridSize
): Pt[] {
  const moved = translatePoints([points[seg], points[seg + 1]], dx, dy, grid)
  return points.map((p, i) =>
    i === seg ? moved[0] : i === seg + 1 ? moved[1] : [p[0], p[1]]
  )
}

/** A wall's doors as they read on the run drawn the other way round. */
export function reverseOpenings(
  points: readonly Pt[],
  openings: readonly FloorPlanWallOpening[]
): FloorPlanWallOpening[] {
  const n = points.length - 1
  return openings.map((o) => {
    const len = segLength(points, o.seg)
    const out: FloorPlanWallOpening = {
      ...o,
      seg: n - 1 - o.seg,
      from: r2(len - o.to),
      to: r2(len - o.from),
    }
    if (o.hinge) out.hinge = o.hinge === "start" ? "end" : "start"
    if (o.side) out.side = o.side === "left" ? "right" : "left"
    return out
  })
}

/**
 * A run cut at `t` cells along segment `seg` into two runs that meet there,
 * and its doors shared out between them. Null at either end of the run, or
 * inside a door (a door is never cut).
 */
export function splitRun(
  points: readonly Pt[],
  openings: readonly FloorPlanWallOpening[],
  seg: number,
  t: number,
  grid: GridSize
): {
  a: { points: Pt[]; openings: FloorPlanWallOpening[] }
  b: { points: Pt[]; openings: FloorPlanWallOpening[] }
} | null {
  const len = segLength(points, seg)
  const cut = latticePoint(pointAlong(points, seg, clamp(t, 0, len)), grid)
  const along = projectOnSegment(points, seg, cut).t
  const at0 = same(cut, points[seg])
  const at1 = same(cut, points[seg + 1])
  if ((at0 && seg === 0) || (at1 && seg === points.length - 2)) return null
  if (
    openings.some(
      (o) =>
        o.seg === seg && along > o.from + SAME_PT && along < o.to - SAME_PT
    )
  )
    return null
  const head = points.slice(0, seg + 1).map((p) => [p[0], p[1]] as Pt)
  const tail = points.slice(seg + 1).map((p) => [p[0], p[1]] as Pt)
  const aPts = at0 ? head : [...head, cut]
  const bPts = at1 ? tail : [cut, ...tail]
  // Segment `seg` ends the first run (unless the cut fell on its start) and
  // starts the second (unless on its end).
  const firstB = at1 ? seg + 1 : seg
  const aOpen: FloorPlanWallOpening[] = []
  const bOpen: FloorPlanWallOpening[] = []
  for (const o of openings) {
    if (o.seg < seg || (o.seg === seg && !at0 && o.to <= along + SAME_PT))
      aOpen.push({ ...o })
    else if (o.seg === seg && !at1)
      bOpen.push({
        ...o,
        seg: 0,
        from: r2(o.from - along),
        to: r2(o.to - along),
      })
    else bOpen.push({ ...o, seg: o.seg - firstB })
  }
  if (aPts.length < 2 || bPts.length < 2) return null
  return {
    a: { points: aPts, openings: aOpen },
    b: { points: bPts, openings: bOpen },
  }
}

/**
 * Two runs that touch end to end made one: the first keeps its direction
 * where it can, the second follows on from it. Null when no end of one
 * meets an end of the other (within `tol` cells).
 */
export function joinRuns(
  a: { points: readonly Pt[]; openings?: readonly FloorPlanWallOpening[] },
  b: { points: readonly Pt[]; openings?: readonly FloorPlanWallOpening[] },
  tol = 0.01
): { points: Pt[]; openings: FloorPlanWallOpening[] } | null {
  const fwd = (r: typeof a) => ({
    points: r.points.map((p) => [p[0], p[1]] as Pt),
    openings: [...(r.openings ?? [])],
  })
  const rev = (r: typeof a) => ({
    points: [...r.points].reverse().map((p) => [p[0], p[1]] as Pt),
    openings: reverseOpenings(r.points, r.openings ?? []),
  })
  const aS = a.points[0]
  const aE = a.points[a.points.length - 1]
  const bS = b.points[0]
  const bE = b.points[b.points.length - 1]
  let first: ReturnType<typeof fwd>
  let second: ReturnType<typeof fwd>
  if (same(aE, bS, tol)) [first, second] = [fwd(a), fwd(b)]
  else if (same(aE, bE, tol)) [first, second] = [fwd(a), rev(b)]
  else if (same(aS, bE, tol)) [first, second] = [fwd(b), fwd(a)]
  else if (same(aS, bS, tol)) [first, second] = [rev(a), fwd(b)]
  else return null
  const shift = first.points.length - 1
  return {
    points: [...first.points, ...second.points.slice(1)],
    openings: [
      ...first.openings,
      ...second.openings.map((o) => ({ ...o, seg: o.seg + shift })),
    ],
  }
}

/** Whether two runs touch end to end. */
export const runsTouch = (
  a: { points: readonly Pt[] },
  b: { points: readonly Pt[] }
) => joinRuns(a, b) !== null

// ── Snapping ─────────────────────────────────────────────────────────────

/** The point snapped to, and the lines it lined up on. */
export interface StructSnap {
  p: Pt
  /** A vertical / horizontal guide through the point it lined up with. */
  guides: { x?: number; y?: number }
  /** The run end it landed on, when it landed on one. */
  end?: { id: string; index: number }
}

/**
 * A dragged point snapped: onto another run's point or edge within `reach`
 * cells (the nearest point wins), else onto the lattice, then lined up with
 * a point of another run in x or y within `reach` - each alignment drawn as
 * a guide. `free` (Alt) keeps it to the lattice alone.
 */
export function snapStructPoint(
  p: Pt,
  runs: readonly { id: string; points: readonly Pt[] }[],
  opts: {
    grid: GridSize
    reach: number
    step?: number
    free?: boolean
    /** The run being dragged, whose own points it does not snap to. */
    skip?: string
  }
): StructSnap {
  const step = opts.step ?? LATTICE
  const base = latticePoint(p, opts.grid, step)
  if (opts.free) return { p: base, guides: {} }
  const others = runs.filter((r) => r.id !== opts.skip)
  let best: { p: Pt; d: number; end?: StructSnap["end"] } | null = null
  for (const r of others) {
    r.points.forEach((v, i) => {
      const d = Math.hypot(p[0] - v[0], p[1] - v[1])
      if (d <= opts.reach && (!best || d < best.d)) {
        const end =
          i === 0 || i === r.points.length - 1 ? { id: r.id, index: i } : undefined
        best = { p: [v[0], v[1]], d: d - 1e-3, end }
      }
    })
  }
  if (!best)
    for (const r of others)
      for (let seg = 0; seg < r.points.length - 1; seg++) {
        const { t, dist } = projectOnSegment(r.points, seg, p)
        if (dist <= opts.reach && (!best || dist < best.d))
          best = {
            p: latticePoint(pointAlong(r.points, seg, t), opts.grid, step),
            d: dist,
          }
      }
  const found = best as { p: Pt; d: number; end?: StructSnap["end"] } | null
  if (found) {
    const guides: StructSnap["guides"] = {}
    return { p: found.p, guides, end: found.end }
  }
  // Lined up with another run's point.
  const out: Pt = [base[0], base[1]]
  const guides: StructSnap["guides"] = {}
  let bx = opts.reach
  let by = opts.reach
  for (const r of others)
    for (const v of r.points) {
      const dx = Math.abs(p[0] - v[0])
      const dy = Math.abs(p[1] - v[1])
      if (dx <= bx) {
        bx = dx
        out[0] = v[0]
        guides.x = v[0]
      }
      if (dy <= by) {
        by = dy
        out[1] = v[1]
        guides.y = v[1]
      }
    }
  return { p: out, guides }
}

/** A raised floor's box as it is moved or resized: whole cells, inside the
 * grid, its edges pulled onto the other raised floors' edges within
 * `reach`. */
export function snapRect(
  r: { x: number; y: number; width: number; height: number },
  others: readonly { x: number; y: number; width: number; height: number }[],
  grid: GridSize,
  reach: number,
  free = false
): {
  rect: { x: number; y: number; width: number; height: number }
  guides: { x?: number; y?: number }
} {
  let x = Math.round(r.x)
  let y = Math.round(r.y)
  const width = Math.max(1, Math.round(r.width))
  const height = Math.max(1, Math.round(r.height))
  const guides: { x?: number; y?: number } = {}
  if (!free) {
    const xs = others.flatMap((o) => [o.x, o.x + o.width])
    const ys = others.flatMap((o) => [o.y, o.y + o.height])
    const pull = (lo: number, size: number, lines: number[]) => {
      let bestD = reach
      let at: number | null = null
      let line: number | undefined
      for (const v of lines)
        for (const [edge, off] of [
          [lo, 0],
          [lo + size, size],
        ] as const) {
          const d = Math.abs(edge - v)
          if (d <= bestD) {
            bestD = d
            at = v - off
            line = v
          }
        }
      return { at, line }
    }
    const px = pull(r.x, width, xs)
    if (px.at !== null) {
      x = px.at
      guides.x = px.line
    }
    const py = pull(r.y, height, ys)
    if (py.at !== null) {
      y = py.at
      guides.y = py.line
    }
  }
  x = clamp(x, 0, Math.max(0, grid.w - width))
  y = clamp(y, 0, Math.max(0, grid.h - height))
  return {
    rect: { x, y, width: Math.min(width, grid.w), height: Math.min(height, grid.h) },
    guides,
  }
}

/** Whether two raised floors overlap (they may share edges). */
export function rectsOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number }
): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  )
}

/** A length in cells, read in metres or centimetres on this plan. */
export function lengthText(cells: number, cellMm: number): string {
  const mm = cells * cellMm
  if (mm < 1000) return `${Math.round(mm / 10)} cm`
  return `${(mm / 1000).toFixed(2).replace(/\.?0+$/, "")} m`
}

/** A run without repeated points (a point dropped on its neighbour), its
 * doors on the segments that are left. */
export function dropRepeats(
  points: readonly Pt[],
  openings: readonly FloorPlanWallOpening[] = []
): { points: Pt[]; openings: FloorPlanWallOpening[] } {
  const out: Pt[] = []
  // Each old segment's new index; null for one that shrank to nothing.
  const segMap: (number | null)[] = []
  points.forEach((p, i) => {
    if (i > 0 && same(p, points[i - 1])) {
      segMap.push(null)
      return
    }
    if (i > 0) segMap.push(out.length - 1)
    out.push([p[0], p[1]])
  })
  const kept: FloorPlanWallOpening[] = []
  for (const o of openings) {
    const seg = segMap[o.seg]
    if (seg !== null && seg !== undefined) kept.push({ ...o, seg })
  }
  return { points: out, openings: kept }
}
