import { chooseSides, sideLength } from "./anchors"
import type { Obstacles } from "./lanes"
import { segHitsRect } from "./spatial"
import type { Pt, Rect, Side } from "./types"

// Cyclical lines: an arc that loops round the cards between its two ends
// instead of crossing them - typically two cards of one row with others
// between them.
//
// Both ends leave through the side the arc bulges to (the top of a row,
// say). The arc is draw.io's curved line through two control points on an
// apex line across the span, `[A, P1, P2, B]` with P1 and P2 `INSET` of
// the span in from each end (mxGraph's paintCurvedLine: `M A, Q P1
// mid(P1,P2), Q P2 B`), so the canvas, the SVG and the .drawio file draw
// one curve. The curve touches the apex line at its middle.
//
// The apex line is raised until `SAMPLES` points along the curve clear
// every card within its span by `CLEAR` px. Arcs are solved shortest
// first, and one whose span holds another's goes round it, `NEST` px
// outside. Pure.

export const ARC = {
  /** Points along the curve checked against the cards. */
  SAMPLES: 64,
  /** How far an arc keeps from a card it passes. */
  CLEAR: 16,
  /** The least gap between an arc and one nested inside it. */
  NEST: 12,
  /** The control points sit this fraction of the span in from each end. */
  INSET: 0.15,
  /** The least apex height: `MIN` px plus `RISE` of the span. */
  MIN: 24,
  RISE: 0.12,
  /** The most: `CAP_SPAN` of the span plus `CAP` px. */
  CAP_SPAN: 0.9,
  CAP: 200,
} as const

/** The axis an arc runs along: `x` for cards side by side (it bulges up
 * or down), `y` for stacked cards (left or right). */
export type ArcAxis = "x" | "y"

/** The way an arc bulges across its axis: -1 up (or left), 1 down (or
 * right). */
export type ArcSide = 1 | -1

/** Frame coordinates: `u` along the axis, `v` across it. */
interface UV {
  u: number
  v: number
}

const toUV = (p: Pt, axis: ArcAxis): UV =>
  axis === "x" ? { u: p.x, v: p.y } : { u: p.y, v: p.x }
const fromUV = (u: number, v: number, axis: ArcAxis): Pt =>
  axis === "x" ? { x: u, y: v } : { x: v, y: u }

/** A box in frame coordinates. */
interface BoxUV {
  u0: number
  u1: number
  v0: number
  v1: number
}

const boxUV = (r: Rect, axis: ArcAxis): BoxUV =>
  axis === "x"
    ? { u0: r.x, u1: r.x + r.w, v0: r.y, v1: r.y + r.h }
    : { u0: r.y, u1: r.y + r.h, v0: r.x, v1: r.x + r.w }

const centre = (r: Rect): Pt => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })

/** The axis two cards' arc runs along: the one they are further apart on. */
export function arcAxis(a: Rect, b: Rect): ArcAxis {
  const ca = centre(a)
  const cb = centre(b)
  return Math.abs(cb.x - ca.x) >= Math.abs(cb.y - ca.y) ? "x" : "y"
}

/** The card side an arc's ends leave through. */
export function arcSide(axis: ArcAxis, s: ArcSide): Side {
  return axis === "x" ? (s < 0 ? "T" : "B") : s < 0 ? "L" : "R"
}

/** Are two cards level on the axis - one row (or column): their centres
 * less than half the smaller card apart across it? */
export function level(a: Rect, b: Rect, axis: ArcAxis): boolean {
  const ca = toUV(centre(a), axis)
  const cb = toUV(centre(b), axis)
  const ea = axis === "x" ? a.h : a.w
  const eb = axis === "x" ? b.h : b.w
  return Math.abs(ca.v - cb.v) < Math.min(ea, eb) / 2
}

/** Where a side's midpoint is. */
function sideMid(r: Rect, side: Side): Pt {
  const half = sideLength(r, side) / 2
  switch (side) {
    case "T":
      return { x: r.x + half, y: r.y }
    case "B":
      return { x: r.x + half, y: r.y + r.h }
    case "L":
      return { x: r.x, y: r.y + half }
    case "R":
      return { x: r.x + r.w, y: r.y + half }
  }
}

/** Does the straight line between two cards' facing sides cross a third
 * card? */
export function crossesCard(
  a: Rect,
  b: Rect,
  obs: Obstacles,
  own: readonly string[]
): boolean {
  const [sa, sb] = chooseSides(a, b)
  const p = sideMid(a, sa)
  const q = sideMid(b, sb)
  const box = {
    x: Math.min(p.x, q.x),
    y: Math.min(p.y, q.y),
    w: Math.abs(p.x - q.x),
    h: Math.abs(p.y - q.y),
  }
  for (const { id, r } of obs.near(box))
    if (!own.includes(id) && segHitsRect(p, q, r)) return true
  return false
}

/** An arc's two control points for ends `a` and `b` and an apex line at
 * `v` across the axis. */
export function arcControls(a: Pt, b: Pt, axis: ArcAxis, v: number): [Pt, Pt] {
  const A = toUV(a, axis)
  const B = toUV(b, axis)
  const d = B.u - A.u
  return [
    fromUV(A.u + ARC.INSET * d, v, axis),
    fromUV(A.u + (1 - ARC.INSET) * d, v, axis),
  ]
}

/** One arc to solve. */
export interface ArcAsk {
  key: string
  a: Pt
  b: Pt
  axis: ArcAxis
  s: ArcSide
  /** The nodes the arc joins: never obstacles to it. */
  own: readonly string[]
}

export interface ArcResult {
  /** Terminals and the two control points: `[A, P1, P2, B]`. */
  pts: Pt[]
  /** The apex line's height past the outer of the two ends, px. */
  h: number
  /** False when even the highest arc allowed still touches a card. */
  clear: boolean
}

/** A solved arc as the ones solved after it see it. */
interface Placed {
  axis: ArcAxis
  s: ArcSide
  u0: number
  u1: number
  base: number
  /** The middle of its curve, sampled: `(u, v)` pairs. */
  mid: UV[]
}

/** The curve sampled at `SAMPLES` points between its ends, each as `u`
 * and `v = base + c * V` for an apex line at `V`: `u` does not move with
 * the apex, and `v` moves with it linearly. */
interface Samples {
  u: Float64Array
  base: Float64Array
  c: Float64Array
}

function samples(A: UV, B: UV): Samples {
  const n = ARC.SAMPLES - 1
  const half = ARC.SAMPLES / 2
  const u = new Float64Array(n)
  const base = new Float64Array(n)
  const c = new Float64Array(n)
  const d = B.u - A.u
  const p1 = A.u + ARC.INSET * d
  const p2 = A.u + (1 - ARC.INSET) * d
  const m = (p1 + p2) / 2
  for (let k = 1; k <= n; k++) {
    const i = k - 1
    if (k <= half) {
      // A → mid(P1, P2), control P1; P1 and the mid sit on the apex line.
      const t = k / half
      const w = (1 - t) * (1 - t)
      u[i] = w * A.u + 2 * t * (1 - t) * p1 + t * t * m
      base[i] = w * A.v
      c[i] = 1 - w
    } else {
      // mid(P1, P2) → B, control P2.
      const t = (k - half) / half
      const w = t * t
      u[i] = (1 - t) * (1 - t) * m + 2 * t * (1 - t) * p2 + w * B.u
      base[i] = w * B.v
      c[i] = 1 - w
    }
  }
  return { u, base, c }
}

/** The curve's `v` at `u` (linear between samples) as `[base, c]`, or null
 * outside the samples. */
function vAt(s: Samples, u: number): [number, number] | null {
  const n = s.u.length
  const up = s.u[n - 1] >= s.u[0]
  for (let k = 0; k < n - 1; k++) {
    const u0 = s.u[k]
    const u1 = s.u[k + 1]
    const inside = up ? u0 <= u && u <= u1 : u1 <= u && u <= u0
    if (!inside) continue
    const f = u1 === u0 ? 0 : (u - u0) / (u1 - u0)
    return [
      s.base[k] + (s.base[k + 1] - s.base[k]) * f,
      s.c[k] + (s.c[k + 1] - s.c[k]) * f,
    ]
  }
  return null
}

/** How far a card keeps the arc off: `CLEAR`, less where an end of the
 * arc sits closer to it than that (tight rows), so the end itself is
 * never inside. */
function margin(r: BoxUV, A: UV, B: UV): number {
  const gap = (p: UV) =>
    Math.max(r.u0 - p.u, p.u - r.u1, r.v0 - p.v, p.v - r.v1)
  return Math.max(0, Math.min(ARC.CLEAR, gap(A) - 2, gap(B) - 2))
}

/** Is `inner` an arc this one must go round: same axis and way, most of
 * its span inside this one's, starting on this one's row? */
function nests(
  p: Placed,
  axis: ArcAxis,
  s: ArcSide,
  u0: number,
  u1: number,
  base: number
) {
  if (p.axis !== axis || p.s !== s) return false
  const lap = Math.min(u1, p.u1) - Math.max(u0, p.u0)
  return (
    lap >= 0.8 * (p.u1 - p.u0) &&
    u1 - u0 >= p.u1 - p.u0 - 1 &&
    Math.abs(p.base - base) < 40
  )
}

/**
 * One arc: the lowest apex line that keeps every sample `CLEAR` px off the
 * cards within its span (bar its own) and `NEST` px outside the arcs in
 * `inner` it holds. Capped at `CAP_SPAN` of the span plus `CAP`; `clear`
 * says whether the cap was enough.
 */
export function solveArc(
  ask: ArcAsk,
  obs: Obstacles,
  inner: readonly Placed[] = []
): ArcResult & { placed: Placed } {
  const { axis, s } = ask
  const A = toUV(ask.a, axis)
  const B = toUV(ask.b, axis)
  const u0 = Math.min(A.u, B.u)
  const u1 = Math.max(A.u, B.u)
  const span = u1 - u0
  const base = s < 0 ? Math.min(A.v, B.v) : Math.max(A.v, B.v)
  const S = samples(A, B)
  const holds = inner.filter((p) => nests(p, axis, s, u0, u1, base))
  let V = base + s * (ARC.MIN + ARC.RISE * span)
  const cap = base + s * (ARC.CAP_SPAN * span + ARC.CAP)
  let clear = true
  const beyond = (x: number, y: number) => s * (x - y) > 0
  for (let round = 0; round < 48; round++) {
    // The cards the curve can reach at this height.
    const lo = Math.min(base, V) - ARC.CLEAR
    const hi = Math.max(base, V) + ARC.CLEAR
    const area = fromUVRect(u0 - ARC.CLEAR, u1 + ARC.CLEAR, lo, hi, axis)
    let need = V
    for (const { id, r } of obs.near(area)) {
      if (ask.own.includes(id)) continue
      const b0 = boxUV(r, axis)
      const m = margin(b0, A, B)
      const b = { u0: b0.u0 - m, u1: b0.u1 + m, v0: b0.v0 - m, v1: b0.v1 + m }
      if (b.u1 <= u0 || b.u0 >= u1) continue
      const face = s < 0 ? b.v0 : b.v1
      for (let k = 0; k < S.u.length; k++) {
        const u = S.u[k]
        if (u <= b.u0 || u >= b.u1) continue
        const v = S.base[k] + S.c[k] * V
        if (v <= b.v0 || v >= b.v1) continue
        const want = (face - S.base[k]) / S.c[k]
        if (beyond(want, need)) need = want
      }
    }
    for (const p of holds)
      for (const q of p.mid) {
        const at = vAt(S, q.u)
        if (!at || at[1] <= 1e-6) continue
        const v = at[0] + at[1] * V
        if (s * (v - q.v) >= ARC.NEST) continue
        const want = (q.v + s * ARC.NEST - at[0]) / at[1]
        if (beyond(want, need)) need = want
      }
    if (need === V) break
    V = need + s * 0.5
    if (beyond(V, cap)) {
      V = cap
      clear = false
      break
    }
  }
  const [p1, p2] = arcControls(ask.a, ask.b, axis, V)
  const mid: UV[] = []
  const n = S.u.length
  for (let k = Math.floor(n * 0.2); k <= Math.ceil(n * 0.8); k++)
    mid.push({ u: S.u[k], v: S.base[k] + S.c[k] * V })
  return {
    pts: [ask.a, p1, p2, ask.b],
    h: s * (V - base),
    clear,
    placed: { axis, s, u0, u1, base, mid },
  }
}

function fromUVRect(
  u0: number,
  u1: number,
  v0: number,
  v1: number,
  axis: ArcAxis
): Rect {
  return axis === "x"
    ? { x: u0, y: v0, w: u1 - u0, h: v1 - v0 }
    : { x: v0, y: u0, w: v1 - v0, h: u1 - u0 }
}

/** Solve arcs together: shortest span first, so each longer arc that
 * holds a shorter one goes round it. */
export function solveArcs(
  asks: readonly ArcAsk[],
  obs: Obstacles
): Map<string, ArcResult> {
  const spanOf = (a: ArcAsk) => {
    const A = toUV(a.a, a.axis)
    const B = toUV(a.b, a.axis)
    return Math.abs(B.u - A.u)
  }
  const order = [...asks].sort(
    (x, y) =>
      spanOf(x) - spanOf(y) || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0)
  )
  const placed: Placed[] = []
  const out = new Map<string, ArcResult>()
  for (const ask of order) {
    const { placed: p, ...res } = solveArc(ask, obs, placed)
    placed.push(p)
    out.set(ask.key, res)
  }
  return out
}

/**
 * Should a cyclical link between cards `a` and `b` draw as an arc, and
 * which way? `always` (the link's own line) says yes wherever it runs;
 * the view's default only for cards level on one row or column whose
 * straight line would cross a card. The side is `flip` when given, else
 * the one with the lower arc - above (or left) on a tie. A link's own arc
 * between cards on no one row or column may go round the other way too -
 * past their sides rather than over their tops - where only that way is
 * clear of the cards between.
 */
export function arcFor(
  a: Rect,
  b: Rect,
  o: {
    always: boolean
    flip?: ArcSide
    obs: Obstacles
    own: readonly string[]
  }
): { axis: ArcAxis; s: ArcSide } | null {
  const axis = arcAxis(a, b)
  const ca = centre(a)
  const cb = centre(b)
  if (ca.x === cb.x && ca.y === cb.y) return null
  if (!o.always && !(level(a, b, axis) && crossesCard(a, b, o.obs, o.own)))
    return null
  const h = (x: ArcAxis, s: ArcSide) => {
    const side = arcSide(x, s)
    const r = solveArc(
      {
        key: "",
        a: sideMid(a, side),
        b: sideMid(b, side),
        axis: x,
        s,
        own: o.own,
      },
      o.obs
    )
    return r.clear ? r.h : r.h + 1e6
  }
  const other: ArcAxis = axis === "x" ? "y" : "x"
  const axes: ArcAxis[] =
    o.always && !level(a, b, axis) ? [axis, other] : [axis]
  const sides: ArcSide[] = o.flip ? [o.flip] : [-1, 1]
  let best: { axis: ArcAxis; s: ArcSide; h: number } | null = null
  for (const x of axes)
    for (const s of sides) {
      const v = h(x, s)
      // The natural axis wins ties; above (or left) before below.
      if (!best || v < best.h - 1e-6) best = { axis: x, s, h: v }
    }
  return { axis: best!.axis, s: best!.s }
}
