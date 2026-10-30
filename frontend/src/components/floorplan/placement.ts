import type {
  FloorPlan,
  FloorPlanPlaceable,
  FloorPlanRoomRef,
  FloorPlanTile,
} from "@/lib/api"

import { findCollision } from "./canvas-geometry"
import { byZ, pointInBox, pointInPolygon } from "./shapes"
import type { AreaShape, PlanShape, Pt } from "./shapes"

// Placing devices, racks and cabinets on a floor (the Place picker, the
// unplaced list): where the new tiles go, which room's area they land in,
// and what "near" means for the picker's ranking. Pure, for the tests.

/** The routes a linked tile's object opens on. */
const ROUTES: Record<FloorPlanPlaceable["kind"], string> = {
  device: "/devices/",
  rack: "/racks/",
  cabinet: "/cabinets/",
}

/** The drag payload's MIME type: a list of placeable rows as JSON. */
export const PLACE_MIME = "application/x-danbyte-place"

/** A placeable object's key: `kind:id`. */
export const placeKey = (kind: string, id: string) => `${kind}:${id}`

/** The devices, racks and cabinets the editor's tiles link - saved or in
 * the unsaved draft - each to its (first) tile's id. */
export function placedOnFloor(tiles: FloorPlanTile[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const t of tiles) {
    const l = t.linked
    if (
      !l ||
      !(l.kind === "device" || l.kind === "rack" || l.kind === "cabinet")
    )
      continue
    const key = placeKey(l.kind, l.id)
    if (!out.has(key)) out.set(key, t.id)
  }
  return out
}

/** Display > Photos: every tile with a photo drawn as it. A view - the
 * tiles' own saved `display` is not changed. */
export function asPhotos(tiles: FloorPlanTile[]): FloorPlanTile[] {
  return tiles.map((t) =>
    t.photo && t.display !== "photo" ? { ...t, display: "photo" } : t
  )
}

/** A row as the editor sees it: "on this floor" from its tiles (the draft
 * included) rather than from the last save. */
export function withDraftPlacement(
  row: FloorPlanPlaceable,
  onFloor: Map<string, string>,
  plan: Pick<FloorPlan, "id" | "name"> & { stack?: { name: string } | null }
): FloorPlanPlaceable {
  const elsewhere = row.placed_on.filter((p) => !p.this_floor)
  const savedHere = row.placed_on.length - elsewhere.length
  const tileId = onFloor.get(placeKey(row.kind, row.id))
  const here = tileId
    ? [
        {
          floor_plan: {
            id: plan.id,
            name: plan.name,
            stack: plan.stack?.name ?? "",
          },
          tile_id: tileId,
          this_floor: true,
        },
      ]
    : []
  return {
    ...row,
    placed_count: Math.max(0, row.placed_count - savedHere) + here.length,
    placed_on: [...here, ...elsewhere],
  }
}

/** Whether the point lies in the area (a turned rectangle or a polygon). */
export function areaContains(a: AreaShape, p: Pt): boolean {
  if (a.shape === "polygon") return pointInPolygon(p, a.points)
  return pointInBox(p, a)
}

/** The topmost area holding the point that stands for something: a room,
 * else a location - what "near" is for the Place picker. */
export function scopeAreaAt(shapes: PlanShape[], p: Pt): AreaShape | null {
  const areas = shapes
    .filter((s): s is AreaShape => s.kind === "area")
    .filter((a) => a.room || a.location)
    .sort(byZ)
  for (let i = areas.length - 1; i >= 0; i--)
    if (areaContains(areas[i], p)) return areas[i]
  return null
}

/** The topmost area linked to a room that holds the point. */
export function roomAreaAt(shapes: PlanShape[], p: Pt): AreaShape | null {
  const areas = shapes
    .filter((s): s is AreaShape => s.kind === "area" && !!s.room)
    .sort(byZ)
  for (let i = areas.length - 1; i >= 0; i--)
    if (areaContains(areas[i], p)) return areas[i]
  return null
}

/** The Place picker's "near": the room or location of the area under the
 * pointer, else of the area at the middle of the view. */
export interface NearScope {
  room: FloorPlanRoomRef | null
  location: { id: string; name: string; color: string } | null
}

export function nearScope(
  shapes: PlanShape[],
  pointer: Pt | null,
  centre: Pt | null
): NearScope | null {
  for (const p of [pointer, centre]) {
    if (!p) continue
    const a = scopeAreaAt(shapes, p)
    if (a) return { room: a.room, location: a.room ? null : a.location }
  }
  return null
}

/** The footprint a row is placed with. Grid: one cell. Free: one cell, or
 * - with a photo - the device's true width with the photo's aspect. */
export function placedSize(
  row: FloorPlanPlaceable,
  plan: Pick<FloorPlan, "layout_mode" | "cell_mm">
): { width: number; height: number; display: "icon" | "photo" } {
  if (plan.layout_mode !== "free" || !row.photo)
    return { width: 1, height: 1, display: "icon" }
  const cell = plan.cell_mm || 600
  const width = Math.min(
    8,
    Math.max(0.25, row.photo.width_mm ? row.photo.width_mm / cell : 1)
  )
  const height = Math.max(0.1, width * (row.photo.aspect ?? 1))
  const r3 = (v: number) => Math.round(v * 1000) / 1000
  return { width: r3(width), height: r3(height), display: "photo" }
}

/** A new tile linked to the row's object - no tile type: it draws in the
 * object's role colour and icon. */
export function linkedTile(
  row: FloorPlanPlaceable,
  rect: { x: number; y: number; width: number; height: number },
  id: string,
  display: "icon" | "photo",
  z = 0
): FloorPlanTile {
  const now = new Date().toISOString()
  return {
    id,
    ...rect,
    tile_type: null,
    role_type: null,
    orientation: 0,
    label: "",
    color: "",
    status: "",
    link_kind: row.kind,
    linked: {
      kind: row.kind,
      id: row.id,
      name: row.name,
      route: `${ROUTES[row.kind]}${row.id}`,
      room: row.room,
      role: row.role ? { icon: "", ...row.role } : null,
    },
    fov_deg: null,
    fov_distance: null,
    fov_direction: null,
    fov_anchor: "",
    fov_ptz: false,
    display,
    z,
    photo: row.photo,
    created_at: now,
    updated_at: now,
  }
}

/**
 * Where each row goes when dropped at `at` (cells). On a grid plan the first
 * takes the cell under the drop - or the next free one to its right - and
 * the rest follow along the row (wrapping), never onto another tile. On a
 * free plan they stand side by side from the drop point, the first centred
 * on it. Rows with no room left are left out.
 */
export function placementRects(
  rows: FloorPlanPlaceable[],
  at: Pt,
  plan: Pick<
    FloorPlan,
    "layout_mode" | "cell_mm" | "grid_width" | "grid_height"
  >,
  tiles: FloorPlanTile[]
): {
  row: FloorPlanPlaceable
  x: number
  y: number
  width: number
  height: number
  display: "icon" | "photo"
}[] {
  const out: ReturnType<typeof placementRects> = []
  if (plan.layout_mode === "free") {
    const r3 = (v: number) => Math.round(v * 1000) / 1000
    let x: number | null = null
    for (const row of rows) {
      const size = placedSize(row, plan)
      const left = x ?? at[0] - size.width / 2
      const nx = Math.max(0, Math.min(plan.grid_width - size.width, left))
      const ny = Math.max(
        0,
        Math.min(plan.grid_height - size.height, at[1] - size.height / 2)
      )
      out.push({ row, x: r3(nx), y: r3(ny), ...size })
      x = nx + size.width + 0.25
    }
    return out
  }
  const taken = [...tiles]
  let cx = Math.max(0, Math.min(plan.grid_width - 1, Math.floor(at[0])))
  let cy = Math.max(0, Math.min(plan.grid_height - 1, Math.floor(at[1])))
  const cells = plan.grid_width * plan.grid_height
  for (const row of rows) {
    let found = false
    for (let n = 0; n < cells; n++) {
      const rect = { x: cx, y: cy, width: 1, height: 1 }
      if (!findCollision(taken, rect)) {
        out.push({ row, ...rect, display: "icon" })
        taken.push({ ...rect, id: `taken-${out.length}` } as FloorPlanTile)
        found = true
      }
      cx += 1
      if (cx >= plan.grid_width) {
        cx = 0
        cy = (cy + 1) % plan.grid_height
      }
      if (found) break
    }
    if (!found) break
  }
  return out
}

/** Where a tile already on the floor goes when its row is dropped at `at`
 * (cells): its own size, centred on the drop on a free plan, from the cell
 * under it on a grid - inside the plan. Null when that lands on another
 * tile. */
export function droppedRect(
  tile: FloorPlanTile,
  at: Pt,
  plan: Pick<FloorPlan, "layout_mode" | "grid_width" | "grid_height">,
  tiles: FloorPlanTile[]
): { x: number; y: number } | null {
  const clamp = (v: number, size: number, max: number) =>
    Math.max(0, Math.min(max - size, v))
  if (plan.layout_mode === "free") {
    const r3 = (v: number) => Math.round(v * 1000) / 1000
    return {
      x: r3(clamp(at[0] - tile.width / 2, tile.width, plan.grid_width)),
      y: r3(clamp(at[1] - tile.height / 2, tile.height, plan.grid_height)),
    }
  }
  const rect = {
    x: clamp(Math.floor(at[0]), tile.width, plan.grid_width),
    y: clamp(Math.floor(at[1]), tile.height, plan.grid_height),
    width: tile.width,
    height: tile.height,
  }
  if (findCollision(tiles, rect, tile.id)) return null
  return { x: rect.x, y: rect.y }
}

/** Placed objects whose tile stands in a room's area while the object
 * names another room (or none), grouped by that area's room: the "Set room
 * to X?" prompt. Never applied by itself. */
export function roomPrompts(
  tiles: FloorPlanTile[],
  shapes: PlanShape[]
): {
  room: FloorPlanRoomRef
  objects: { kind: string; id: string; name: string }[]
}[] {
  const byRoom = new Map<
    string,
    {
      room: FloorPlanRoomRef
      objects: { kind: string; id: string; name: string }[]
    }
  >()
  for (const t of tiles) {
    const l = t.linked
    if (
      !l ||
      !(l.kind === "device" || l.kind === "rack" || l.kind === "cabinet")
    )
      continue
    const area = roomAreaAt(shapes, [t.x + t.width / 2, t.y + t.height / 2])
    if (!area?.room || l.room?.id === area.room.id) continue
    const entry = byRoom.get(area.room.id) ?? { room: area.room, objects: [] }
    entry.objects.push({ kind: l.kind, id: l.id, name: l.name })
    byRoom.set(area.room.id, entry)
  }
  return [...byRoom.values()]
}
