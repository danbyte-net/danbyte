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

/** A stored value as an Object size: Readable unless the plan chose Real. */
export function readObjectSize(v: unknown): ObjectSize {
  return v === "real" ? "real" : "readable"
}

/** Readable on screen: the symbol's least side and the names' font (px). */
export const READABLE_SYMBOL_PX = 28
export const READABLE_FONT_PX = 11
/** Readable on paper: the same, in mm (about 5.7 pt for the names). */
export const READABLE_SYMBOL_MM = 5
export const READABLE_FONT_MM = 2
/** Readable trays: the channel's least width on screen (px) and paper
 * (mm). */
export const READABLE_TRAY_PX = 6
export const READABLE_TRAY_MM = 1
/** Readable: the symbol's short side never under this on screen (px) or
 * paper (mm) - a 1U switch, long and flat, still reads as a symbol. */
export const READABLE_SHORT_PX = 14
export const READABLE_SHORT_MM = 2.5
/** A photo whose short side is under this on screen (px) draws as its
 * role symbol instead - a stretched sliver of picture reads as nothing. */
export const READABLE_PHOTO_PX = 24
export const READABLE_PHOTO_MM = 4
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

/** What Readable draws for a tile: its box (cells) - the long side grown
 * to `minLong`, then the short side to `minShort`, centred - whether that
 * differs from the real footprint, and whether it draws as the role symbol
 * (a box whose short side had to grow on its own, or a photo too small
 * to read) instead of itself. */
export interface ReadableShape {
  box: CellBox
  /** The uniform growth of the long side (1: none). */
  grow: number
  changed: boolean
  symbol: boolean
}

export function readableShape(
  tile: FloorPlanTile,
  perCell: number,
  {
    minLong = READABLE_SYMBOL_PX,
    minShort = READABLE_SHORT_PX,
    minPhoto = READABLE_PHOTO_PX,
  }: { minLong?: number; minShort?: number; minPhoto?: number } = {}
): ReadableShape {
  const real: CellBox = {
    x: tile.x,
    y: tile.y,
    w: tile.width,
    h: tile.height,
  }
  if (!growsReadable(tile) || !(perCell > 0))
    return { box: real, grow: 1, changed: false, symbol: false }
  const grow = growFactor(tile.width, tile.height, perCell, minLong)
  let w = tile.width * grow
  let h = tile.height * grow
  const short = minShort / perCell
  const thin = Math.min(w, h) < short
  if (w < short) w = short
  if (h < short) h = short
  const photo =
    tile.display === "photo" &&
    !!tile.photo &&
    Math.min(w, h) * perCell < minPhoto
  const changed = grow > 1 || thin
  return {
    box: changed
      ? {
          x: tile.x + tile.width / 2 - w / 2,
          y: tile.y + tile.height / 2 - h / 2,
          w,
          h,
        }
      : real,
    grow,
    changed,
    symbol: thin || photo,
  }
}

/** How a tile is drawn when not at its real size, or null (as itself). */
export type ShapeOf = (t: FloorPlanTile) => ReadableShape | null

// Icons when zoomed out (Display): a device, rack or cabinet whose long
// side drops under ICON_TILE_PX on screen draws as its icon tile - the
// same symbol Readable draws, a rounded square in its colour with its icon
// in white, READABLE_SYMBOL_PX on a side. It turns back only once the
// long side is over ICON_TILE_EXIT_PX, so a zoom that hovers about the
// threshold does not flicker. On paper there is no zoom to hover: one
// threshold, ICON_TILE_MM.

/** A stored value as the Icons option: on unless the plan turned it off. */
export function readIconTiles(v: unknown): boolean {
  return v !== false
}

/** Under this long side on screen (px) a tile turns into its icon. */
export const ICON_TILE_PX = 40
/** Over this long side (px) an icon tile turns back into the tile. */
export const ICON_TILE_EXIT_PX = 48
/** On paper: under this long side (mm) a tile prints as its icon. */
export const ICON_TILE_MM = 7

/** Tiles that turn into icons: those linked to a device, rack or cabinet
 * (never a zone, never a planning tile). */
export function iconTileSubject(tile: FloorPlanTile): boolean {
  const k = tile.linked?.kind
  return (
    (k === "device" || k === "rack" || k === "cabinet") && growsReadable(tile)
  )
}

/** Whether a tile draws as its icon at `perCell` units per cell: under
 * `enter` on its long side, or - already an icon (`was`) - until it is
 * over `exit`. */
export function isIconTile(
  tile: FloorPlanTile,
  perCell: number,
  was: boolean,
  enter: number = ICON_TILE_PX,
  exit: number = ICON_TILE_EXIT_PX
): boolean {
  if (!iconTileSubject(tile) || !(perCell > 0)) return false
  const long = Math.max(tile.width, tile.height) * perCell
  return long < (was ? exit : enter)
}

/** The tiles drawn as icons at `perCell`, given those that were (`prev`):
 * `prev` itself when nothing changed, so a memo keyed on it holds. */
export function iconTileIds(
  tiles: readonly FloorPlanTile[],
  perCell: number,
  prev: ReadonlySet<string>,
  enter: number = ICON_TILE_PX,
  exit: number = ICON_TILE_EXIT_PX
): ReadonlySet<string> {
  const next = new Set<string>()
  for (const t of tiles)
    if (isIconTile(t, perCell, prev.has(t.id), enter, exit)) next.add(t.id)
  if (next.size === prev.size && [...next].every((id) => prev.has(id)))
    return prev
  return next
}

/** An icon tile's shape: a square `side` units on a side (screen px or
 * paper mm) centred on the tile - Readable's least symbol. */
export function iconTileShape(
  tile: FloorPlanTile,
  perCell: number,
  side: number = READABLE_SYMBOL_PX
): ReadableShape {
  const s = side / perCell
  return {
    box: {
      x: tile.x + tile.width / 2 - s / 2,
      y: tile.y + tile.height / 2 - s / 2,
      w: s,
      h: s,
    },
    grow: s / Math.max(tile.width, tile.height),
    changed: true,
    symbol: true,
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
  minPx: number = READABLE_SYMBOL_PX,
  shapeOf?: ShapeOf
): FloorPlanTile | null {
  const inside = (b: CellBox) =>
    wx >= b.x && wx < b.x + b.w && wy >= b.y && wy < b.y + b.h
  const shapeFor =
    shapeOf ??
    ((t: FloorPlanTile) => readableShape(t, pxPerCell, { minLong: minPx }))
  for (let i = tiles.length - 1; i >= 0; i--) {
    const t = tiles[i]
    if (!growsReadable(t)) continue
    const shape = shapeFor(t)
    if (shape?.changed && inside(shape.box)) return t
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
  minPx: number = READABLE_SYMBOL_PX,
  shapeOf?: ShapeOf
): readonly FloorPlanTile[] {
  if (pxPerCell == null) return tiles
  const real: FloorPlanTile[] = []
  const grown: FloorPlanTile[] = []
  const top: FloorPlanTile[] = []
  const changed = shapeOf
    ? (t: FloorPlanTile) => !!shapeOf(t)?.changed
    : (t: FloorPlanTile) =>
        readableShape(t, pxPerCell, { minLong: minPx }).changed
  for (const t of tiles) {
    if (!changed(t)) real.push(t)
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
  min: number = READABLE_SYMBOL_PX,
  minShort: number = READABLE_SHORT_PX,
  shapeOf?: ShapeOf
): readonly CableStub[] {
  if (!stubs.length) return stubs
  const byId = new Map(tiles.map((t) => [t.id, t]))
  const out = stubs.map((s) => {
    const t = byId.get(s.tile)
    if (!t) return s
    const shape = shapeOf
      ? shapeOf(t)
      : readableShape(t, perCell, { minLong: min, minShort })
    if (!shape?.changed) return s
    const c: Pt = [t.x + t.width / 2, t.y + t.height / 2]
    const sx = shape.box.w / t.width
    const sy = shape.box.h / t.height
    return {
      ...s,
      from: [
        c[0] + (s.from[0] - c[0]) * sx,
        c[1] + (s.from[1] - c[1]) * sy,
      ] as Pt,
    }
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
