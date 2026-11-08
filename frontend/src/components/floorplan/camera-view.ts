import type { FloorPlanTile, FloorPlanWall } from "@/lib/api"

import { tileHasFov } from "./canvas-geometry"
import { boxCorners, tileBox } from "./shapes"
import type { AreaShape, PlanShape, Pt } from "./shapes"
import { WALL_DEFAULT_MM, areaOutline } from "./structure"
import { tileFill } from "./tile-paint"

// What a camera on the plan can see: its field of view (a sector - or a
// full ring for a PTZ camera) cut short where a wall stands in the way.
// Pure geometry in cell units, shared by the 2D canvas, the 3D room, the
// PDF's plan and the coverage readout.
//
// Rules: every wall blocks, at any height, as its true outline (centreline
// plus half its thickness either side). A door or plain opening is a gap in
// the wall and is seen through - there is no closed-door state to honour.
// Racks and cabinets block only with "Racks block view" on: the plan does
// not know how high a camera hangs, so it can't tell whether one sees over
// them.
//
// Speed: the occluders go in a uniform grid; a camera tests only those
// within its reach, casts one ray per critical angle (each occluder corner,
// each place an occluder crosses the range circle, ±ε) plus enough evenly
// spread rays that the arcs read smooth, and keeps the nearest hit. Results
// are cached by the camera and the geometry it can reach, so a frame that
// moves nothing recomputes nothing and a drag recomputes only the cameras
// near what moved.

/** A segment that blocks sight. */
export type Seg = readonly [Pt, Pt]

/** A camera's field of view, in cells; angles in radians, y down. */
export interface CameraSpec {
  id: string
  origin: Pt
  /** The middle of the view: 0 = +x, clockwise (y points down). */
  dir: number
  /** The angle it sees across; 2π for a ring. */
  span: number
  range: number
  /** Where the tile itself sits - which side of a wall it hangs on. */
  home: Pt
}

/** A camera's visible area, ready to draw. */
export interface CameraView {
  id: string
  /** The outline, in cells. A sector starts at its apex. */
  polygon: Pt[]
  /** The apex: the camera's anchor, pushed out of a wall it sits in. */
  origin: Pt
  ring: boolean
  color: string
}

const TAU = Math.PI * 2
/** The nudge either side of a corner's angle. */
const EPS_ANGLE = 1e-5
/** How far an arc may stray from its chord (cells). */
const ARC_SAGITTA = 0.002
/** No arc is cut coarser than this. */
const MAX_ARC_STEP = (2 * Math.PI) / 180
/** Nor finer (a vast reach would cast needless rays). */
const MIN_ARC_STEP = (0.25 * Math.PI) / 180

/** The camera's field of view, or null for a tile that has none. */
export function cameraSpec(tile: FloorPlanTile): CameraSpec | null {
  if (!tileHasFov(tile) || !tile.fov_distance) return null
  if (!tile.fov_ptz && !tile.fov_deg) return null
  const a = tile.fov_anchor
  const ax = a.includes("l") ? 0 : a.includes("r") ? 1 : 0.5
  const ay = a.includes("t") ? 0 : a.includes("b") ? 1 : 0.5
  const deg = Math.min(360, Math.max(10, tile.fov_deg ?? 90))
  const ring = tile.fov_ptz || deg >= 360
  return {
    id: tile.id,
    origin: [tile.x + tile.width * ax, tile.y + tile.height * ay],
    // 0° on the plan is up, clockwise.
    dir: (((tile.fov_direction ?? 0) - 90) * Math.PI) / 180,
    span: ring ? TAU : (deg * Math.PI) / 180,
    range: tile.fov_distance,
    home: [tile.x + tile.width / 2, tile.y + tile.height / 2],
  }
}

// ── Occluders ────────────────────────────────────────────────────────────

/** A solid block of wall (or a rack): its corners in order. */
export type Quad = readonly [Pt, Pt, Pt, Pt]

/** A wall's floor-touching solid spans as quads - its outline, broken by
 * its doors and openings. A span that meets the next segment at a corner
 * runs on by half the thickness, so the outer corner is closed. */
export function wallQuads(
  wall: Pick<FloorPlanWall, "points" | "openings" | "thickness_mm">,
  cellMm: number
): Quad[] {
  const pts = wall.points
  if (pts.length < 2 || !(cellMm > 0)) return []
  const half = (wall.thickness_mm ?? WALL_DEFAULT_MM) / cellMm / 2
  const last = pts.length - 2
  const first = pts[0]
  const end = pts[pts.length - 1]
  const closed =
    pts.length > 2 && Math.hypot(first[0] - end[0], first[1] - end[1]) < 1e-3
  const out: Quad[] = []
  for (let seg = 0; seg <= last; seg++) {
    const [ax, ay] = pts[seg]
    const [bx, by] = pts[seg + 1]
    const len = Math.hypot(bx - ax, by - ay)
    if (len < 1e-9) continue
    const ux = (bx - ax) / len
    const uy = (by - ay) / len
    // The same clamping the 2D and 3D walls use (world.ts).
    const gaps = wall.openings
      .filter((o) => o.seg === seg)
      .map((o) => [
        Math.max(0, Math.min(o.from, len)),
        Math.max(0, Math.min(o.to, len)),
      ])
      .filter(([f, t]) => t > f)
      .sort((p, q) => p[0] - q[0])
    const spans: [number, number][] = []
    let cursor = 0
    for (const [f, t] of gaps) {
      if (f > cursor) spans.push([cursor, f])
      cursor = Math.max(cursor, t)
    }
    if (cursor < len) spans.push([cursor, len])
    const joinsBefore = seg > 0 || closed
    const joinsAfter = seg < last || closed
    for (let [s0, s1] of spans) {
      if (s0 === 0 && joinsBefore) s0 -= half
      if (s1 === len && joinsAfter) s1 += half
      const nx = -uy * half
      const ny = ux * half
      const p0: Pt = [ax + ux * s0, ay + uy * s0]
      const p1: Pt = [ax + ux * s1, ay + uy * s1]
      out.push([
        [p0[0] + nx, p0[1] + ny],
        [p1[0] + nx, p1[1] + ny],
        [p1[0] - nx, p1[1] - ny],
        [p0[0] - nx, p0[1] - ny],
      ])
    }
  }
  return out
}

/** A rack's or cabinet's footprint, as a quad. */
export function tileQuad(
  t: Pick<FloorPlanTile, "x" | "y" | "width" | "height" | "orientation">
): Quad {
  const c = boxCorners(tileBox(t))
  return [c[0], c[1], c[2], c[3]]
}

/** Tiles that stand in the way with "Racks block view" on. */
export function blocksView(t: FloorPlanTile): boolean {
  const k = t.linked?.kind
  return k === "rack" || k === "cabinet"
}

/** Whether `p` lies inside a convex quad (either winding). */
export function inQuad(p: Pt, q: Quad): boolean {
  let sign = 0
  for (let i = 0; i < 4; i++) {
    const a = q[i]
    const b = q[(i + 1) % 4]
    const c = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
    if (Math.abs(c) < 1e-12) continue
    const s = c > 0 ? 1 : -1
    if (sign && s !== sign) return false
    sign = s
  }
  return true
}

/** A uniform grid over the occluders' edges: what lies near a point. */
export class OccluderIndex {
  readonly quads: Quad[]
  private readonly segs: Seg[] = []
  private readonly owner: number[] = []
  private readonly cells = new Map<number, number[]>()
  private readonly size: number
  private stamp: Uint32Array
  private tick = 0

  constructor(quads: Quad[]) {
    this.quads = quads
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (let qi = 0; qi < quads.length; qi++) {
      const q = quads[qi]
      for (let i = 0; i < 4; i++) {
        const a = q[i]
        this.segs.push([a, q[(i + 1) % 4]])
        this.owner.push(qi)
        minX = Math.min(minX, a[0])
        minY = Math.min(minY, a[1])
        maxX = Math.max(maxX, a[0])
        maxY = Math.max(maxY, a[1])
      }
    }
    // About two edges a bucket on a busy plan, never under 2 cells.
    const area = quads.length ? (maxX - minX) * (maxY - minY) : 0
    this.size = Math.max(2, Math.sqrt(area / Math.max(1, quads.length)) * 1.5)
    this.stamp = new Uint32Array(this.segs.length)
    this.segs.forEach(([a, b], i) => {
      const x0 = Math.floor(Math.min(a[0], b[0]) / this.size)
      const x1 = Math.floor(Math.max(a[0], b[0]) / this.size)
      const y0 = Math.floor(Math.min(a[1], b[1]) / this.size)
      const y1 = Math.floor(Math.max(a[1], b[1]) / this.size)
      for (let x = x0; x <= x1; x++)
        for (let y = y0; y <= y1; y++) {
          const k = key(x, y)
          const list = this.cells.get(k)
          if (list) list.push(i)
          else this.cells.set(k, [i])
        }
    })
  }

  /** The edges in the box, each once, and the quads they belong to. */
  near(
    minX: number,
    minY: number,
    maxX: number,
    maxY: number
  ): { segs: Seg[]; quads: Set<number> } {
    const segs: Seg[] = []
    const quads = new Set<number>()
    if (++this.tick === 0xffffffff) {
      this.stamp.fill(0)
      this.tick = 1
    }
    const x0 = Math.floor(minX / this.size)
    const x1 = Math.floor(maxX / this.size)
    const y0 = Math.floor(minY / this.size)
    const y1 = Math.floor(maxY / this.size)
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) {
        const list = this.cells.get(key(x, y))
        if (!list) continue
        for (const i of list) {
          if (this.stamp[i] === this.tick) continue
          this.stamp[i] = this.tick
          segs.push(this.segs[i])
          quads.add(this.owner[i])
        }
      }
    return { segs, quads }
  }
}

const key = (x: number, y: number) => (x + 32768) * 65536 + (y + 32768)

// ── The visibility polygon ───────────────────────────────────────────────

/** The camera moved out of any wall (or rack) it sits inside, to the face
 * on the side it looks to - a camera mounted on a wall sees the room it
 * faces, not the inside of the wall. */
export function clearOrigin(spec: CameraSpec, quads: readonly Quad[]): Pt {
  let o = spec.origin
  // Which way "out" is: where it looks, or (a ring) where its tile sits.
  let wx = Math.cos(spec.dir)
  let wy = Math.sin(spec.dir)
  if (spec.span >= TAU - 1e-9) {
    const hx = spec.home[0] - o[0]
    const hy = spec.home[1] - o[1]
    const hl = Math.hypot(hx, hy)
    if (hl > 1e-9) {
      wx = hx / hl
      wy = hy / hl
    }
  }
  for (let pass = 0; pass < 4; pass++) {
    const q = quads.find((x) => inQuad(o, x))
    if (!q) break
    // The quad's two long faces: q0→q1 and q3→q2, and its normal.
    const ex = q[1][0] - q[0][0]
    const ey = q[1][1] - q[0][1]
    const el = Math.hypot(ex, ey) || 1
    let nx = -ey / el
    let ny = ex / el
    if (nx * wx + ny * wy < 0) {
      nx = -nx
      ny = -ny
    }
    // Out through the face the normal points at: the farthest corner
    // along it, then a hair more.
    let best = -Infinity
    for (const c of q)
      best = Math.max(best, (c[0] - o[0]) * nx + (c[1] - o[1]) * ny)
    const d = best + 1e-4
    o = [o[0] + nx * d, o[1] + ny * d]
  }
  return o
}

const cross = (ax: number, ay: number, bx: number, by: number) =>
  ax * by - ay * bx

/** The nearest hit along a ray, or `limit`. */
function castRay(
  o: Pt,
  dx: number,
  dy: number,
  segs: readonly Seg[],
  limit: number
): number {
  let best = limit
  for (const [a, b] of segs) {
    const ex = b[0] - a[0]
    const ey = b[1] - a[1]
    const den = cross(dx, dy, ex, ey)
    if (Math.abs(den) < 1e-12) continue
    const ox = a[0] - o[0]
    const oy = a[1] - o[1]
    const t = cross(ox, oy, ex, ey) / den
    if (t <= 1e-9 || t >= best) continue
    const s = cross(ox, oy, dx, dy) / den
    if (s < -1e-9 || s > 1 + 1e-9) continue
    best = t
  }
  return best
}

/** The rays' angles: every corner within reach and every crossing of the
 * range circle (±ε), the sector's edges, and an even spread for the arc -
 * as offsets from the sector's start, inside the sector. */
function rayAngles(
  o: Pt,
  start: number,
  span: number,
  range: number,
  segs: readonly Seg[]
): number[] {
  const ring = span >= TAU - 1e-9
  const out: number[] = []
  const push = (theta: number) => {
    let rel = (theta - start) % TAU
    if (rel < 0) rel += TAU
    if (ring || rel <= span) out.push(rel)
  }
  const r2 = range * range
  for (const [a, b] of segs) {
    for (const p of [a, b]) {
      const dx = p[0] - o[0]
      const dy = p[1] - o[1]
      if (dx * dx + dy * dy > r2) continue
      const th = Math.atan2(dy, dx)
      push(th - EPS_ANGLE)
      push(th)
      push(th + EPS_ANGLE)
    }
    // Where the edge crosses the range circle.
    const ex = b[0] - a[0]
    const ey = b[1] - a[1]
    const fx = a[0] - o[0]
    const fy = a[1] - o[1]
    const A = ex * ex + ey * ey
    const B = 2 * (fx * ex + fy * ey)
    const C = fx * fx + fy * fy - r2
    const disc = B * B - 4 * A * C
    if (A < 1e-18 || disc < 0) continue
    const sq = Math.sqrt(disc)
    for (const s of [(-B - sq) / (2 * A), (-B + sq) / (2 * A)]) {
      if (s < 0 || s > 1) continue
      const th = Math.atan2(fy + ey * s, fx + ex * s)
      push(th - EPS_ANGLE)
      push(th)
      push(th + EPS_ANGLE)
    }
  }
  // The arc: steps whose chord strays at most ARC_SAGITTA from it.
  const ideal = 2 * Math.acos(Math.max(-1, 1 - ARC_SAGITTA / range))
  const step = Math.min(MAX_ARC_STEP, Math.max(MIN_ARC_STEP, ideal))
  const n = Math.max(ring ? 32 : 2, Math.ceil(span / step))
  for (let i = 0; i <= n; i++) out.push((span * i) / n)
  out.sort((p, q) => p - q)
  // Drop repeats (and, on a ring, the end that meets the start).
  const kept: number[] = []
  for (const v of out) {
    if (ring && v >= TAU - 1e-12) continue
    if (kept.length && v - kept[kept.length - 1] < 1e-9) continue
    kept.push(v)
  }
  return kept
}

/** Points on one straight line in a row: the middle ones go. */
function dropCollinear(pts: Pt[], closedRing: boolean): Pt[] {
  if (pts.length < 4) return pts
  const out: Pt[] = []
  const n = pts.length
  for (let i = 0; i < n; i++) {
    const p = pts[i]
    if (!closedRing && (i === 0 || i === n - 1)) {
      out.push(p)
      continue
    }
    const a = out.length ? out[out.length - 1] : pts[(i - 1 + n) % n]
    const b = pts[(i + 1) % n]
    const abx = b[0] - a[0]
    const aby = b[1] - a[1]
    const len = Math.hypot(abx, aby)
    if (len < 1e-9) continue
    // Off the line a→b by less than this: on it.
    const off = Math.abs(cross(abx, aby, p[0] - a[0], p[1] - a[1])) / len
    if (off < 1e-6) {
      // Only if it lies between them.
      const t = ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / (len * len)
      if (t > 0 && t < 1) continue
    }
    out.push(p)
  }
  return out
}

/** The camera's visible area against these occluder edges. `quads` are the
 * blocks the edges outline (a camera inside one is moved out of it). */
export function visibilityPolygon(
  spec: CameraSpec,
  segs: readonly Seg[],
  quads: readonly Quad[] = []
): { polygon: Pt[]; origin: Pt } {
  const o = clearOrigin(spec, quads)
  const ring = spec.span >= TAU - 1e-9
  const start = ring ? 0 : spec.dir - spec.span / 2
  const span = ring ? TAU : spec.span
  // Only the edges inside the reach can matter.
  const R = spec.range
  const near = segs.filter(([a, b]) => segNearCircle(a, b, o, R))
  const rays = rayAngles(o, start, span, R, near)
  const bins = angularBins(o, near)
  const pts: Pt[] = []
  for (const rel of rays) {
    const th = start + rel
    const dx = Math.cos(th)
    const dy = Math.sin(th)
    let a = th % TAU
    if (a < 0) a += TAU
    const t = castRay(o, dx, dy, bins[Math.floor(a / BIN_W) % BINS], R)
    pts.push([o[0] + dx * t, o[1] + dy * t])
  }
  if (ring) return { polygon: dropCollinear(pts, true), origin: o }
  return { polygon: dropCollinear([o, ...pts], false), origin: o }
}

const BINS = 256
const BIN_W = TAU / BINS

/** The edges sorted into angular bins round `o`: a ray tests only the
 * edges its own bin holds, not every edge in reach. */
function angularBins(o: Pt, segs: readonly Seg[]): Seg[][] {
  const bins: Seg[][] = Array.from({ length: BINS }, () => [])
  for (const sg of segs) {
    const [a, b] = sg
    let ta = Math.atan2(a[1] - o[1], a[0] - o[0])
    if (ta < 0) ta += TAU
    let tb = Math.atan2(b[1] - o[1], b[0] - o[0])
    if (tb < 0) tb += TAU
    let d = tb - ta
    if (d > Math.PI) d -= TAU
    if (d <= -Math.PI) d += TAU
    // Through (or all but through) the camera: every bin.
    const ex = b[0] - a[0]
    const ey = b[1] - a[1]
    const len = Math.hypot(ex, ey)
    const off =
      len > 0 ? Math.abs(cross(ex, ey, o[0] - a[0], o[1] - a[1])) / len : 0
    if (off < 1e-6) {
      for (const bin of bins) bin.push(sg)
      continue
    }
    const lo = d >= 0 ? ta : tb
    const i0 = Math.floor(lo / BIN_W) - 1
    const i1 = Math.floor((lo + Math.abs(d)) / BIN_W) + 1
    for (let i = i0; i <= i1; i++) bins[((i % BINS) + BINS) % BINS].push(sg)
  }
  return bins
}

/** Whether segment a→b comes within `r` of `c`. */
function segNearCircle(a: Pt, b: Pt, c: Pt, r: number): boolean {
  const ex = b[0] - a[0]
  const ey = b[1] - a[1]
  const l2 = ex * ex + ey * ey
  let t = l2 > 0 ? ((c[0] - a[0]) * ex + (c[1] - a[1]) * ey) / l2 : 0
  t = Math.max(0, Math.min(1, t))
  const dx = a[0] + ex * t - c[0]
  const dy = a[1] + ey * t - c[1]
  return dx * dx + dy * dy <= r * r + 1e-9
}

// ── All the cameras of a plan, cached ────────────────────────────────────

export interface ViewOptions {
  cellMm: number
  /** Racks and cabinets block sight too. */
  racksBlock?: boolean
}

const quadsByWalls = new WeakMap<object, Map<number, Quad[]>>()

/** A wall's quads, kept while the wall row lives. */
function quadsOf(wall: FloorPlanWall, cellMm: number): Quad[] {
  let byCell = quadsByWalls.get(wall)
  if (!byCell) {
    byCell = new Map()
    quadsByWalls.set(wall, byCell)
  }
  let q = byCell.get(cellMm)
  if (!q) {
    q = wallQuads(wall, cellMm)
    byCell.set(cellMm, q)
  }
  return q
}

/** The polygons computed, by camera and the geometry it reaches. */
const CACHE_MAX = 4000
const cache = new Map<string, { polygon: Pt[]; origin: Pt }>()
/** How many polygons were computed rather than found (the tests read it). */
export const cacheStats = { hits: 0, misses: 0 }

export function clearViewCache() {
  cache.clear()
  cacheStats.hits = 0
  cacheStats.misses = 0
}

/** A short fingerprint of the edges a camera can reach - the same for the
 * same edges in any order. */
function segsHash(segs: readonly Seg[]): string {
  let s1 = 0
  let s2 = 0
  for (const [a, b] of segs) {
    let h1 = 0x811c9dc5
    let h2 = 0x01000193
    for (const v of [a[0], a[1], b[0], b[1]]) {
      const n = Math.round(v * 1e4) | 0
      h1 = Math.imul(h1 ^ n, 0x01000193)
      h2 = Math.imul(h2 ^ (n >>> 7), 0x5bd1e995) ^ (h1 >>> 13)
    }
    s1 = (s1 + h1) | 0
    s2 = (s2 + h2) | 0
  }
  return `${segs.length}:${(s1 >>> 0).toString(36)}${(s2 >>> 0).toString(36)}`
}

const specKey = (s: CameraSpec) =>
  [s.origin[0], s.origin[1], s.dir, s.span, s.range, s.home[0], s.home[1]]
    .map((v) => +v.toFixed(5))
    .join(",")

/** Every camera's visible area on the plan. */
export function cameraViews(
  tiles: readonly FloorPlanTile[],
  walls: readonly FloorPlanWall[],
  opts: ViewOptions
): CameraView[] {
  const specs: { spec: CameraSpec; tile: FloorPlanTile }[] = []
  for (const t of tiles) {
    const spec = cameraSpec(t)
    if (spec) specs.push({ spec, tile: t })
  }
  if (!specs.length) return []
  const quads: Quad[] = []
  for (const w of walls) for (const q of quadsOf(w, opts.cellMm)) quads.push(q)
  if (opts.racksBlock)
    for (const t of tiles) if (blocksView(t)) quads.push(tileQuad(t))
  const index = new OccluderIndex(quads)
  return specs.map(({ spec, tile }) => {
    const [ox, oy] = spec.origin
    // The reach, plus a wall's width so the one it hangs on is found.
    const r = spec.range + 1
    const hit = index.near(ox - r, oy - r, ox + r, oy + r)
    // Only what the reach touches: the buckets hold more.
    const segs = hit.segs.filter(([a, b]) =>
      segNearCircle(a, b, spec.origin, r)
    )
    const k = `${specKey(spec)}|${segsHash(segs)}`
    let got = cache.get(k)
    if (got) {
      cacheStats.hits++
      // Fresh again: the oldest go first.
      cache.delete(k)
      cache.set(k, got)
    } else {
      cacheStats.misses++
      got = visibilityPolygon(
        spec,
        segs,
        [...hit.quads].map((i) => index.quads[i])
      )
      cache.set(k, got)
      if (cache.size > CACHE_MAX) {
        const oldest = cache.keys().next().value
        if (oldest !== undefined) cache.delete(oldest)
      }
    }
    return {
      id: spec.id,
      polygon: got.polygon,
      origin: got.origin,
      ring: spec.span >= TAU - 1e-9,
      color: tileFill(tile),
    }
  })
}

/** A polygon as an SVG path, scaled to plan px. */
export function polygonPath(pts: readonly Pt[], scale: number): string {
  if (pts.length < 3) return ""
  const f = (v: number) => +(v * scale).toFixed(2)
  return (
    `M${f(pts[0][0])} ${f(pts[0][1])}` +
    pts
      .slice(1)
      .map((p) => `L${f(p[0])} ${f(p[1])}`)
      .join("") +
    "Z"
  )
}

/** A polygon's area (shoelace), in square cells. */
export function polygonArea(pts: readonly Pt[]): number {
  let s = 0
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++)
    s += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1]
  return Math.abs(s) / 2
}

// ── Coverage ─────────────────────────────────────────────────────────────

export interface Coverage {
  /** Share of each region seen by at least one camera (0-1); null for a
   * region with no floor. */
  regions: (number | null)[]
  /** Share of all the regions together (overlaps counted once). */
  total: number | null
}

/** At most this many samples across the regions' box. */
const MAX_SAMPLES = 400_000

/** How much of each region the views cover: the floor sampled on a fine
 * grid (scanline-filled, so cheap), each sample in or out. */
export function coverage(
  views: readonly (readonly Pt[])[],
  regions: readonly (readonly Pt[])[],
  maxSamples = MAX_SAMPLES
): Coverage {
  const live = regions.filter((r) => r.length >= 3)
  if (!live.length) return { regions: regions.map(() => null), total: null }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const r of live)
    for (const [x, y] of r) {
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
    }
  const w = maxX - minX
  const h = maxY - minY
  if (!(w > 0 && h > 0))
    return { regions: regions.map(() => null), total: null }
  const step = Math.max(0.02, Math.sqrt((w * h) / maxSamples))
  const nx = Math.max(1, Math.ceil(w / step))
  const ny = Math.max(1, Math.ceil(h / step))
  const seen = new Uint8Array(nx * ny)
  const fill = (poly: readonly Pt[], into: Uint8Array) =>
    scanFill(poly, minX, minY, step, nx, ny, into)
  for (const v of views) fill(v, seen)
  const union = new Uint8Array(nx * ny)
  const mask = new Uint8Array(nx * ny)
  const out = regions.map((r) => {
    if (r.length < 3) return null
    mask.fill(0)
    fill(r, mask)
    let inside = 0
    let hit = 0
    for (let i = 0; i < mask.length; i++)
      if (mask[i]) {
        inside++
        hit += seen[i]
        union[i] = 1
      }
    return inside ? hit / inside : null
  })
  let inside = 0
  let hit = 0
  for (let i = 0; i < union.length; i++)
    if (union[i]) {
      inside++
      hit += seen[i]
    }
  return { regions: out, total: inside ? hit / inside : null }
}

/** Marks the samples whose centres the polygon holds (even-odd). */
function scanFill(
  poly: readonly Pt[],
  x0: number,
  y0: number,
  step: number,
  nx: number,
  ny: number,
  into: Uint8Array
) {
  let pMinY = Infinity
  let pMaxY = -Infinity
  for (const p of poly) {
    pMinY = Math.min(pMinY, p[1])
    pMaxY = Math.max(pMaxY, p[1])
  }
  const j0 = Math.max(0, Math.ceil((pMinY - y0) / step - 0.5))
  const j1 = Math.min(ny - 1, Math.floor((pMaxY - y0) / step - 0.5))
  const xs: number[] = []
  for (let j = j0; j <= j1; j++) {
    const y = y0 + (j + 0.5) * step
    xs.length = 0
    for (let i = 0, k = poly.length - 1; i < poly.length; k = i++) {
      const [ax, ay] = poly[k]
      const [bx, by] = poly[i]
      if (ay > y !== by > y) xs.push(ax + ((y - ay) * (bx - ax)) / (by - ay))
    }
    xs.sort((p, q) => p - q)
    for (let m = 0; m + 1 < xs.length; m += 2) {
      const i0 = Math.max(0, Math.ceil((xs[m] - x0) / step - 0.5))
      const i1 = Math.min(nx - 1, Math.floor((xs[m + 1] - x0) / step - 0.5))
      const row = j * nx
      for (let i = i0; i <= i1; i++) into[row + i] = 1
    }
  }
}

/** The floor coverage is measured over: the plan's areas, or with none
 * drawn, the whole grid. */
export function coverageRegions(
  shapes: readonly PlanShape[],
  grid: { grid_width: number; grid_height: number }
): { ids: (string | null)[]; outlines: Pt[][] } {
  const areas = shapes.filter((s): s is AreaShape => s.kind === "area")
  if (areas.length)
    return { ids: areas.map((a) => a.id), outlines: areas.map(areaOutline) }
  const w = grid.grid_width
  const h = grid.grid_height
  return {
    ids: [null],
    outlines: [
      [
        [0, 0],
        [w, 0],
        [w, h],
        [0, h],
      ],
    ],
  }
}

/** A coverage share as the panels write it: "72%", "<1%" for a sliver. */
export function formatCoverage(v: number): string {
  if (v > 0 && v < 0.005) return "<1%"
  if (v < 1 && v > 0.995) return ">99%"
  return `${Math.round(v * 100)}%`
}
