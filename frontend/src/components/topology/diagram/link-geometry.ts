import type {
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

/** A bendy line's two control points, out along each end's normal. */
export function bendyControls(a: End, b: End): [Pt, Pt] {
  const dist = Math.hypot(b.x - a.x, b.y - a.y)
  const k = Math.min(BENDY.MAX, Math.max(BENDY.MIN, BENDY.K * dist))
  return [
    { x: a.x + a.dir[0] * k, y: a.y + a.dir[1] * k },
    { x: b.x + b.dir[0] * k, y: b.y + b.dir[1] * k },
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
 * An elbow link's node-avoiding channel, while both cards are still where
 * it was routed for; undefined once either has moved (the plain elbow is
 * drawn until the drop re-routes it) and for other line types. `s` and `t`
 * are the source and target boxes.
 */
export function elbowChannel(
  d: Pick<DiagramEdgeData, "line" | "wp" | "wpAt">,
  s: Rect,
  t: Rect
): Pt[] | undefined {
  if (d.line !== "elbow" || !d.wp || !d.wpAt) return undefined
  const [sx, sy, tx, ty] = d.wpAt
  const near = (a: number, b: number) => Math.abs(a - b) < 0.5
  return near(s.x, sx) && near(s.y, sy) && near(t.x, tx) && near(t.y, ty)
    ? d.wp
    : undefined
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
 * A link's route between two ends (exit points with outward normals).
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
    const pts = simplify(raw)
    const flat: Flat = { pts: [A], tans: [] }
    for (const { p1, c, p2 } of corners(pts, ELBOW_RADIUS)) {
      lineTo(flat, { x: p1[0], y: p1[1] })
      quadTo(flat, { x: c[0], y: c[1] }, { x: p2[0], y: p2[1] })
    }
    lineTo(flat, B)
    return {
      kind,
      pts: pts.map(([x, y]) => ({ x, y })),
      d: roundedPath(pts, ELBOW_RADIUS),
      ...sampler(flat, a.dir),
    }
  }

  if (kind === "bendy" || kind === "cyclical") {
    const pts = [A, ...bendyControls(a, b), B]
    const flat: Flat = { pts: [A], tans: [] }
    for (const { c, to } of curvedSegs(pts)) quadTo(flat, c, to)
    return { kind, pts, d: curvedPath(pts), ...sampler(flat, a.dir) }
  }

  const flat: Flat = { pts: [A], tans: [] }
  lineTo(flat, B)
  return {
    kind,
    pts: [A, B],
    d: `M ${num(A.x)},${num(A.y)} L ${num(B.x)},${num(B.y)}`,
    ...sampler(flat, a.dir),
  }
}
