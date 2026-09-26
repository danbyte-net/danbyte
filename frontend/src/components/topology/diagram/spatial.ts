import type { Pt, Rect } from "./types"

// Small geometry kit for the link planner and the label placer: a uniform
// grid that answers "what is near this box" in time proportional to the
// answer, and exact tests between segments, boxes and turned boxes. Pure.

/** A uniform grid of buckets over the plane. Items are filed under every
 * cell their box touches; `near` returns each item once. */
export class Grid<T> {
  private cells = new Map<number, number[]>()
  private items: T[] = []
  private stamp: number[] = []
  private query = 0

  constructor(private readonly size = 96) {}

  /** A cell's key: coordinates offset into 21 bits each. */
  private key(x: number, y: number): number {
    return (x + 1048576) * 2097152 + (y + 1048576)
  }

  private span(r: Rect): [number, number, number, number] {
    const s = this.size
    return [
      Math.floor(r.x / s),
      Math.floor(r.y / s),
      Math.floor((r.x + r.w) / s),
      Math.floor((r.y + r.h) / s),
    ]
  }

  add(r: Rect, item: T): void {
    const id = this.items.length
    this.items.push(item)
    this.stamp.push(0)
    const [x0, y0, x1, y1] = this.span(r)
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) {
        const k = this.key(x, y)
        const list = this.cells.get(k)
        if (list) list.push(id)
        else this.cells.set(k, [id])
      }
  }

  /** Every item filed under a cell `r` touches, once each. */
  near(r: Rect): T[] {
    const out: T[] = []
    const q = ++this.query
    const [x0, y0, x1, y1] = this.span(r)
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) {
        const list = this.cells.get(this.key(x, y))
        if (!list) continue
        for (const id of list) {
          if (this.stamp[id] === q) continue
          this.stamp[id] = q
          out.push(this.items[id])
        }
      }
    return out
  }
}

/** The box around two points. */
export function segBox(p: Pt, q: Pt, pad = 0): Rect {
  const x = Math.min(p.x, q.x) - pad
  const y = Math.min(p.y, q.y) - pad
  return {
    x,
    y,
    w: Math.abs(p.x - q.x) + 2 * pad,
    h: Math.abs(p.y - q.y) + 2 * pad,
  }
}

export const inflate = (r: Rect, d: number): Rect => ({
  x: r.x - d,
  y: r.y - d,
  w: r.w + 2 * d,
  h: r.h + 2 * d,
})

/** Does the segment p→q pass through the open box `r`? (Touching an edge
 * or running along it is no hit.) Liang-Barsky clipping. */
export function segHitsRect(p: Pt, q: Pt, r: Rect): boolean {
  if (r.w <= 0 || r.h <= 0) return false
  const dx = q.x - p.x
  const dy = q.y - p.y
  let t0 = 0
  let t1 = 1
  const edges: [number, number][] = [
    [-dx, p.x - r.x],
    [dx, r.x + r.w - p.x],
    [-dy, p.y - r.y],
    [dy, r.y + r.h - p.y],
  ]
  for (const [pp, qq] of edges) {
    if (Math.abs(pp) < 1e-12) {
      if (qq <= 0) return false
      continue
    }
    const t = qq / pp
    if (pp < 0) {
      if (t > t1) return false
      if (t > t0) t0 = t
    } else {
      if (t < t0) return false
      if (t < t1) t1 = t
    }
  }
  // A clipped piece of no length only grazes a corner.
  return (t1 - t0) * Math.hypot(dx, dy) > 1e-6
}

/** A box turned `angle` degrees about its centre. */
export interface TurnedBox {
  cx: number
  cy: number
  /** Half width and half height, before the turn. */
  hw: number
  hh: number
  angle: number
}

export function turnedBox(r: Rect, angle = 0): TurnedBox {
  return {
    cx: r.x + r.w / 2,
    cy: r.y + r.h / 2,
    hw: r.w / 2,
    hh: r.h / 2,
    angle,
  }
}

/** The axis-aligned box around a turned box. */
export function turnedBounds(b: TurnedBox): Rect {
  const r = (b.angle * Math.PI) / 180
  const c = Math.abs(Math.cos(r))
  const s = Math.abs(Math.sin(r))
  const ex = b.hw * c + b.hh * s
  const ey = b.hw * s + b.hh * c
  return { x: b.cx - ex, y: b.cy - ey, w: 2 * ex, h: 2 * ey }
}

function axes(b: TurnedBox): [Pt, Pt] {
  const r = (b.angle * Math.PI) / 180
  const c = Math.cos(r)
  const s = Math.sin(r)
  return [
    { x: c, y: s },
    { x: -s, y: c },
  ]
}

/** Do two turned boxes overlap (by more than a hair)? Separating axes. */
export function boxesOverlap(a: TurnedBox, b: TurnedBox): boolean {
  const dx = b.cx - a.cx
  const dy = b.cy - a.cy
  const [a1, a2] = axes(a)
  const [b1, b2] = axes(b)
  for (const ax of [a1, a2, b1, b2]) {
    const ra =
      a.hw * Math.abs(a1.x * ax.x + a1.y * ax.y) +
      a.hh * Math.abs(a2.x * ax.x + a2.y * ax.y)
    const rb =
      b.hw * Math.abs(b1.x * ax.x + b1.y * ax.y) +
      b.hh * Math.abs(b2.x * ax.x + b2.y * ax.y)
    if (Math.abs(dx * ax.x + dy * ax.y) >= ra + rb - 1e-6) return false
  }
  return true
}

/** Does the segment p→q pass through a turned box? */
export function segHitsBox(p: Pt, q: Pt, b: TurnedBox): boolean {
  const [u, v] = axes(b)
  const local = (pt: Pt): Pt => {
    const x = pt.x - b.cx
    const y = pt.y - b.cy
    return { x: x * u.x + y * u.y, y: x * v.x + y * v.y }
  }
  return segHitsRect(local(p), local(q), {
    x: -b.hw,
    y: -b.hh,
    w: 2 * b.hw,
    h: 2 * b.hh,
  })
}
