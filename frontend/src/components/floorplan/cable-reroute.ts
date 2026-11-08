import type { FloorPlanCablePath, FloorPlanTile } from "@/lib/api"

import type { CableRoute } from "./cable-draw"
import type { StructShape } from "./structure"

/**
 * Re-routing after a move: which stored routes a draft step left out of
 * date. A route is touched when an end's tile moved off the point it was
 * routed from, or when a tray it rides was reshaped, re-levelled or
 * deleted. The editor offers **Update N routes?** for them; declining
 * leaves them drawn out of date.
 */

const geo = (t: FloorPlanTile) => `${t.x},${t.y},${t.width},${t.height}`

/** Tiles in both drafts whose place or size changed. */
export function movedTileIds(
  before: readonly FloorPlanTile[],
  after: readonly FloorPlanTile[]
): Set<string> {
  if (before === after) return new Set()
  const was = new Map(before.map((t) => [t.id, t]))
  const out = new Set<string>()
  for (const t of after) {
    const b = was.get(t.id)
    if (b && b !== t && geo(b) !== geo(t)) out.add(t.id)
  }
  return out
}

const trayShape = (t: Extract<StructShape, { part: "tray" }>) =>
  `${JSON.stringify(t.points)}|${t.level}|${t.elevation_mm ?? ""}`

/** Trays of the earlier draft reshaped, re-levelled or deleted since. */
export function changedTrayIds(
  before: readonly StructShape[],
  after: readonly StructShape[]
): Set<string> {
  if (before === after) return new Set()
  const now = new Map(after.map((s) => [s.id, s]))
  const out = new Set<string>()
  for (const b of before) {
    if (b.part !== "tray") continue
    const a = now.get(b.id)
    if (!a || a.part !== "tray") out.add(b.id)
    else if (a !== b && trayShape(a) !== trayShape(b)) out.add(b.id)
  }
  return out
}

const centre = (t: FloorPlanTile): [number, number] => [
  t.x + t.width / 2,
  t.y + t.height / 2,
]

/** The cables whose stored route the moved tiles or changed trays put out
 * of date: an end on a moved tile, away from where it was routed from, or
 * a tray of its route changed. */
export function routesTouched(
  cablePaths: readonly FloorPlanCablePath[],
  tiles: readonly FloorPlanTile[],
  moved: ReadonlySet<string>,
  trays: ReadonlySet<string>
): string[] {
  if (!moved.size && !trays.size) return []
  const byId = new Map(tiles.map((t) => [t.id, t]))
  const out: string[] = []
  for (const cp of cablePaths) {
    const path = cp.path
    if (!path) continue
    const hit =
      path.tray_order.some((t) => trays.has(t)) ||
      path.legs.some((leg) =>
        [leg.from, leg.to].some((end) => {
          if (!moved.has(end.tile)) return false
          const t = byId.get(end.tile)
          if (!t) return false
          const c = centre(t)
          return Math.hypot(c[0] - end.at[0], c[1] - end.at[1]) > 1e-3
        })
      )
    if (hit) out.push(cp.id)
  }
  return out
}

/** The cables drawn with a stored route that is out of date. */
export function staleRouteIds(
  routes: ReadonlyMap<string, CableRoute>
): string[] {
  const out: string[] = []
  for (const r of routes.values()) if (r.stored && r.stale) out.push(r.id)
  return out
}

/** A prompt's cables after another touch: the first ones kept in order,
 * the new ones after them. */
export function mergeIds(
  prev: readonly string[] | undefined,
  next: readonly string[]
): string[] {
  if (!prev?.length) return [...next]
  const seen = new Set(prev)
  return [...prev, ...next.filter((id) => !seen.has(id))]
}
