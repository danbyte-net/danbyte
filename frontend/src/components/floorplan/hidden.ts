import type { FloorPlanTile } from "@/lib/api"
import { emptyHidden, normalizeHidden } from "@/components/hidden-objects"
import type { HiddenSet } from "@/components/hidden-objects"
import { tileIsZone } from "@/components/floorplan/floor-canvas"

/** What the plan's eye toggles have switched off: tile type ids, device role
 * type ids, single tile ids. Kept on the plan (`state.hidden`), saved with
 * the layout like its other view preferences - the plan is a shared drawing
 * and "without the old rack row" is part of how it was shaped. */
export const FLOOR_HIDDEN_KEYS = ["tileTypes", "roleTypes", "tiles"] as const
export type FloorHidden = HiddenSet<(typeof FLOOR_HIDDEN_KEYS)[number]>

export const NO_FLOOR_HIDDEN: FloorHidden = emptyHidden(FLOOR_HIDDEN_KEYS)

export function readFloorHidden(raw: unknown): FloorHidden {
  return normalizeHidden(raw, FLOOR_HIDDEN_KEYS)
}

/** Whether a tile is off the plan. Zones are paint, never hidden. */
export function tileHidden(t: FloorPlanTile, h: FloorHidden): boolean {
  if (tileIsZone(t)) return false
  return (
    h.tiles.includes(t.id) ||
    (!!t.tile_type && h.tileTypes.includes(t.tile_type.id)) ||
    (!!t.role_type && h.roleTypes.includes(t.role_type.id))
  )
}

/** The tiles the canvas, the 3D scene and the exports draw. The full list
 * keeps feeding the save path - hiding never edits the plan's content. */
export function visibleTiles(
  tiles: FloorPlanTile[],
  h: FloorHidden
): FloorPlanTile[] {
  if (!h.tiles.length && !h.tileTypes.length && !h.roleTypes.length)
    return tiles
  return tiles.filter((t) => !tileHidden(t, h))
}
