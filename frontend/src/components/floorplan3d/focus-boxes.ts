/**
 * The boxes the camera frames: a plan's areas (a building on a site-wide
 * plan), its walls, and the whole plan for Fit all. Plain tuples in world
 * metres, X east, Z south - `CameraRig`'s `NavApi.frame` takes them as they
 * are. Racks and cabinets keep their own face-on viewpoint (`rackViewpoint`).
 */

import { boxCorners } from "@/components/floorplan/shapes"
import type { AreaShape } from "@/components/floorplan/shapes"

import { cellM, mm } from "./world"
import type { ScenePayload, SceneWall } from "./world"

export interface FocusBox {
  min: [number, number, number]
  max: [number, number, number]
}

/** How tall an area's box stands (m): enough that the racks inside it
 * stay in frame, without a wide site footprint backing off for height. */
const AREA_BOX_HEIGHT_M = 2.5

/** The box around points given in grid cells, `y0`..`y1` metres high. */
function cellsBox(
  plan: ScenePayload["plan"],
  pts: readonly (readonly [number, number])[],
  y0: number,
  y1: number
): FocusBox | null {
  if (pts.length === 0) return null
  const c = cellM(plan)
  let x0 = Infinity
  let z0 = Infinity
  let x1 = -Infinity
  let z1 = -Infinity
  for (const [x, z] of pts) {
    x0 = Math.min(x0, x * c)
    z0 = Math.min(z0, z * c)
    x1 = Math.max(x1, x * c)
    z1 = Math.max(z1, z * c)
  }
  return { min: [x0, y0, z0], max: [x1, y1, z1] }
}

/** An area's footprint, turned rectangle or polygon, as a box. */
export function areaBox(
  plan: ScenePayload["plan"],
  area: AreaShape
): FocusBox | null {
  const pts = area.shape === "polygon" ? area.points : boxCorners(area)
  return cellsBox(plan, pts, 0, AREA_BOX_HEIGHT_M)
}

/** One wall polyline at its height (the plan's ceiling when unset). */
export function wallBox(
  plan: ScenePayload["plan"],
  wall: SceneWall
): FocusBox | null {
  return cellsBox(plan, wall.points, 0, mm(wall.height_mm ?? plan.ceiling_mm))
}

/** The whole plan: its grid, floor to the top of a rack. */
export function planBounds(plan: ScenePayload["plan"]): FocusBox {
  const c = cellM(plan)
  return {
    min: [0, 0, 0],
    max: [plan.grid_width * c, AREA_BOX_HEIGHT_M, plan.grid_height * c],
  }
}

/** Of the areas under a click, the one the operator meant: the smallest -
 * a room inside a building, not the building around it. */
export function smallestArea(
  areas: readonly AreaShape[],
  ids: readonly string[],
  plan: ScenePayload["plan"]
): AreaShape | null {
  let best: { a: AreaShape; size: number } | null = null
  for (const id of ids) {
    const a = areas.find((x) => x.id === id)
    if (!a) continue
    const b = areaBox(plan, a)
    if (!b) continue
    const size = (b.max[0] - b.min[0]) * (b.max[2] - b.min[2])
    if (!best || size < best.size) best = { a, size }
  }
  return best?.a ?? null
}
