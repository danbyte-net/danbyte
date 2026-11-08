import type {
  FloorPlanTray,
  FloorPlanWall,
  FloorPlanWallOpening,
  RaisedFloorArea,
} from "@/lib/api"

import {
  boxCorners,
  normAngle,
  polygonCrossesItself,
  polygonPatch,
} from "./shapes"
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
/** A wall or a tray: a polyline in cell units (a tray's on the half-cell
 * lattice; a wall's anywhere, to 0.001 cell). */
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
/** A door's end rounded, never past the end of its segment. */
const capTo = (v: number, len: number) => Math.min(r2(v), len)
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

/** A point inside the grid at the place given, to 0.001 cell: a wall made
 * from an outline follows it exactly. */
export function exactPoint(p: Pt, grid: GridSize): Pt {
  return [r3(clamp(p[0], 0, grid.w)), r3(clamp(p[1], 0, grid.h))]
}

/** A point on segment `seg` of a run: on the lattice when the lattice point
 * lies on the segment (a hand-drawn run), else exactly where it is (a wall
 * that follows an outline). */
export function onRun(
  points: readonly Pt[],
  seg: number,
  p: Pt,
  grid: GridSize
): Pt {
  const snapped = latticePoint(p, grid)
  return projectOnSegment(points, seg, snapped).dist < 1e-6
    ? snapped
    : exactPoint(p, grid)
}

export function segLength(points: readonly Pt[], seg: number): number {
  const a = points[seg]
  const b = points[seg + 1]
  return a && b ? Math.hypot(b[0] - a[0], b[1] - a[1]) : 0
}

/** The upright box round a run's points. */
export function pointsBoundsOf(points: readonly Pt[]) {
  const xs = points.map((p) => p[0])
  const ys = points.map((p) => p[1])
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  }
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
  if (len < SAME_PT) return { t: 0, dist: Math.hypot(p[0] - ax, p[1] - ay) }
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
 * edges, joined at the corners (a whole outline is one closed run), exactly
 * on the outline (to 0.001 cell). Where a wall already runs along an edge
 * (collinear, within `tol` cells) that stretch is left out - so is one the
 * outlines share, drawn once. Stretches shorter than `tol` are dropped.
 * Each run names the outline it follows (its index).
 */
export function outlineWalls(
  outlines: readonly Pt[][],
  existing: readonly { points: readonly Pt[] }[],
  grid: GridSize,
  tol = 0.25
): { outline: number; points: Pt[] }[] {
  const made: Pt[][] = []
  const from: number[] = []
  outlines.forEach((raw, oi) => {
    // Corners exactly where the outline has them; repeats go.
    const ring: Pt[] = []
    for (const p of raw) {
      const q = exactPoint(p, grid)
      if (!ring.length || !same(ring[ring.length - 1], q, 1e-3)) ring.push(q)
    }
    while (ring.length > 1 && same(ring[0], ring[ring.length - 1], 1e-3))
      ring.pop()
    if (ring.length < 2) return
    const covered = segmentsOf([
      ...existing,
      ...made.map((points) => ({ points })),
    ])
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
        exactPoint(
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
    from.push(...runs.map(() => oi))
  })
  return made.map((points, i) => ({ outline: from[i], points }))
}

/** {@link outlineWalls}, the runs alone. */
export function wallsAround(
  outlines: readonly Pt[][],
  existing: readonly { points: readonly Pt[] }[],
  grid: GridSize,
  tol = 0.25
): Pt[][] {
  return outlineWalls(outlines, existing, grid, tol).map((r) => r.points)
}

// ── Walls linked to an area ──────────────────────────────────────────────

/** What walls made from an area are called: "<name> walls", numbered when
 * the outline gave several stretches. */
export function linkedWallLabel(name: string, index: number, count: number) {
  const base = `${name || "Area"} walls`
  return (count > 1 ? `${base} ${index + 1}` : base).slice(0, 64)
}

/** How an area moved, when it only moved: the shift that takes the old
 * outline onto the new one. Null when it was reshaped, turned or did not
 * move. */
export function outlineShift(before: Pt[], after: Pt[]): Pt | null {
  if (!before.length || before.length !== after.length) return null
  const dx = after[0][0] - before[0][0]
  const dy = after[0][1] - before[0][1]
  if (Math.abs(dx) < SAME_PT && Math.abs(dy) < SAME_PT) return null
  const tol = 1e-4
  for (let i = 0; i < before.length; i++)
    if (
      Math.abs(after[i][0] - before[i][0] - dx) > tol ||
      Math.abs(after[i][1] - before[i][1] - dy) > tol
    )
      return null
  return [dx, dy]
}

/** Whether a polyline closes on itself: three corners at least, its last
 * point on its first. */
export const isClosedRun = (p: readonly Pt[], tol = 2e-3) =>
  p.length >= 4 && same(p[0], p[p.length - 1], tol)

/**
 * A closed run edited at its seam stays closed: its first and last points
 * are one corner, so when an edit (a dragged point, a moved segment) moved
 * only one of them, the other goes with it. Anything else is returned as
 * it is.
 */
export function keepRingClosed(before: readonly Pt[], after: Pt[]): Pt[] {
  const n = after.length
  if (!isClosedRun(before) || n !== before.length || n < 4) return after
  const first = !same(before[0], after[0])
  const last = !same(before[n - 1], after[n - 1])
  if (first === last) return after
  const out = after.map((p) => [p[0], p[1]] as Pt)
  if (first) out[n - 1] = [out[0][0], out[0][1]]
  else out[0] = [out[n - 1][0], out[n - 1][1]]
  return out
}

/** A polyline's corners alone: repeats and points on a straight stretch
 * go. `closed`: the points are a ring (no repeated first point), and its
 * seam is a corner like any other. */
export function dropCollinear(
  points: readonly Pt[],
  closed = false,
  tol = 2e-3
): Pt[] {
  let pts = points.map((p) => [p[0], p[1]] as Pt)
  for (let changed = true; changed;) {
    changed = false
    const n = pts.length
    if (n < (closed ? 4 : 3)) break
    for (let i = closed ? 0 : 1; i < (closed ? n : n - 1); i++) {
      const a = pts[(i - 1 + n) % n]
      const b = pts[i]
      const c = pts[(i + 1) % n]
      const ab = Math.hypot(b[0] - a[0], b[1] - a[1])
      const bc = Math.hypot(c[0] - b[0], c[1] - b[1])
      // A repeat, or b on the straight line a→c (not a turn back).
      const cross =
        (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])
      const dot = (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1])
      const straight =
        ab > tol && bc > tol && Math.abs(cross) / (ab + bc) <= tol && dot > 0
      if (ab <= tol || straight) {
        pts = pts.filter((_, k) => k !== i)
        changed = true
        break
      }
    }
  }
  return pts
}

/** Two rings with the same corners in the same cyclic order, from any
 * start, either way round. */
function sameRing(a: readonly Pt[], b: readonly Pt[], tol: number) {
  const n = a.length
  if (n !== b.length || !n) return false
  for (let k = 0; k < n; k++) {
    if (!same(a[0], b[k], tol)) continue
    if (a.every((p, i) => same(p, b[(k + i) % n], tol))) return true
    if (a.every((p, i) => same(p, b[(k - i + n) % n], tol))) return true
  }
  return false
}

/** The same line on the floor: open polylines with the same corners, either
 * way round; closed ones the same ring from any start. */
const samePolyline = (a: readonly Pt[], b: readonly Pt[], tol = 2e-3) => {
  const ca = isClosedRun(a, tol)
  if (ca !== isClosedRun(b, tol)) return false
  if (ca)
    return sameRing(
      dropCollinear(a.slice(0, -1), true, tol),
      dropCollinear(b.slice(0, -1), true, tol),
      tol
    )
  const x = dropCollinear(a, false, tol)
  const y = dropCollinear(b, false, tol)
  if (x.length !== y.length) return false
  return (
    x.every((p, i) => same(p, y[i], tol)) ||
    x.every((p, i) => same(p, y[y.length - 1 - i], tol))
  )
}

/** Polylines joined end to end wherever one ends where another starts
 * (either way round); a chain that closes takes nothing more. */
export function joinChains(
  runs: readonly { points: readonly Pt[] }[],
  tol = 2e-3
): Pt[][] {
  const left = runs
    .filter((r) => r.points.length >= 2)
    .map((r) => r.points.map((p) => [p[0], p[1]] as Pt))
  const out: Pt[][] = []
  while (left.length) {
    let cur = left.shift()!
    for (let grown = true; grown && !isClosedRun(cur, tol);) {
      grown = false
      for (let i = 0; i < left.length; i++) {
        const p = left[i]
        const start = cur[0]
        const end = cur[cur.length - 1]
        const rev = [...p].reverse()
        if (same(end, p[0], tol)) cur = [...cur, ...p.slice(1)]
        else if (same(end, p[p.length - 1], tol))
          cur = [...cur, ...rev.slice(1)]
        else if (same(start, p[p.length - 1], tol))
          cur = [...p, ...cur.slice(1)]
        else if (same(start, p[0], tol)) cur = [...rev, ...cur.slice(1)]
        else continue
        left.splice(i, 1)
        grown = true
        break
      }
    }
    out.push(cur)
  }
  return out
}

/** Whether walls already run where `runs` would put them: the same lines,
 * in any order, either way round - walls that meet end to end read as one,
 * and a point on a straight stretch is no corner. */
export function runsMatch(
  walls: readonly { points: readonly Pt[] }[],
  runs: readonly Pt[][]
): boolean {
  const chains = joinChains(walls)
  if (chains.length !== runs.length) return false
  const left = [...runs]
  for (const c of chains) {
    const i = left.findIndex((r) => samePolyline(c, r))
    if (i < 0) return false
    left.splice(i, 1)
  }
  return true
}

/** The outline an area's linked walls draw, or why they draw none: joined
 * end to end they must close into one ring of 3 to 200 corners that has an
 * area and does not cross itself. */
export type WallRing =
  { ring: Pt[] } | { error: "open" | "crossed" | "too-many" }

export function wallRing(
  walls: readonly { points: readonly Pt[] }[]
): WallRing {
  const chains = joinChains(walls)
  if (chains.length !== 1 || !isClosedRun(chains[0])) return { error: "open" }
  const ring = dropCollinear(chains[0].slice(0, -1), true).map(
    ([x, y]) => [r3(x), r3(y)] as Pt
  )
  if (ring.length < 3) return { error: "open" }
  if (ring.length > 200) return { error: "too-many" }
  let twice = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
    twice += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]
  if (Math.abs(twice) < 1e-6 || polygonCrossesItself(ring))
    return { error: "crossed" }
  return { ring }
}

/** What the linked-walls card offers for an area: **Update walls** while
 * its walls are off its outline, **Update area** while the walls draw
 * another closed outline (or, asked from a wall, why they draw none). */
export interface SyncOffer {
  walls: boolean
  area: "update" | "open" | "crossed" | "too-many" | null
  /** The button the card leads with: the side not edited by hand. */
  lead: "walls" | "area"
}

export function syncOffer({
  wallsOff,
  fromWalls,
  from,
  locked,
}: {
  /** The walls are off the area's outline. */
  wallsOff: boolean
  /** The outline the walls draw; null when the area follows them. */
  fromWalls: WallRing | null
  /** What is selected: the area, or one of its walls. */
  from: "area" | "wall"
  /** A locked area keeps its outline. */
  locked: boolean
}): SyncOffer | null {
  let area: SyncOffer["area"] = null
  if (fromWalls && "ring" in fromWalls) area = locked ? null : "update"
  else if (fromWalls && from === "wall" && !locked) area = fromWalls.error
  if (!wallsOff && area !== "update") return null
  return {
    walls: wallsOff,
    area,
    lead: from === "wall" && area === "update" ? "area" : "walls",
  }
}

/** Whether an outline already is `ring`: the same corners, in order. */
export function outlineIsRing(outline: readonly Pt[], ring: readonly Pt[]) {
  return sameRing(dropCollinear(outline, true), dropCollinear(ring, true), 2e-3)
}

/**
 * The area patch that makes its outline `ring`. A rectangle stays one when
 * the ring is a rectangle - turned as near its old turn as the ring allows -
 * else the area becomes a polygon of the ring's corners.
 */
export function areaFromRing(
  area: AreaShape,
  ring: readonly Pt[]
): Partial<AreaShape> {
  if (area.shape !== "polygon" && ring.length === 4) {
    const box = ringRect(ring, area.rotation)
    if (box) return { ...box, points: [] }
  }
  return { shape: "polygon", rotation: 0, ...polygonPatch([...ring]) }
}

/**
 * Areas after their linked walls changed: each area in `areaIds` whose
 * linked walls close into one valid ring takes that ring as its outline
 * (the walls run exactly on it, as "Add walls around this" made them).
 * A locked area, an area already on its walls and an area whose walls are
 * open, crossed or too many keep their outline - the link stays, and the
 * area follows again once the walls close. Returns the same array when
 * nothing changed.
 */
export function areasFollowingWalls<
  TShape extends { id: string; kind: string },
>(
  shapes: readonly TShape[],
  structure: readonly StructShape[],
  areaIds: Iterable<string>
): { shapes: TShape[]; changed: string[] } {
  const ids = new Set(areaIds)
  const changed: string[] = []
  if (!ids.size) return { shapes: shapes as TShape[], changed }
  const walls = structureLists(structure).walls
  const next = shapes.map((s) => {
    if (s.kind !== "area" || !ids.has(s.id)) return s
    const area = s as unknown as AreaShape
    if (area.locked) return s
    const linked = walls.filter((w) => w.source_area === area.id)
    if (!linked.length) return s
    const r = wallRing(linked)
    if (!("ring" in r) || outlineIsRing(areaOutline(area), r.ring)) return s
    changed.push(area.id)
    return { ...s, ...areaFromRing(area, r.ring) }
  })
  return { shapes: changed.length ? next : (shapes as TShape[]), changed }
}

/**
 * An area's linked walls after the area was reshaped or turned: rebuilt
 * along the new outline when they ran along the old one - the same walls,
 * new points, each door at its place along its stretch. Null (the walls
 * stay; the card offers "Update walls") when they did not follow the old
 * outline, when the rebuild needs more or fewer walls, or when a door
 * would no longer fit.
 */
export function wallsFollowingArea(
  before: Pt[],
  after: Pt[],
  linked: readonly WallRow[],
  others: readonly { points: readonly Pt[] }[],
  grid: GridSize
): WallRow[] | null {
  if (!linked.length) return null
  const was = outlineWalls([before], others, grid).map((r) => r.points)
  if (!runsMatch(linked, was)) return null
  const runs = outlineWalls([after], others, grid).map((r) => r.points)
  if (runs.length !== linked.length || runsMatch(linked, runs)) return null
  const { openings, dropped } = rebuildWalls(linked, runs)
  if (dropped.length) return null
  return linked.map((w, i) => ({
    ...w,
    points: runs[i],
    openings: openings[i],
  }))
}

/** A four-corner ring as a box turned about its centre (clockwise degrees,
 * y down), at the turn nearest `near`; null when it is no rectangle. */
function ringRect(ring: readonly Pt[], near: number) {
  const e = ring.map((p, i) => {
    const q = ring[(i + 1) % 4]
    return [q[0] - p[0], q[1] - p[1]] as Pt
  })
  const len = e.map((v) => Math.hypot(v[0], v[1]))
  const tol = 1e-3 * Math.max(...len)
  for (let i = 0; i < 4; i++) {
    const v = e[i]
    const w = e[(i + 1) % 4]
    if (Math.abs(v[0] * w[0] + v[1] * w[1]) / len[(i + 1) % 4] > tol)
      return null
  }
  if (Math.abs(len[0] - len[2]) > tol || Math.abs(len[1] - len[3]) > tol)
    return null
  // Clockwise on screen (y down): each edge turns right into the next.
  const cw = e[0][0] * e[1][1] - e[0][1] * e[1][0] > 0
  const pts = cw ? [...ring] : [...ring].reverse()
  const cx = pts.reduce((s, p) => s + p[0], 0) / 4
  const cy = pts.reduce((s, p) => s + p[1], 0) / 4
  let best = { rotation: 0, width: 0, height: 0 }
  let bestOff = Infinity
  for (let k = 0; k < 4; k++) {
    const a = pts[k]
    const b = pts[(k + 1) % 4]
    const c = pts[(k + 2) % 4]
    const turn = r3(
      normAngle((Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI)
    )
    const rotation = turn >= 360 ? 0 : turn
    const d = Math.abs(rotation - normAngle(near))
    const off = Math.min(d, 360 - d)
    if (off < bestOff) {
      bestOff = off
      best = {
        rotation,
        width: r3(Math.hypot(b[0] - a[0], b[1] - a[1])),
        height: r3(Math.hypot(c[0] - b[0], c[1] - b[1])),
      }
    }
  }
  return {
    shape: "rect" as const,
    ...best,
    x: r3(cx - best.width / 2),
    y: r3(cy - best.height / 2),
  }
}

/** A door that does not fit the rebuilt walls: its old wall and index. */
export interface DroppedDoor {
  wall: number
  index: number
}

/**
 * Linked walls rebuilt along new runs: wall `i` takes run `i`; each door
 * keeps its width and its place along the run, as a share of the run's
 * length (slid into its segment when it would cross a corner). A door with
 * no run, too wide for its segment, or on top of another goes - listed in
 * `dropped`.
 */
export function rebuildWalls(
  walls: readonly {
    points: readonly Pt[]
    openings: readonly FloorPlanWallOpening[]
  }[],
  runs: readonly Pt[][]
): { openings: FloorPlanWallOpening[][]; dropped: DroppedDoor[] } {
  const dropped: DroppedDoor[] = []
  const openings = runs.map(() => [] as FloorPlanWallOpening[])
  walls.forEach((w, wi) => {
    const run = runs[wi] as Pt[] | undefined
    const oldLen = runLength(w.points)
    w.openings.forEach((o, index) => {
      if (!run || oldLen < SAME_PT) {
        dropped.push({ wall: wi, index })
        return
      }
      let before = 0
      for (let i = 0; i < o.seg; i++) before += segLength(w.points, i)
      const share = (before + (o.from + o.to) / 2) / oldLen
      const width = o.to - o.from
      // The new run's segment the door's middle falls on.
      let at = share * runLength(run)
      let seg = 0
      while (seg < run.length - 2 && at > segLength(run, seg)) {
        at -= segLength(run, seg)
        seg += 1
      }
      const len = segLength(run, seg)
      const from = clamp(at - width / 2, 0, len - width)
      const to = from + width
      const kept = openings[wi]
      if (
        width > len + SAME_PT ||
        kept.some((k) => k.seg === seg && from < k.to && k.from < to)
      ) {
        dropped.push({ wall: wi, index })
        return
      }
      kept.push({ ...o, seg, from: r2(Math.max(0, from)), to: capTo(to, len) })
    })
    openings[wi]?.sort((x, y) => x.seg - y.seg || x.from - y.from)
  })
  return { openings, dropped }
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
  return { from: r2(from), to: capTo(to, segLength(points, seg)) }
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
  if (end === "from") return { ...o, from: r2(clamp(t, gap[0], o.to - min)) }
  return { ...o, to: capTo(clamp(t, o.from + min, gap[1]), gap[1]) }
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
  return { ...o, from: r2(from), to: capTo(from + w, gap[1]) }
}

/** The next way a door swings: hinged at the start, opening left, then
 * right; hinged at the end, opening right, then left; round again. A plain
 * opening gets its first leaf. */
export function flipDoor(o: FloorPlanWallOpening): FloorPlanWallOpening {
  const order: [
    NonNullable<FloorPlanWallOpening["hinge"]>,
    NonNullable<FloorPlanWallOpening["side"]>,
  ][] = [
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
      kept.push({ ...o, from: r2(Math.max(0, from)), to: capTo(to, len) })
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
  const cut = onRun(
    points,
    seg,
    pointAlong(points, seg, clamp(t, 0, len)),
    grid
  )
  const along = projectOnSegment(points, seg, cut).t
  const at0 = same(cut, points[seg])
  const at1 = same(cut, points[seg + 1])
  if ((at0 && seg === 0) || (at1 && seg === points.length - 2)) return null
  if (
    openings.some(
      (o) => o.seg === seg && along > o.from + SAME_PT && along < o.to - SAME_PT
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
 * a guide. `free` (Alt) places it exactly where it is (to 0.001 cell).
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
  if (opts.free) return { p: exactPoint(p, opts.grid), guides: {} }
  const base = latticePoint(p, opts.grid, step)
  const others = runs.filter((r) => r.id !== opts.skip)
  let best: { p: Pt; d: number; end?: StructSnap["end"] } | null = null
  for (const r of others) {
    r.points.forEach((v, i) => {
      const d = Math.hypot(p[0] - v[0], p[1] - v[1])
      if (d <= opts.reach && (!best || d < best.d)) {
        const end =
          i === 0 || i === r.points.length - 1
            ? { id: r.id, index: i }
            : undefined
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
            p: onRun(r.points, seg, pointAlong(r.points, seg, t), opts.grid),
            d: dist,
          }
      }
  const found = best
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
    rect: {
      x,
      y,
      width: Math.min(width, grid.w),
      height: Math.min(height, grid.h),
    },
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
