import { Grid } from "./spatial"
import type { Pt, Rect } from "./types"

// Where new cards go on a Diagram built by hand. Pure and deterministic:
// the same map and the same devices always land in the same places, so a
// drop replays exactly under undo and redo.
//
// Positions are card CENTRES, as the Diagram keeps them (React Flow
// `origin` [0.5, 0.5]); the boxes already on the map are top-left
// rectangles, as React Flow reports them.

/** A card's centre, as the view document stores it. */
export type Centre = [number, number]

/** A card that has not been measured yet: as wide as a card gets in
 * Simple mode (`CARD.MAX_W`), so the cards dropped side by side never
 * overlap once measured; a name and three lines tall. Not imported from
 * card-layout.ts, which would pull text measuring into the page. */
export const NEW_CARD = { w: 240, h: 72 } as const
/** Clear space kept around every card placed here. */
export const CARD_GAP = 32

/** The drag payload a device list hands the canvas: device ids, JSON. */
export const DEVICE_IDS_MIME = "application/x-danbyte-device-ids"
/** More than this in one drop is refused (the graph endpoint's cap). */
const MAX_DROP = 10_000

export interface PlaceOptions {
  /** The box each new card is given until it is measured. */
  size?: { w: number; h: number }
  /** Clear space around each new card. */
  gap?: number
}

/** The device ids in a drag payload; nothing for anything else. */
export function parseDragIds(raw: string): string[] {
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(v)) return []
  const out = new Set<string>()
  for (const x of v) {
    if (typeof x === "string" && x && x.length <= 64) out.add(x)
    if (out.size >= MAX_DROP) break
  }
  return [...out]
}

/** The box of a card of `size` centred on `c`. */
export function boxAround(c: Pt, size: { w: number; h: number }): Rect {
  return { x: c.x - size.w / 2, y: c.y - size.h / 2, w: size.w, h: size.h }
}

const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/** The boxes already on the map, and the ones placed so far. */
class Taken {
  private grid = new Grid<Rect>(256)
  private bottom = -Infinity
  private left = Infinity

  constructor(
    boxes: Iterable<Rect>,
    private readonly gap: number
  ) {
    for (const b of boxes) this.add(b)
  }

  add(r: Rect): void {
    this.grid.add(r, r)
    this.bottom = Math.max(this.bottom, r.y + r.h)
    this.left = Math.min(this.left, r.x)
  }

  /** The first box `r` comes within `gap` of, if any. */
  hit(r: Rect): Rect | null {
    const g = this.gap
    const probe = { x: r.x - g, y: r.y - g, w: r.w + 2 * g, h: r.h + 2 * g }
    for (const o of this.grid.near(probe)) if (overlaps(probe, o)) return o
    return null
  }

  free(r: Rect): boolean {
    return !this.hit(r)
  }

  /** The lowest edge of anything on the map, or null when it is empty. */
  get lowest(): number | null {
    return Number.isFinite(this.bottom) ? this.bottom : null
  }

  get leftmost(): number | null {
    return Number.isFinite(this.left) ? this.left : null
  }
}

/** How far out the nearest-spot search looks, in lattice steps. */
const MAX_RING = 80

/**
 * The free spot nearest `target` for a card of `size`, searched ring by
 * ring on a lattice of half a card across and a whole card down. Below is preferred over beside
 * and beside over above (a newcomer hangs under what it is cabled to),
 * then right over left.
 * Past the search, the card goes under everything.
 */
function nearestFree(
  target: Pt,
  size: { w: number; h: number },
  gap: number,
  taken: Taken
): Pt {
  // Half a card across, a whole card down: cards settle into rows.
  const sx = (size.w + gap) / 2
  const sy = size.h + gap
  if (taken.free(boxAround(target, size))) return target
  type Spot = { i: number; j: number; cost: number }
  const better = (a: Spot, b: Spot) =>
    a.cost - b.cost || b.j - a.j || Math.abs(a.i) - Math.abs(b.i) || b.i - a.i
  let best: Spot | null = null
  const step = Math.min(sx, sy)
  for (let r = 1; r <= MAX_RING; r++) {
    // Nothing in this ring or further out can beat what was found.
    if (best && (r * step) ** 2 > best.cost) break
    for (let i = -r; i <= r; i++)
      for (let j = -r; j <= r; j++) {
        if (Math.max(Math.abs(i), Math.abs(j)) !== r) continue
        const dx = i * sx
        // Down counts twice as much as across, so a row fills before
        // the next one starts.
        const dy = j * sy * 2
        // Below is cheapest, level beside it dearer, above dearest: the
        // cards cabled to one hang under it in rows.
        const cost = (dx * dx + dy * dy) * (j > 0 ? 1 : j === 0 ? 3 : 8)
        const spot = { i, j, cost }
        if (best && better(spot, best) >= 0) continue
        const c = { x: target.x + i * sx, y: target.y + j * sy }
        if (taken.free(boxAround(c, size))) best = spot
      }
  }
  if (best) return { x: target.x + best.i * sx, y: target.y + best.j * sy }
  const low = taken.lowest ?? target.y
  return { x: target.x, y: low + gap + size.h / 2 }
}

const centre = (p: Pt): Centre => [Math.round(p.x), Math.round(p.y)]

/**
 * Cards dropped at `at` (canvas coordinates): the first centred on the
 * pointer, the rest fanned out right and down in a small square grid.
 * A slot that would overlap a card already there moves to the nearest
 * free spot instead. Returns each id's centre.
 */
export function dropPlacement(
  ids: readonly string[],
  at: Pt,
  occupied: Iterable<Rect>,
  opts: PlaceOptions = {}
): Record<string, Centre> {
  const size = opts.size ?? NEW_CARD
  const gap = opts.gap ?? CARD_GAP
  const taken = new Taken(occupied, gap)
  const cols = Math.max(1, Math.ceil(Math.sqrt(ids.length)))
  const out: Record<string, Centre> = {}
  ids.forEach((id, k) => {
    const slot = {
      x: at.x + (k % cols) * (size.w + gap),
      y: at.y + Math.floor(k / cols) * (size.h + gap),
    }
    const c = nearestFree(slot, size, gap, taken)
    out[id] = centre(c)
    taken.add(boxAround({ x: out[id][0], y: out[id][1] }, size))
  })
  return out
}

/**
 * Cards joining the map because they are cabled to cards already on it
 * ("Add connected devices"): each goes to the free spot nearest the middle
 * of its neighbours, preferring below. `neighbours` holds, per new id, the
 * centres of the cards on the map it is cabled to. One with none lines up
 * in a row under everything. Returns each id's centre.
 */
export function placeNewcomers(
  newIds: readonly string[],
  neighbours: Readonly<Record<string, readonly Pt[]>>,
  occupied: Iterable<Rect>,
  opts: PlaceOptions = {}
): Record<string, Centre> {
  const size = opts.size ?? NEW_CARD
  const gap = opts.gap ?? CARD_GAP
  const taken = new Taken(occupied, gap)
  const out: Record<string, Centre> = {}
  const loose: string[] = []
  for (const id of newIds) {
    const pts = neighbours[id] ?? []
    if (!pts.length) {
      loose.push(id)
      continue
    }
    const mid = {
      x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
      y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
    }
    const c = nearestFree(mid, size, gap, taken)
    out[id] = centre(c)
    taken.add(boxAround({ x: out[id][0], y: out[id][1] }, size))
  }
  if (loose.length) {
    // An "inbox" row under the map, left-aligned with it.
    const y = (taken.lowest ?? 0) + gap + size.h / 2
    const x0 = (taken.leftmost ?? 0) + size.w / 2
    const perRow = 8
    loose.forEach((id, k) => {
      const slot = {
        x: x0 + (k % perRow) * (size.w + gap),
        y: y + Math.floor(k / perRow) * (size.h + gap),
      }
      const c = nearestFree(slot, size, gap, taken)
      out[id] = centre(c)
      taken.add(boxAround({ x: out[id][0], y: out[id][1] }, size))
    })
  }
  return out
}

/**
 * Pull overlapping boxes apart, moving as little as it can: boxes are
 * settled top to bottom, left to right, and one that overlaps a box
 * already settled is pushed right or down - whichever is the shorter
 * move - until it is clear by `gap`. Boxes that overlap nothing stay
 * exactly where they are. For arrangements carried over from a view
 * whose cards were smaller. Returns each id's centre.
 */
export function separateOverlaps(
  boxes: Readonly<Record<string, Rect>>,
  opts: { gap?: number } = {}
): Record<string, Centre> {
  const gap = opts.gap ?? CARD_GAP
  const order = Object.entries(boxes).sort(
    ([ia, a], [ib, b]) =>
      a.y + a.h / 2 - (b.y + b.h / 2) ||
      a.x + a.w / 2 - (b.x + b.w / 2) ||
      (ia < ib ? -1 : ia > ib ? 1 : 0)
  )
  const taken = new Taken([], gap)
  const out: Record<string, Centre> = {}
  for (const [id, r] of order) {
    const b = { ...r }
    let settled = false
    for (let guard = 0; guard < 1000; guard++) {
      const hit = taken.hit(b)
      if (!hit) {
        settled = true
        break
      }
      const right = hit.x + hit.w + gap - b.x
      const down = hit.y + hit.h + gap - b.y
      if (right <= down) b.x += right
      else b.y += down
    }
    if (!settled) b.y = (taken.lowest ?? b.y) + gap
    taken.add(b)
    out[id] = [b.x + b.w / 2, b.y + b.h / 2]
  }
  return out
}

/**
 * Boxes that grew where they stand - a device now drawn as its photo -
 * against the rest: nothing moves unless one of `grown` overlaps another
 * box, and then every box is settled by `separateOverlaps`, so whatever
 * the grown box covers moves out of its way. Returns each id's centre,
 * or null when nothing moves.
 */
export function settleGrown(
  boxes: Readonly<Record<string, Rect>>,
  grown: Iterable<string>
): Record<string, Centre> | null {
  const grid = new Grid<{ id: string; r: Rect }>(256)
  for (const [id, r] of Object.entries(boxes)) grid.add(r, { id, r })
  for (const id of grown) {
    const r = boxes[id] as Rect | undefined
    if (r && grid.near(r).some((o) => o.id !== id && overlaps(o.r, r)))
      return separateOverlaps(boxes)
  }
  return null
}
