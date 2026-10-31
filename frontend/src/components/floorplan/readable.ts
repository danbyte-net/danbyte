import type { FloorPlanTile } from "@/lib/api"

import type { CableStub } from "./cable-draw"
import type { Pt } from "./cable-route"

// Object size (Display menu): Real draws every placed object at its true
// size; Readable keeps it readable from afar - a symbol never smaller than
// SYMBOL_PX on screen (SYMBOL_MM on paper), centred on its true place, and
// a name at a constant size, thinned where names would overlap. Nothing
// here changes a tile's saved geometry: the grown symbol is drawn only.

export const OBJECT_SIZES = ["real", "readable"] as const
export type ObjectSize = (typeof OBJECT_SIZES)[number]

/** A stored value as an Object size; anything else is Real. */
export function readObjectSize(v: unknown): ObjectSize {
  return v === "readable" ? "readable" : "real"
}

/** Readable on screen: the symbol's least side and the names' font (px). */
export const READABLE_SYMBOL_PX = 28
export const READABLE_FONT_PX = 11
/** Readable on paper: the same, in mm (about 5.7 pt for the names). */
export const READABLE_SYMBOL_MM = 5
export const READABLE_FONT_MM = 2
/** A name longer than this is cut with an ellipsis. */
export const READABLE_MAX_CHARS = 24
/** ~Average glyph width of the sans, per em. */
const GLYPH_EM = 0.6

/**
 * How much a `w` x `h` cell object grows so its longer side is at least
 * `min` units, at `perCell` units per cell (screen px, or paper mm): 1 when
 * it is already that big - nothing changes above that zoom.
 */
export function growFactor(
  w: number,
  h: number,
  perCell: number,
  min: number = READABLE_SYMBOL_PX
): number {
  const side = Math.max(w, h) * perCell
  if (!(side > 0) || side >= min) return 1
  return min / side
}

/** Tiles Readable grows: every placed thing but the floor's zones. */
export function growsReadable(tile: FloorPlanTile): boolean {
  return !(tile.tile_type?.is_zone ?? false)
}

/** A rect in cells. */
export interface CellBox {
  x: number
  y: number
  w: number
  h: number
}

/** The grown symbol's box (cells): the tile scaled by `grow` about its
 * centre, its aspect kept. */
export function grownBox(tile: FloorPlanTile, grow: number): CellBox {
  const w = tile.width * grow
  const h = tile.height * grow
  return {
    x: tile.x + tile.width / 2 - w / 2,
    y: tile.y + tile.height / 2 - h / 2,
    w,
    h,
  }
}

/**
 * The tile under (wx, wy) cells as Readable draws it: a grown symbol first
 * (they draw on top, the last drawn wins), then a tile's true footprint.
 * Zones are never hit.
 */
export function readableHit(
  tiles: readonly FloorPlanTile[],
  wx: number,
  wy: number,
  pxPerCell: number,
  minPx: number = READABLE_SYMBOL_PX
): FloorPlanTile | null {
  const inside = (b: CellBox) =>
    wx >= b.x && wx < b.x + b.w && wy >= b.y && wy < b.y + b.h
  for (let i = tiles.length - 1; i >= 0; i--) {
    const t = tiles[i]
    if (!growsReadable(t)) continue
    const g = growFactor(t.width, t.height, pxPerCell, minPx)
    if (g > 1 && inside(grownBox(t, g))) return t
  }
  for (let i = tiles.length - 1; i >= 0; i--) {
    const t = tiles[i]
    if (!growsReadable(t)) continue
    if (inside({ x: t.x, y: t.y, w: t.width, h: t.height })) return t
  }
  return null
}

/** The draw order for Readable (`pxPerCell` null: as given): the tiles
 * at their real size, then the grown ones over them, the `pinned` (the
 * selection) last. Stable otherwise - a free plan's z order holds. */
export function readableOrder(
  tiles: readonly FloorPlanTile[],
  pxPerCell: number | null,
  pinned?: ReadonlySet<string>,
  minPx: number = READABLE_SYMBOL_PX
): readonly FloorPlanTile[] {
  if (pxPerCell == null) return tiles
  const real: FloorPlanTile[] = []
  const grown: FloorPlanTile[] = []
  const top: FloorPlanTile[] = []
  for (const t of tiles) {
    if (
      !growsReadable(t) ||
      growFactor(t.width, t.height, pxPerCell, minPx) <= 1
    )
      real.push(t)
    else if (pinned?.has(t.id)) top.push(t)
    else grown.push(t)
  }
  return grown.length || top.length ? [...real, ...grown, ...top] : tiles
}

/** A cable stub moved out to its tile's grown edge, so it leaves the
 * symbol and not the empty middle of it. */
export function growStub(
  stub: CableStub,
  tile: FloorPlanTile,
  grow: number
): CableStub {
  if (grow <= 1) return stub
  const c: Pt = [tile.x + tile.width / 2, tile.y + tile.height / 2]
  return {
    ...stub,
    from: [
      c[0] + (stub.from[0] - c[0]) * grow,
      c[1] + (stub.from[1] - c[1]) * grow,
    ],
  }
}

/** Every stub moved out to its grown tile's edge (`growStubs` keeps the
 * array when nothing grows). */
export function growStubs(
  stubs: readonly CableStub[],
  tiles: readonly FloorPlanTile[],
  perCell: number,
  min: number = READABLE_SYMBOL_PX
): readonly CableStub[] {
  if (!stubs.length) return stubs
  const byId = new Map(tiles.map((t) => [t.id, t]))
  const out = stubs.map((s) => {
    const t = byId.get(s.tile)
    if (!t) return s
    const g = growFactor(t.width, t.height, perCell, min)
    return g <= 1 ? s : growStub(s, t, g)
  })
  return out.some((s, i) => s !== stubs[i]) ? out : stubs
}

/** A name cut to READABLE_MAX_CHARS with an ellipsis. */
export function clipName(name: string, max = READABLE_MAX_CHARS): string {
  return name.length > max ? `${name.slice(0, max - 1)}…` : name
}

/** A name's box, centred on x, its top at y, for a `font` (any unit). */
export function nameBox(
  name: string,
  x: number,
  y: number,
  font: number
): { x: number; y: number; w: number; h: number } {
  const w = clipName(name).length * font * GLYPH_EM + font * 0.4
  const h = font * 1.3
  return { x: x - w / 2, y, w, h }
}

/** A name to place: its box (screen px or paper mm) and its rank. */
export interface NameCandidate {
  id: string
  x: number
  y: number
  w: number
  h: number
  /** Higher wins a clash; Infinity is always shown (selected, hovered). */
  priority: number
}

/**
 * Names that do not overlap: the highest ranked first (ties: the earlier in
 * `cands`), each kept unless it overlaps one already kept. An Infinity
 * candidate is always kept. A uniform grid keeps it near-linear for
 * thousands of names.
 */
export function thinNames(
  cands: readonly NameCandidate[],
  cell = 64
): Set<string> {
  const order = cands
    .map((c, i) => ({ c, i }))
    .sort((a, b) => b.c.priority - a.c.priority || a.i - b.i)
  const grid = new Map<string, NameCandidate[]>()
  const kept = new Set<string>()
  const keys = (c: NameCandidate) => {
    const out: string[] = []
    const x0 = Math.floor(c.x / cell)
    const x1 = Math.floor((c.x + c.w) / cell)
    const y0 = Math.floor(c.y / cell)
    const y1 = Math.floor((c.y + c.h) / cell)
    for (let gx = x0; gx <= x1; gx++)
      for (let gy = y0; gy <= y1; gy++) out.push(`${gx},${gy}`)
    return out
  }
  const hits = (a: NameCandidate, b: NameCandidate) =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  for (const { c } of order) {
    const ks = keys(c)
    if (c.priority !== Infinity) {
      let clash = false
      for (const k of ks) {
        const bucket = grid.get(k)
        if (bucket?.some((o) => hits(c, o))) {
          clash = true
          break
        }
      }
      if (clash) continue
    }
    kept.add(c.id)
    for (const k of ks) {
      const cellList = grid.get(k)
      if (cellList) cellList.push(c)
      else grid.set(k, [c])
    }
  }
  return kept
}

/** A tile's rank among names: the linked objects (racks, cabinets,
 * devices) over planning tiles, then the bigger footprint. */
export function namePriority(tile: FloorPlanTile): number {
  const k = tile.linked?.kind
  const linked = k === "rack" || k === "cabinet" || k === "device" ? 1000 : 0
  return linked + Math.min(999, tile.width * tile.height)
}

/** How much a font of `font` units grows to read at `min` units on screen
 * (or paper) at `scale` units per font unit: 1 when it already does. */
export function fontGrow(
  font: number,
  scale: number,
  min: number = READABLE_FONT_PX
): number {
  const shown = font * scale
  if (!(shown > 0) || shown >= min) return 1
  return min / shown
}
