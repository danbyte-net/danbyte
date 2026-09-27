import type { Pt, Rect } from "./types"

// Small geometry kit for the link planner and the label placer: a uniform
// grid that answers "what is near this box" in time proportional to the
// answer, and exact tests between segments, boxes and turned boxes. Pure.

/** A run of grid cells: first and last column, first and last row. */
export type CellSpan = [number, number, number, number]

/** Do two runs of cells share one? */
export const spansMeet = (a: CellSpan, b: CellSpan): boolean =>
  a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3]

/** A uniform grid of buckets over the plane. Items are filed under every
 * cell their box touches; `near` returns each item once. */
export class Grid<T> {
  private cells = new Map<number, number[]>()
  private items: T[] = []
  /** Each item's box, as filed. */
  private boxes: Rect[] = []
  private stamp: number[] = []
  private query = 0
  /** The items by column and by row of cells, each ordered along it -
   * built on the first thin query (`touching`). */
  private strips: {
    cols: Map<number, number[]>
    rows: Map<number, number[]>
    maxW: number
    maxH: number
  } | null = null

  /** Told the cells of every query while set (`watch`). */
  private watcher: ((span: CellSpan) => void) | null = null

  constructor(private readonly size = 96) {}

  /** Report the cells every query looks at to `fn` - what the answers
   * depend on - until called with null. */
  watch(fn: ((span: CellSpan) => void) | null): void {
    this.watcher = fn
  }

  /** The cells a box touches: first and last column, first and last
   * row. */
  cellsOf(r: Rect): CellSpan {
    return this.span(r)
  }

  /** A cell's key: coordinates offset into 21 bits each. */
  private key(x: number, y: number): number {
    return (x + 1048576) * 2097152 + (y + 1048576)
  }

  private span(r: Rect): CellSpan {
    const s = this.size
    return [
      Math.floor(r.x / s),
      Math.floor(r.y / s),
      Math.floor((r.x + r.w) / s),
      Math.floor((r.y + r.h) / s),
    ]
  }

  private file(id: number, x: number, y: number): void {
    const k = this.key(x, y)
    const list = this.cells.get(k)
    if (list) list.push(id)
    else this.cells.set(k, [id])
  }

  private push(item: T, box: Rect): number {
    this.items.push(item)
    this.boxes.push(box)
    this.stamp.push(0)
    this.strips = null
    return this.items.length - 1
  }

  add(r: Rect, item: T): void {
    const id = this.push(item, r)
    const [x0, y0, x1, y1] = this.span(r)
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) this.file(id, x, y)
  }

  /** A segment, `pad` px thick each side, filed under the cells it passes
   * through rather than every cell of its box: a long diagonal line is
   * near only what lies along it. */
  addSegment(p: Pt, q: Pt, pad: number, item: T): void {
    const id = this.push(item, segBox(p, q, pad))
    const s = this.size
    // A hair more than asked, so rounding never drops a cell.
    const m = pad + 1e-6 * s
    const dx = q.x - p.x
    const dy = q.y - p.y
    const xa = Math.min(p.x, q.x) - m
    const xb = Math.max(p.x, q.x) + m
    const ya = Math.min(p.y, q.y)
    const yb = Math.max(p.y, q.y)
    const clamp = (t: number) => Math.min(1, Math.max(0, t))
    for (let cx = Math.floor(xa / s); cx <= Math.floor(xb / s); cx++) {
      // The segment's run over this column of cells, padded.
      let lo = ya
      let hi = yb
      if (Math.abs(dx) > 1e-9) {
        const t0 = clamp((Math.max(xa, cx * s) - m - p.x) / dx)
        const t1 = clamp((Math.min(xb, (cx + 1) * s) + m - p.x) / dx)
        lo = Math.min(p.y + dy * t0, p.y + dy * t1)
        hi = Math.max(p.y + dy * t0, p.y + dy * t1)
      }
      for (
        let cy = Math.floor((lo - m) / s);
        cy <= Math.floor((hi + m) / s);
        cy++
      )
        this.file(id, cx, cy)
    }
  }

  /** Every item filed under a cell `r` touches, once each. */
  near(r: Rect): T[] {
    const out: T[] = []
    const q = ++this.query
    const [x0, y0, x1, y1] = this.span(r)
    this.watcher?.([x0, y0, x1, y1])
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

  private stripsNow() {
    if (this.strips) return this.strips
    const s = this.size
    const cols = new Map<number, number[]>()
    const rows = new Map<number, number[]>()
    let maxW = 0
    let maxH = 0
    this.boxes.forEach((b, id) => {
      maxW = Math.max(maxW, b.w)
      maxH = Math.max(maxH, b.h)
      for (let x = Math.floor(b.x / s); x <= Math.floor((b.x + b.w) / s); x++)
        (cols.get(x) ?? cols.set(x, []).get(x)!).push(id)
      for (let y = Math.floor(b.y / s); y <= Math.floor((b.y + b.h) / s); y++)
        (rows.get(y) ?? rows.set(y, []).get(y)!).push(id)
    })
    const boxes = this.boxes
    for (const list of cols.values())
      list.sort((a, b) => boxes[a].y - boxes[b].y)
    for (const list of rows.values())
      list.sort((a, b) => boxes[a].x - boxes[b].x)
    return (this.strips = { cols, rows, maxW, maxH })
  }

  /**
   * Every item whose box meets `r` (edges included), once each: what
   * `near` finds that can matter, without the rest of the cells' items.
   * A thin `r` - a run of a route - looks along its column or row of
   * cells instead of every cell it crosses.
   */
  touching(r: Rect): T[] {
    const s = this.size
    const vertical = r.w <= s
    const out: T[] = []
    const q = ++this.query
    this.watcher?.(this.span(r))
    const meets = (b: Rect) =>
      b.x <= r.x + r.w &&
      b.x + b.w >= r.x &&
      b.y <= r.y + r.h &&
      b.y + b.h >= r.y
    if (!vertical && r.h > s) {
      const [x0, y0, x1, y1] = this.span(r)
      for (let x = x0; x <= x1; x++)
        for (let y = y0; y <= y1; y++)
          for (const id of this.cells.get(this.key(x, y)) ?? []) {
            if (this.stamp[id] === q) continue
            this.stamp[id] = q
            if (meets(this.boxes[id])) out.push(this.items[id])
          }
      return out
    }
    const { cols, rows, maxW, maxH } = this.stripsNow()
    const [lo, hi] = vertical ? [r.x, r.x + r.w] : [r.y, r.y + r.h]
    const [from, to] = vertical ? [r.y, r.y + r.h] : [r.x, r.x + r.w]
    const reach = vertical ? maxH : maxW
    for (let c = Math.floor(lo / s); c <= Math.floor(hi / s); c++) {
      const list = (vertical ? cols : rows).get(c)
      if (!list) continue
      // The first box that could reach `from`, by bisection.
      const start = (id: number) =>
        vertical ? this.boxes[id].y : this.boxes[id].x
      let a = 0
      let z = list.length
      while (a < z) {
        const m = (a + z) >> 1
        if (start(list[m]) < from - reach) a = m + 1
        else z = m
      }
      for (let i = a; i < list.length; i++) {
        const id = list[i]
        const b = this.boxes[id]
        if (start(id) > to) break
        if (this.stamp[id] === q || !meets(b)) continue
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
