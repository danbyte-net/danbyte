import type { CordCable } from "@/lib/port-plugs"

/**
 * A cable run drawn from a cord (export spec §13 v1.9, docs/dcim/
 * model-packs.md → Cable runs from a cord): where a cord is seated at an
 * end, the run starts at the cord's `cable` empty and keeps its frame - a
 * zip cord's two jackets side by side along the empty's ±X, +Y up - carried
 * along the route without twisting (parallel transport) and turned, at the
 * far end, to meet that end's empty. Corners are rounded to the cord's
 * `min_bend_mm` where the segments leave room. Pure maths on `[x, y, z]`
 * arrays, so it tests without three.js.
 */

export type Vec3 = [number, number, number]

export const sub = (a: Vec3, b: Vec3): Vec3 => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2],
]
export const add = (a: Vec3, b: Vec3): Vec3 => [
  a[0] + b[0],
  a[1] + b[1],
  a[2] + b[2],
]
export const mul = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s]
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
export const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2])
export function unit(a: Vec3): Vec3 {
  const l = len(a)
  return l > 1e-12 ? mul(a, 1 / l) : [0, 0, 0]
}

/** One end's cord, in the run's frame: the `cable` empty's position and
 * axes (+Z along the cable, away from the port; +Y up), the model's scale
 * there, and the cord's `cable:` block. */
export interface CordEnd {
  at: Vec3
  x: Vec3
  y: Vec3
  z: Vec3
  scale: number
  cable: CordCable | null
}

// ── corners ──────────────────────────────────────────────────────────────

/**
 * Round each corner of a polyline with a circular arc of at least
 * `minBendM` radius, or at least `baseT` tangent length (the room's usual
 * fillet), whichever is wider - where the two segments leave room: the arc
 * never uses more than half of a segment it shares with another corner
 * (all of the first or last one), so between two close ports it bends as
 * tightly as it must rather than fail.
 */
export function roundCorners(
  points: readonly Vec3[],
  minBendM: number,
  baseT = 0
): Vec3[] {
  if (points.length < 3) return points.map((p) => [...p] as Vec3)
  const out: Vec3[] = [[...points[0]] as Vec3]
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1]
    const b = points[i]
    const c = points[i + 1]
    const inV = sub(b, a)
    const outV = sub(c, b)
    const inL = len(inV)
    const outL = len(outV)
    if (inL < 1e-9 || outL < 1e-9) continue
    const u = mul(inV, 1 / inL)
    const v = mul(outV, 1 / outL)
    const cos = Math.max(-1, Math.min(1, dot(u, v)))
    const turn = Math.acos(cos)
    if (turn < 1e-3) {
      out.push([...b] as Vec3)
      continue
    }
    const half = Math.tan(turn / 2)
    const want = Math.max(baseT, minBendM * half)
    // A segment shared with another corner gives each half; the first and
    // last segments end free, so their corner may use all of them.
    const inRoom = i === 1 ? inL : inL / 2
    const outRoom = i === points.length - 2 ? outL : outL / 2
    const t = Math.min(want, inRoom, outRoom)
    const s = sub(b, mul(u, t))
    const e = add(b, mul(v, t))
    if (turn > Math.PI - 1e-3) {
      // A full U-turn has no tangent arc: a straight hop.
      out.push(s, e)
      continue
    }
    const r = t / half
    const w = unit(sub(v, u))
    const centre = add(b, mul(w, r / Math.cos(turn / 2)))
    const cs = sub(s, centre)
    const ce = sub(e, centre)
    const steps = Math.max(2, Math.ceil(turn / (Math.PI / 16)))
    const sinPhi = Math.sin(turn)
    for (let k = 0; k <= steps; k++) {
      const f = k / steps
      const p = add(
        centre,
        add(
          mul(cs, Math.sin((1 - f) * turn) / sinPhi),
          mul(ce, Math.sin(f * turn) / sinPhi)
        )
      )
      out.push(p)
    }
  }
  out.push([...points[points.length - 1]] as Vec3)
  return dropClose(out)
}

function dropClose(points: Vec3[], eps = 1e-5): Vec3[] {
  const out: Vec3[] = []
  for (const p of points)
    if (!out.length || len(sub(p, out[out.length - 1])) >= eps) out.push(p)
  if (out.length === 1 && points.length > 1) out.push(points[points.length - 1])
  return out
}

/** The tightest bend radius a polyline makes, from the circle through each
 * three consecutive points (Infinity for a straight line). */
export function tightestBend(points: readonly Vec3[]): number {
  let r = Infinity
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1]
    const b = points[i]
    const c = points[i + 1]
    const ab = len(sub(b, a))
    const bc = len(sub(c, b))
    const ca = len(sub(a, c))
    const area2 = len(cross(sub(b, a), sub(c, a)))
    if (area2 < 1e-12) continue
    r = Math.min(r, (ab * bc * ca) / (2 * area2))
  }
  return r
}

// ── frames ───────────────────────────────────────────────────────────────

/** A frame along a run: `t` along it, `n` up, `x` = n × t to the side. */
export interface Frame {
  t: Vec3
  n: Vec3
  x: Vec3
}

function tangents(points: readonly Vec3[]): Vec3[] {
  const n = points.length
  return points.map((_, i) =>
    unit(sub(points[Math.min(n - 1, i + 1)], points[Math.max(0, i - 1)]))
  )
}

/** Rotate `v` about the unit axis `k` by `a` radians. */
function rotate(v: Vec3, k: Vec3, a: number): Vec3 {
  const c = Math.cos(a)
  const s = Math.sin(a)
  return add(add(mul(v, c), mul(cross(k, v), s)), mul(k, dot(k, v) * (1 - c)))
}

/** `up` made square to `t` (any square direction when it is along it). */
function squareTo(up: Vec3, t: Vec3): Vec3 {
  let n = sub(up, mul(t, dot(up, t)))
  if (len(n) < 1e-6) {
    const alt: Vec3 = Math.abs(t[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
    n = sub(alt, mul(t, dot(alt, t)))
  }
  return unit(n)
}

/**
 * Frames along `points`, the up seeded from `startUp` (the A end's `cable`
 * empty's +Y) and carried by parallel transport (the double-reflection
 * method): no turn about the run's own axis, so a zip cord never
 * corkscrews. With `endUp` (the B end's +Y) the frames are turned evenly
 * along the length to meet it at the end - by the smaller of the two
 * turns, since a zip cord's two jackets look the same either way round.
 */
export function transportFrames(
  points: readonly Vec3[],
  startUp: Vec3,
  endUp?: Vec3 | null
): Frame[] {
  if (points.length < 2) return []
  const ts = tangents(points)
  const ns: Vec3[] = [squareTo(startUp, ts[0])]
  for (let i = 0; i < points.length - 1; i++) {
    const v1 = sub(points[i + 1], points[i])
    const c1 = dot(v1, v1)
    let n = ns[i]
    if (c1 > 1e-18) {
      const rL = sub(n, mul(v1, (2 / c1) * dot(v1, n)))
      const tL = sub(ts[i], mul(v1, (2 / c1) * dot(v1, ts[i])))
      const v2 = sub(ts[i + 1], tL)
      const c2 = dot(v2, v2)
      n = c2 > 1e-18 ? sub(rL, mul(v2, (2 / c2) * dot(v2, rL))) : rL
    }
    ns.push(squareTo(n, ts[i + 1]))
  }
  if (endUp) {
    const last = ns.length - 1
    const want = squareTo(endUp, ts[last])
    let a = Math.atan2(
      dot(cross(ns[last], want), ts[last]),
      dot(ns[last], want)
    )
    if (a > Math.PI / 2) a -= Math.PI
    else if (a < -Math.PI / 2) a += Math.PI
    if (Math.abs(a) > 1e-6) {
      const arc = [0]
      for (let i = 1; i < points.length; i++)
        arc.push(arc[i - 1] + len(sub(points[i], points[i - 1])))
      const total = arc[arc.length - 1] || 1
      for (let i = 1; i < ns.length; i++)
        ns[i] = rotate(ns[i], ts[i], (a * arc[i]) / total)
    }
  }
  return ns.map((n, i) => ({ t: ts[i], n, x: unit(cross(n, ts[i])) }))
}

/** A zip cord's two jackets: the run offset by half the pitch to either
 * side of its frames. */
export function zipcordRails(
  points: readonly Vec3[],
  frames: readonly Frame[],
  pitchM: number
): [Vec3[], Vec3[]] {
  const h = pitchM / 2
  return [
    points.map((p, i) => add(p, mul(frames[i].x, h))),
    points.map((p, i) => sub(p, mul(frames[i].x, h))),
  ]
}

/** The cable block a run draws with: the A end's cord's, else the B
 * end's, else none (a plain tube as before). */
export function runCable(
  a: CordEnd | null | undefined,
  b: CordEnd | null | undefined
): { cable: CordCable; scale: number } | null {
  for (const e of [a, b])
    if (e?.cable) return { cable: e.cable, scale: e.scale }
  return null
}

/** How far a run leaves a cord's `cable` empty along its +Z before it
 * turns (m). */
export const CORD_STUB_M = 0.03

/** The first two points of an end with a cord: the `cable` empty, then a
 * short straight lead along its +Z, so the run continues the stub. */
export function cordLead(end: CordEnd): [Vec3, Vec3] {
  return [[...end.at] as Vec3, add(end.at, mul(unit(end.z), CORD_STUB_M))]
}

// ── where the cords are ──────────────────────────────────────────────────

/**
 * The cords seated in the room, by device and port name: written by each
 * device's drawn plugs (floorplan3d/port-plugs) once their models load,
 * read by the room's cable runs. A plain store - `subscribe` /
 * `getVersion` fit `useSyncExternalStore` - so a run redraws only when an
 * end it uses changes.
 */
export class CordEndStore {
  private byDevice = new Map<string, Map<string, CordEnd>>()
  private sigs = new Map<string, string>()
  private listeners = new Set<() => void>()
  private version = 0

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  getVersion = () => this.version

  /** Replace one device's cords (null or empty: it has none drawn). */
  setDevice(deviceId: string, ends: ReadonlyMap<string, CordEnd> | null) {
    const sig = ends?.size ? endsSignature(ends) : ""
    if ((this.sigs.get(deviceId) ?? "") === sig) return
    if (sig) {
      this.byDevice.set(deviceId, new Map(ends ?? []))
      this.sigs.set(deviceId, sig)
    } else {
      this.byDevice.delete(deviceId)
      this.sigs.delete(deviceId)
    }
    this.version++
    this.listeners.forEach((fn) => fn())
  }

  get(deviceId: string, port: string): CordEnd | null {
    return this.byDevice.get(deviceId)?.get(port) ?? null
  }
}

/** A stable text for a device's cords, to a tenth of a millimetre. */
export function endsSignature(ends: ReadonlyMap<string, CordEnd>): string {
  const r = (v: number) => Math.round(v * 10_000)
  return [...ends.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(
      ([k, e]) =>
        `${k}:${[...e.at, ...e.y, ...e.z].map(r).join(",")}:${r(e.scale)}:${JSON.stringify(e.cable)}`
    )
    .join("|")
}

/** A cord end's signature, for a run's cache key. */
export function endSignature(e: CordEnd | null | undefined): string {
  return e ? endsSignature(new Map([["", e]])) : ""
}
