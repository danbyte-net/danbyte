import type {
  CablePlan,
  DiagramEdgeData,
  Dir,
  End,
  LineType,
  Pt,
  Rect,
  Route,
} from "./types"

// The one place a link's path is computed. The Diagram canvas, the SVG and
// PDF exports and the draw.io writer all draw from these points, so every
// output has the same geometry. Curved lines follow draw.io's `curved=1`
// rule (mxGraph's paintCurvedLine), which is what lets a .drawio file
// reproduce them exactly from its waypoints.

type Tuple = [number, number]

/** How far a cable travels straight out of its port before it may turn.
 * Generous, so a cable clears its own card edge (and its neighbours'
 * ports) before bending sideways instead of jogging across them. */
export const STUB = 14

/** Corner radius of a Diagram elbow. */
export const ELBOW_RADIUS = 6

/** Bendy control-point reach along each end's normal: 0.4 of the
 * distance between the ends, kept within 30..160 px. */
export const BENDY = { K: 0.4, MIN: 30, MAX: 160 } as const

/** An orthogonal path that leaves the source straight (a stub along `sv`),
 * crosses a mid-channel shifted by `off`, then enters the target straight
 * (along `tv`, which points out of the target). */
export function stubbedPts(
  sx: number,
  sy: number,
  sv: Dir,
  tx: number,
  ty: number,
  tv: Dir,
  off: number,
  stub = STUB
): Tuple[] {
  const s1: Tuple = [sx + sv[0] * stub, sy + sv[1] * stub]
  const t1: Tuple = [tx + tv[0] * stub, ty + tv[1] * stub]
  if (sv[0] === 0) {
    const chY = (s1[1] + t1[1]) / 2 + off
    return [[sx, sy], s1, [s1[0], chY], [t1[0], chY], t1, [tx, ty]]
  }
  const chX = (s1[0] + t1[0]) / 2 + off
  return [[sx, sy], s1, [chX, s1[1]], [chX, t1[1]], t1, [tx, ty]]
}

/** An orthogonal path through a layout channel: `b1`/`b2` share an x (a
 * vertical channel) or a y (a horizontal one). The path leaves the source
 * along its own side, crosses the channel, and enters the target along
 * its own side. */
export function channelPts(
  sx: number,
  sy: number,
  sv: Dir,
  tx: number,
  ty: number,
  tv: Dir,
  b1: Tuple,
  b2: Tuple,
  stub = STUB
): Tuple[] {
  const s1: Tuple = [sx + sv[0] * stub, sy + sv[1] * stub]
  const t1: Tuple = [tx + tv[0] * stub, ty + tv[1] * stub]
  const verticalChannel = Math.abs(b1[0] - b2[0]) < Math.abs(b1[1] - b2[1])
  return verticalChannel
    ? [[sx, sy], s1, [b1[0], s1[1]], [b1[0], t1[1]], t1, [tx, ty]]
    : [[sx, sy], s1, [s1[0], b1[1]], [t1[0], b1[1]], t1, [tx, ty]]
}

/** Each interior point of a polyline rounded off: the straight run ends at
 * `p1`, a quadratic through the corner `c` reaches `p2`. */
function corners(
  pts: Tuple[],
  r: number
): { p1: Tuple; c: Tuple; p2: Tuple }[] {
  const dist = (a: Tuple, b: Tuple) => Math.hypot(a[0] - b[0], a[1] - b[1])
  const out: { p1: Tuple; c: Tuple; p2: Tuple }[] = []
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1]
    const cur = pts[i]
    const next = pts[i + 1]
    const dIn = Math.min(r, dist(prev, cur) / 2)
    const dOut = Math.min(r, dist(cur, next) / 2)
    const inLen = dist(prev, cur) || 1
    const outLen = dist(cur, next) || 1
    out.push({
      p1: [
        cur[0] - ((cur[0] - prev[0]) / inLen) * dIn,
        cur[1] - ((cur[1] - prev[1]) / inLen) * dIn,
      ],
      c: cur,
      p2: [
        cur[0] + ((next[0] - cur[0]) / outLen) * dOut,
        cur[1] + ((next[1] - cur[1]) / outLen) * dOut,
      ],
    })
  }
  return out
}

/** Rounded orthogonal-ish path through a list of points. */
export function roundedPath(pts: Tuple[], r: number): string {
  if (pts.length < 2) return ""
  let d = `M ${pts[0][0]},${pts[0][1]}`
  for (const { p1, c, p2 } of corners(pts, r))
    d += ` L ${p1[0]},${p1[1]} Q ${c[0]},${c[1]} ${p2[0]},${p2[1]}`
  const last = pts[pts.length - 1]
  d += ` L ${last[0]},${last[1]}`
  return d
}

/** A number for path data: 0.01 px, and never "-0". */
function num(n: number): number {
  const r = Math.round(n * 100) / 100
  return r === 0 ? 0 : r
}

const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })

/** The quadratic pieces of mxGraph's curved line through `pts` (terminals
 * included): `Q P1 mid(P1,P2) … Q Pn T`. */
function curvedSegs(pts: Pt[]): { c: Pt; to: Pt }[] {
  const n = pts.length
  if (n < 2) return []
  const segs: { c: Pt; to: Pt }[] = []
  for (let i = 1; i < n - 2; i++)
    segs.push({ c: pts[i], to: mid(pts[i], pts[i + 1]) })
  segs.push({ c: pts[n - 2], to: pts[n - 1] })
  return segs
}

/**
 * SVG path data for draw.io's `curved=1` line through `pts`, terminals
 * included: `M S, Q P1 mid(P1,P2), …, Q Pn T` - mxGraph's
 * paintCurvedLine, so a .drawio file with these waypoints draws the same
 * curve.
 */
export function curvedPath(pts: Pt[]): string {
  if (pts.length < 2) return ""
  let d = `M ${num(pts[0].x)},${num(pts[0].y)}`
  for (const { c, to } of curvedSegs(pts))
    d += ` Q ${num(c.x)},${num(c.y)} ${num(to.x)},${num(to.y)}`
  return d
}

/** A bendy line's control-point reach for two ends. */
export function bendyReach(a: Pt, b: Pt): number {
  const dist = Math.hypot(b.x - a.x, b.y - a.y)
  return Math.min(BENDY.MAX, Math.max(BENDY.MIN, BENDY.K * dist))
}

/** A bendy line's two control points, out along each end's normal - `ka`
 * and `kb` px out (both `bendyReach` by default). */
export function bendyControls(
  a: End,
  b: End,
  ka = bendyReach(a, b),
  kb = ka
): [Pt, Pt] {
  return [
    { x: a.x + a.dir[0] * ka, y: a.y + a.dir[1] * ka },
    { x: b.x + b.dir[0] * kb, y: b.y + b.dir[1] * kb },
  ]
}

/** How far along its trunk's axis a breakout leg bends, as on the cable
 * page's fan-out. */
export const FAN_BEND = 0.55

/**
 * A breakout leg's curve from the junction `j` (leaving along the trunk)
 * to a far port facing back at it: both control points `bend` of the way
 * along the trunk's axis (`FAN_BEND`), one level with each end - the cable
 * page's `C c y0, c y1` fan in draw.io's curved rule. Null when the far
 * port does not face back along the axis.
 */
export function fanControls(
  j: End,
  b: End,
  bend: number = FAN_BEND
): [Pt, Pt] | null {
  const [ux, uy] = j.dir
  if (Math.abs(b.dir[0] + ux) > 1e-6 || Math.abs(b.dir[1] + uy) > 1e-6)
    return null
  const along = (b.x - j.x) * ux + (b.y - j.y) * uy
  if (along <= 0) return null
  const k = along * bend
  return [
    { x: j.x + ux * k, y: j.y + uy * k },
    { x: b.x - ux * (along - k), y: b.y - uy * (along - k) },
  ]
}

/** Drop repeated points and straight-through corners from a polyline. */
function simplify(pts: Tuple[]): Tuple[] {
  const out: Tuple[] = []
  for (const p of pts) {
    const last = out.at(-1)
    if (last && last[0] === p[0] && last[1] === p[1]) continue
    const prev = out.at(-2)
    if (last && prev) {
      const ax = last[0] - prev[0]
      const ay = last[1] - prev[1]
      const bx = p[0] - last[0]
      const by = p[1] - last[1]
      // Collinear and still heading the same way: `last` is no corner.
      if (ax * by - ay * bx === 0 && ax * bx + ay * by > 0) out.pop()
    }
    out.push(p)
  }
  return out
}

/** A drawn path as short chords, each with the true tangent (radians) at
 * its two ends - so `at()` reports the curve's direction, not a chord's. */
interface Flat {
  pts: Pt[]
  tans: [number, number][]
}

const QUAD_STEPS = 16

function lineTo(f: Flat, to: Pt) {
  const p = f.pts[f.pts.length - 1]
  const a = Math.atan2(to.y - p.y, to.x - p.x)
  f.pts.push(to)
  f.tans.push([a, a])
}

function quadTo(f: Flat, c: Pt, to: Pt) {
  const p0 = f.pts[f.pts.length - 1]
  const tangent = (t: number, fallback: number) => {
    const dx = 2 * (1 - t) * (c.x - p0.x) + 2 * t * (to.x - c.x)
    const dy = 2 * (1 - t) * (c.y - p0.y) + 2 * t * (to.y - c.y)
    return dx === 0 && dy === 0 ? fallback : Math.atan2(dy, dx)
  }
  for (let s = 1; s <= QUAD_STEPS; s++) {
    const t0 = (s - 1) / QUAD_STEPS
    const t = s / QUAD_STEPS
    const u = 1 - t
    const p = f.pts[f.pts.length - 1]
    const q = {
      x: u * u * p0.x + 2 * u * t * c.x + t * t * to.x,
      y: u * u * p0.y + 2 * u * t * c.y + t * t * to.y,
    }
    const chord = Math.atan2(q.y - p.y, q.x - p.x)
    f.pts.push(q)
    f.tans.push([tangent(t0, chord), tangent(t, chord)])
  }
}

/** Arc-length lookups over a flattened path. `dir` is the direction of a
 * route with no length. */
function sampler(f: Flat, dir: Dir): Pick<Route, "length" | "at"> {
  const { pts, tans } = f
  const cum = [0]
  for (let i = 1; i < pts.length; i++)
    cum.push(
      cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
    )
  const length = cum[cum.length - 1]
  const deg = (r: number) => (r * 180) / Math.PI
  const at = (t: number) => {
    const want = Math.min(1, Math.max(0, t)) * length
    // The first chord with any length that reaches `want`.
    let i = 1
    while (i < pts.length && !(cum[i] > cum[i - 1] && cum[i] >= want)) i++
    if (i === pts.length)
      return {
        x: pts[0].x,
        y: pts[0].y,
        angle: deg(Math.atan2(dir[1], dir[0])),
      }
    const a = pts[i - 1]
    const b = pts[i]
    const k = (want - cum[i - 1]) / (cum[i] - cum[i - 1])
    const [t0, t1] = tans[i - 1]
    // The short way round between the chord's end tangents.
    const turn = Math.atan2(Math.sin(t1 - t0), Math.cos(t1 - t0))
    return {
      x: a.x + (b.x - a.x) * k,
      y: a.y + (b.y - a.y) * k,
      angle: deg(t0 + turn * k),
    }
  }
  return { length, at }
}

/**
 * A link's planned cables, while both its ends are where they were
 * planned for; undefined once either has moved (the unplanned line is
 * drawn until the drop plans it again). `s` and `t` are the source and
 * target boxes.
 */
export function planOf(
  d: Pick<DiagramEdgeData, "plan" | "planAt">,
  s: Rect,
  t: Rect
): CablePlan[] | undefined {
  if (!d.plan || !d.planAt) return undefined
  const [sx, sy, tx, ty] = d.planAt
  const near = (a: number, b: number) => Math.abs(a - b) < 0.5
  return near(s.x, sx) && near(s.y, sy) && near(t.x, tx) && near(t.y, ty)
    ? d.plan
    : undefined
}

/** The direction a route through `pts` leaves in (for one with no
 * length). */
export function leaves(pts: readonly Pt[]): Dir {
  if (pts.length < 2) return [1, 0]
  const [p, q] = pts
  const l = Math.hypot(q.x - p.x, q.y - p.y) || 1
  return [(q.x - p.x) / l, (q.y - p.y) / l]
}

export interface RouteOptions {
  /** Elbow: the node-avoiding channel from the layout (two points sharing
   * an x or a y). */
  wp?: Pt[]
  /** Elbow without a channel: shift the mid-channel by this many px, so
   * lines leaving one Simple-mode midpoint separate. */
  lane?: number
}

/**
 * A route through given points, terminals included, drawn as `kind`:
 * `elbow` rounds each corner, `bendy` and `cyclical` follow draw.io's
 * curved rule through them as control points, `straight` joins them.
 * `dir` is the direction of a route with no length.
 */
export function routeThrough(kind: LineType, pts: Pt[], dir: Dir): Route {
  const A = pts[0]
  if (kind === "elbow") {
    const tup = simplify(pts.map((p): Tuple => [p.x, p.y]))
    const flat: Flat = { pts: [{ x: tup[0][0], y: tup[0][1] }], tans: [] }
    for (const { p1, c, p2 } of corners(tup, ELBOW_RADIUS)) {
      lineTo(flat, { x: p1[0], y: p1[1] })
      quadTo(flat, { x: c[0], y: c[1] }, { x: p2[0], y: p2[1] })
    }
    const last = tup[tup.length - 1]
    lineTo(flat, { x: last[0], y: last[1] })
    return {
      kind,
      pts: tup.map(([x, y]) => ({ x, y })),
      d: roundedPath(tup, ELBOW_RADIUS),
      ...sampler(flat, dir),
    }
  }
  if ((kind === "bendy" || kind === "cyclical") && pts.length > 2) {
    const flat: Flat = { pts: [A], tans: [] }
    for (const { c, to } of curvedSegs(pts)) quadTo(flat, c, to)
    return { kind, pts, d: curvedPath(pts), ...sampler(flat, dir) }
  }
  const flat: Flat = { pts: [A], tans: [] }
  for (const p of pts.slice(1)) lineTo(flat, p)
  return {
    kind,
    pts,
    d:
      `M ${num(A.x)},${num(A.y)}` +
      pts
        .slice(1)
        .map((p) => ` L ${num(p.x)},${num(p.y)}`)
        .join(""),
    ...sampler(flat, dir),
  }
}

/**
 * A link's route between two ends (exit points with outward normals),
 * unplanned - what a line draws while a card is dragged, and what the
 * legacy tabs' export draws.
 * - `straight`: `[A, B]`.
 * - `elbow`: leaves and enters along the ends' normals (a `STUB` each),
 *   crosses a channel, corners rounded to `ELBOW_RADIUS`.
 * - `bendy`: draw.io's curved line through a control point out along each
 *   normal (`bendyControls`).
 * - `cyclical`: drawn as bendy until arcs land; the kind is kept.
 *
 * `at(t)` walks the drawn path (rounded corners and curves included) by
 * arc length.
 */
export function linkRoute(
  kind: LineType,
  a: End,
  b: End,
  opts: RouteOptions = {}
): Route {
  const A: Pt = { x: a.x, y: a.y }
  const B: Pt = { x: b.x, y: b.y }
  if (kind === "elbow") {
    const wp = opts.wp ?? []
    const raw =
      wp.length >= 2
        ? channelPts(
            a.x,
            a.y,
            a.dir,
            b.x,
            b.y,
            b.dir,
            [wp[0].x, wp[0].y],
            [wp[1].x, wp[1].y]
          )
        : stubbedPts(a.x, a.y, a.dir, b.x, b.y, b.dir, opts.lane ?? 0)
    return routeThrough(
      kind,
      raw.map(([x, y]) => ({ x, y })),
      a.dir
    )
  }
  if (kind === "bendy" || kind === "cyclical")
    return routeThrough(kind, [A, ...bendyControls(a, b), B], a.dir)
  return routeThrough(kind, [A, B], a.dir)
}
