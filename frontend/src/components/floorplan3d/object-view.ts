import type { CabinetSizes } from "@/lib/api"

import type { SceneCabinet, ScenePayload, SceneRack, SceneTile } from "./world"

// One object on its own - a rack on its page, a cabinet on its page: the
// plan and tile it stands on, so the room's own meshes draw it unchanged,
// and where the camera looks at it from. Three-free and unit-tested.

/** A plan of one metre-square cell centred on the origin. */
export const SOLO_PLAN: ScenePayload["plan"] = {
  id: "",
  name: "",
  grid_width: 1,
  grid_height: 1,
  cell_mm: 1000,
  ceiling_mm: 3000,
  background_image: null,
  background_opacity: 0,
}

/** The tile a single rack or cabinet stands on: centred on the origin,
 * its front to −Z, as the room turns a tile facing north. */
export function soloTile(
  id: string,
  linked: { rack?: SceneRack; cabinet?: SceneCabinet }
): SceneTile {
  return {
    id,
    x: -0.5,
    y: -0.5,
    w: 1,
    h: 1,
    orientation: 0,
    status: "",
    label: "",
    kind: linked.rack ? "rack" : "cabinet",
    color: "",
    is_zone: false,
    rack: linked.rack ?? null,
    cabinet: linked.cabinet ?? null,
  }
}

/** A cabinet as the room's scene payload carries it, its unrecorded outer
 * size filled the way the server fills it: the plate plus 50 mm, 200 mm
 * deep. */
export function sceneCabinetOf(
  cabinet: CabinetSizes & { id: string; name: string; device_count: number }
): SceneCabinet {
  return {
    id: cabinet.id,
    name: cabinet.name,
    outer_width_mm: cabinet.outer_width_mm || cabinet.inner_width_mm + 50,
    outer_height_mm: cabinet.outer_height_mm || cabinet.inner_height_mm + 50,
    outer_depth_mm: cabinet.outer_depth_mm || 200,
    device_count: cabinet.device_count,
  }
}

/** The camera's vertical field of view, degrees - the stage's. */
const FOV_DEG = 45

/** How far back to stand to see an object `width` × `height` m whole, with
 * room around it, in a view `aspect` wide over high; `depth` is added so
 * the front, not the middle, sits at that distance. */
export function fitDistance(
  size: { width: number; height: number; depth: number },
  aspect = 4 / 3
): number {
  const half = Math.tan(((FOV_DEG / 2) * Math.PI) / 180)
  const byHeight = size.height / (2 * half)
  const byWidth = size.width / (2 * half * Math.max(aspect, 0.5))
  return Math.max(byHeight, byWidth) * 1.5 + size.depth / 2
}

/** Where to look at an object standing at the origin from: the middle of
 * its height, from `dist` away. `yaw` turns the eye around it - 0 straight
 * at the front, π at the rear, positive toward the viewer's right (−x) -
 * and `pitch` raises it. `at` moves the point looked at across the floor
 * (x, z), for something that sticks out of the object, like an open door. */
export function objectViewpoint(
  height: number,
  dist: number,
  yaw: number,
  pitch = 0,
  at: [number, number] = [0, 0]
): { target: [number, number, number]; position: [number, number, number] } {
  const target: [number, number, number] = [at[0], height / 2, at[1]]
  const flat = Math.cos(pitch) * dist
  return {
    target,
    position: [
      target[0] - Math.sin(yaw) * flat,
      target[1] + Math.sin(pitch) * dist,
      target[2] - Math.cos(yaw) * flat,
    ],
  }
}

/** The camera presets a single-object view offers. */
export type ObjectView = "front" | "rear" | "angle"

/** Each preset's turn and lift: straight at the front or the rear, a
 * touch above the middle; or the opening view, from the front-right and
 * above, so the object reads as a solid. */
export const OBJECT_VIEWS: Record<ObjectView, { yaw: number; pitch: number }> =
  {
    front: { yaw: 0, pitch: 0.08 },
    rear: { yaw: Math.PI, pitch: 0.08 },
    angle: { yaw: 0.5, pitch: 0.28 },
  }
