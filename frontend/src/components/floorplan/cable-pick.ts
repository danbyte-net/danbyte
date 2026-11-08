import { naturalCompare } from "@/lib/natural-sort"

import type { Pt } from "./cable-route"
import type { Box } from "./plan-labels"

// One hit-test for the cable layer: every drawn piece of every cable - its
// lanes, the bundles it is in, its stub, its short-run marker, its end dots
// - as geometry in plan cells, and a click asks which cables lie within a
// few screen px of the pointer. Overlapping elements cannot race for the
// click: the answer is the same whichever is drawn on top.

/** How far from the pointer a cable is picked, screen px. */
export const PICK_PX = 6
/** The same for a finger. */
export const PICK_TOUCH_PX = 12
/** The index's buckets, screen px. */
const BUCKET_PX = 32
/** A segment over more buckets than this is checked on every query. */
const WIDE_BUCKETS = 1024

/** A drawn piece of a cable, in cells. `r`: its half width on screen (px),
 * added to the pick radius. `overTiles`: drawn over the tiles - an end dot
 * on a tile's edge, a short run's marker - and picked there when the
 * pointer is on it, where a lane crossing a tile is the tile's. `dot`: an
 * end's dot, drawn (and so picked) only on a lifted run. `group`: the
 * bundle it draws in. */
export interface PickShape {
  id: string
  pts: readonly Pt[]
  r?: number
  overTiles?: boolean
  dot?: boolean
  group?: string
}

export interface PickHit {
  id: string
  /** Distance from the pointer to the cable's nearest piece, screen px. */
  d: number
  /** The bundles hit that hold it. */
  groups: string[]
}

const segDist = (p: Pt, a: Pt, b: Pt) => {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const l2 = dx * dx + dy * dy
  const t = l2
    ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2))
    : 0
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}

const inBox = (p: Pt, b: Box) =>
  p[0] > b.x && p[0] < b.x + b.w && p[1] > b.y && p[1] < b.y + b.h

/**
 * The shapes in a grid of screen-sized buckets, for one zoom: built once
 * the view holds still, queried on every click and pointer move.
 */
export class CablePickIndex {
  private readonly cell: number
  private readonly buckets = new Map<string, number[]>()
  private readonly wide: number[] = []
  /** Every segment: shape index, then its two points. */
  private readonly segs: { s: number; a: Pt; b: Pt }[] = []

  constructor(
    private readonly shapes: readonly PickShape[],
    private readonly tiles: readonly Box[],
    private readonly pxPerCell: number
  ) {
    this.cell = BUCKET_PX / Math.max(pxPerCell, 1e-9)
    shapes.forEach((sh, s) => {
      const pts = sh.pts
      const pairs: [Pt, Pt][] =
        pts.length === 1
          ? [[pts[0], pts[0]]]
          : pts.slice(1).map((b, i) => [pts[i], b])
      for (const [a, b] of pairs) {
        const n = this.segs.push({ s, a, b }) - 1
        const x0 = Math.floor(Math.min(a[0], b[0]) / this.cell)
        const x1 = Math.floor(Math.max(a[0], b[0]) / this.cell)
        const y0 = Math.floor(Math.min(a[1], b[1]) / this.cell)
        const y1 = Math.floor(Math.max(a[1], b[1]) / this.cell)
        if ((x1 - x0 + 1) * (y1 - y0 + 1) > WIDE_BUCKETS) {
          this.wide.push(n)
          continue
        }
        for (let x = x0; x <= x1; x++)
          for (let y = y0; y <= y1; y++) {
            const k = `${x},${y}`
            const list = this.buckets.get(k)
            if (list) list.push(n)
            else this.buckets.set(k, [n])
          }
      }
    })
  }

  /** The cables within `radiusPx` of `p` (cells), each once. `lifted`:
   * the runs drawn with their end dots (traced, hovered). With the pointer
   * on a tile only what is drawn over it counts, and only under the
   * pointer itself. */
  query(
    p: Pt,
    radiusPx: number,
    lifted: ReadonlySet<string> = new Set()
  ): PickHit[] {
    const onTile = this.tiles.some((b) => inBox(p, b))
    // The widest piece's half width: a bundle's reach past the radius.
    const reach = (radiusPx + 12) / this.pxPerCell
    const x0 = Math.floor((p[0] - reach) / this.cell)
    const x1 = Math.floor((p[0] + reach) / this.cell)
    const y0 = Math.floor((p[1] - reach) / this.cell)
    const y1 = Math.floor((p[1] + reach) / this.cell)
    const seen = new Set<number>()
    const best = new Map<string, PickHit>()
    const check = (n: number) => {
      if (seen.has(n)) return
      seen.add(n)
      const { s, a, b } = this.segs[n]
      const sh = this.shapes[s]
      if (sh.dot && !lifted.has(sh.id)) return
      if (onTile && !sh.overTiles) return
      const d = Math.max(0, segDist(p, a, b) * this.pxPerCell - (sh.r ?? 0))
      if (d > (onTile ? 0 : radiusPx)) return
      const hit = best.get(sh.id)
      if (!hit) {
        best.set(sh.id, { id: sh.id, d, groups: sh.group ? [sh.group] : [] })
        return
      }
      hit.d = Math.min(hit.d, d)
      if (sh.group && !hit.groups.includes(sh.group)) hit.groups.push(sh.group)
    }
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++)
        for (const n of this.buckets.get(`${x},${y}`) ?? []) check(n)
    for (const n of this.wide) check(n)
    return [...best.values()]
  }
}

/** The hits in the chooser's order: nearest first, then by label
 * (naturally), then id - each cable once. */
export function orderHits(
  hits: readonly PickHit[],
  labelOf: (id: string) => string | undefined
): PickHit[] {
  // Within a pixel reads as the same distance: the label decides.
  const q = (d: number) => Math.round(d)
  return [...hits].sort(
    (x, y) =>
      q(x.d) - q(y.d) ||
      naturalCompare(labelOf(x.id), labelOf(y.id)) ||
      (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)
  )
}
