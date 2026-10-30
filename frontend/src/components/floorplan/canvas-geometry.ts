import type {
  FloorPlanCablePath,
  FloorPlanTile,
  FloorPlanTray,
} from "@/lib/api"

import { routeCable } from "./cable-route"
import type { Pt } from "./cable-route"

/** Pixel size of one grid cell in world coordinates. */
export const CELL = 40
/** Pixels a tile's drawn rect sits inside its cell footprint, so adjacent
 * tiles show a seam instead of touching strokes. */
export const GUTTER = 2

/** A normalized palette entry - a FloorTileType or a DeviceRole. */
export interface PaletteEntry {
  key: string // "tt:<id>" | "role:<id>"
  kind: "tile_type" | "role"
  id: string
  name: string
  color: string
  icon: string
  defaultWidth: number
  defaultHeight: number
  isZone: boolean
  hasFov: boolean
}

export function tileName(t: FloorPlanTile): string {
  return t.label || t.linked?.name || ""
}

/** Zone tiles paint the background - they render under normal tiles and are
 * exempt from the no-overlap rule. */
export function tileIsZone(t: FloorPlanTile): boolean {
  return t.tile_type?.is_zone ?? false
}

export function tileHasFov(t: FloorPlanTile): boolean {
  return (t.tile_type?.has_fov || t.role_type?.has_fov) ?? false
}

/** Do two grid rects overlap? Zones never count. */
export function tilesCollide(
  a: { x: number; y: number; width: number; height: number },
  b: FloorPlanTile
): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  )
}

/** First non-zone tile the candidate rect would stack on, or null. */
export function findCollision(
  tiles: FloorPlanTile[],
  rect: { x: number; y: number; width: number; height: number },
  ignoreId?: string
): FloorPlanTile | null {
  for (const t of tiles) {
    if (t.id === ignoreId || tileIsZone(t)) continue
    if (tilesCollide(rect, t)) return t
  }
  return null
}

/** The routed A↔B points (cell units) of a cable, through its trays. Empty
 * when either endpoint tile is missing. Shared by the render + camera focus. */
export function cableRoutePoints(
  cp: FloorPlanCablePath,
  trays: FloorPlanTray[],
  tiles: FloorPlanTile[]
): Pt[] {
  const a = cp.a_tiles[0] ? tileCentreCells(tiles, cp.a_tiles[0]) : null
  const b = cp.b_tiles[0] ? tileCentreCells(tiles, cp.b_tiles[0]) : null
  if (!a || !b) return []
  const polys = cp.tray_ids
    .map((tid) => trays.find((tr) => tr.id === tid)?.points)
    .filter((p): p is [number, number][] => !!p)
  return routeCable(a, b, polys)
}

export interface CellPoint {
  x: number
  y: number
}

/** Centre point of a tile in CELL units (for the tray router). */
export function tileCentreCells(
  tiles: FloorPlanTile[],
  tileId: string
): Pt | null {
  const t = tiles.find((x) => x.id === tileId)
  if (!t) return null
  return [t.x + t.width / 2, t.y + t.height / 2]
}
