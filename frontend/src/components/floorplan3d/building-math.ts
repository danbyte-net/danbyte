import type { FloorPlanFloor } from "@/lib/api"
import { levelToLevel } from "@/components/floorplan/levels"

import type { LevelMode } from "@/components/floorplan/level-panel"

import type { SceneWall } from "./world"

/** The 3D building (aligned floors) without three.js: where each level
 * sits relative to the active one, and the outline its slab takes. */

export type { LevelMode }

/** A level as the building draws it. */
export interface LevelPlacement {
  floor: FloorPlanFloor
  /** Its place in the stack, lowest first. */
  index: number
  /** Storeys from the active level (negative below): what the explode
   * multiplies. */
  step: number
  /** Its floor's height over the active level's, in metres (explode in). */
  y: number
  /** The level's (0, 0) in the active level's world, metres, and its turn
   * about the vertical axis (radians, three.js rotation.y). */
  x: number
  z: number
  rotY: number
  /** How it draws: the active level, solid and simplified, ghosted
   * (outlines, contents hidden), or not at all. */
  look: "active" | "solid" | "ghost" | "hidden"
}

/** The storey the explode slider spreads levels by, at its full travel. */
export const EXPLODE_M = 6

/** Every level of `floors` (one aligned stack, lowest first) placed around
 * the active one (`activeId`), as `mode` shows them. */
export function placeLevels(
  floors: FloorPlanFloor[],
  activeId: string,
  mode: LevelMode,
  explode = 0
): LevelPlacement[] {
  const levels = floors.filter((f) => f.kind !== "view")
  const ai = levels.findIndex((f) => f.id === activeId)
  if (ai < 0) return []
  const active = levels[ai]
  const e0 = active.elevation ?? 0
  const cellA = (active.cell_mm ?? 600) / 1000
  return levels.map((f, i) => {
    const [ox, oz] = levelToLevel([0, 0], f, active)
    const rot = ((f.align_rot ?? 0) - (active.align_rot ?? 0)) * (Math.PI / 180)
    const look: LevelPlacement["look"] =
      i === ai
        ? "active"
        : mode === "only"
          ? "hidden"
          : i < ai
            ? "solid"
            : mode === "all"
              ? "ghost"
              : "hidden"
    return {
      floor: f,
      index: i,
      step: i - ai,
      y: ((f.elevation ?? 0) - e0) / 1000 + explode * EXPLODE_M * (i - ai),
      x: ox * cellA,
      z: oz * cellA,
      rotY: -rot,
      look,
    }
  })
}

/** The shown levels' box (a floor of `w` by `d` metres) with the
 * levels spread by `explode`; null with one level or none on show. */
export function levelsBounds(
  levels: LevelPlacement[],
  w: number,
  d: number,
  explode = 0
): { min: [number, number, number]; max: [number, number, number] } | null {
  const shown = levels.filter((l) => l.look !== "hidden")
  if (shown.length < 2) return null
  const y = (l: LevelPlacement) => l.y + explode * EXPLODE_M * l.step
  return {
    min: [
      0,
      Math.min(...shown.map((l) => y(l) - (l.floor.slab_mm ?? 300) / 1000)),
      0,
    ],
    max: [
      w,
      Math.max(...shown.map((l) => y(l) + (l.floor.ceiling_mm ?? 3000) / 1000)),
      d,
    ],
  }
}

type Pt = [number, number]

function hull(points: Pt[]): Pt[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (pts.length < 3) return pts
  const cross = (o: Pt, a: Pt, b: Pt) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower: Pt[] = []
  for (const p of pts) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0
    )
      lower.pop()
    lower.push(p)
  }
  const upper: Pt[] = []
  for (const p of [...pts].reverse()) {
    while (
      upper.length >= 2 &&
      cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0
    )
      upper.pop()
    upper.push(p)
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)]
}

const same = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-3

/** The slab's outline in cells: the exterior walls - one closed ring as
 * drawn, else the hull of their points - else the grid's box. */
export function slabOutline(
  walls: SceneWall[] | undefined,
  grid: { grid_width: number; grid_height: number }
): Pt[] {
  const ext = (walls ?? []).filter((w) => w.exterior && w.points.length >= 2)
  if (ext.length === 1) {
    const p = ext[0].points
    if (p.length >= 4 && same(p[0], p[p.length - 1])) return p.slice(0, -1)
  }
  if (ext.length) {
    const h = hull(ext.flatMap((w) => w.points))
    if (h.length >= 3) return h
  }
  const { grid_width: w, grid_height: h } = grid
  return [
    [0, 0],
    [w, 0],
    [w, h],
    [0, h],
  ]
}
