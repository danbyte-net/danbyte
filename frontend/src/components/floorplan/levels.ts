import type { FloorPlanFloor } from "@/lib/api"

/** Building levels (aligned floors): shared helpers for the level picker,
 * the onion skin, the Align dialog and the 3D building. */

/** "+3.3 m", "−2.8 m", "0.0 m" - a level's elevation as the picker reads it. */
export function elevationLabel(mm: number | null | undefined): string {
  if (mm == null) return ""
  const m = mm / 1000
  const body = Math.abs(m).toFixed(1)
  if (Math.abs(m) < 0.05) return `${(0).toFixed(1)} m`
  return `${m < 0 ? "−" : "+"}${body} m`
}

/** The next free basement name: B1, B2… */
export function nextBasementName(floors: { name: string }[]): string {
  const taken = new Set(floors.map((f) => f.name.toUpperCase()))
  for (let n = 1; ; n++) if (!taken.has(`B${n}`)) return `B${n}`
}

/** The next free name above: the highest numbered floor plus one, else "1". */
export function nextFloorName(floors: { name: string }[]): string {
  const taken = new Set(floors.map((f) => f.name))
  const nums = floors
    .map((f) => (/^\d+$/.test(f.name) ? Number(f.name) : null))
    .filter((n): n is number => n != null)
  let n = nums.length ? Math.max(...nums) + 1 : 1
  while (taken.has(String(n))) n++
  return String(n)
}

/** Alignment of one level: offset (cells) and turn (degrees about the
 * grid's centre) against the stack's frame. */
export interface LevelAlign {
  dx: number
  dy: number
  rot: number
}

export function levelAlign(f: {
  align_dx?: number
  align_dy?: number
  align_rot?: number
}): LevelAlign {
  return { dx: f.align_dx ?? 0, dy: f.align_dy ?? 0, rot: f.align_rot ?? 0 }
}

/** A point of a level (its cells) in the stack's frame, in mm. */
export function levelToFrameMm(
  p: [number, number],
  grid: { grid_width: number; grid_height: number; cell_mm: number },
  a: LevelAlign
): [number, number] {
  const cx = grid.grid_width / 2
  const cy = grid.grid_height / 2
  const r = (a.rot * Math.PI) / 180
  const x = p[0] - cx
  const y = p[1] - cy
  const rx = x * Math.cos(r) - y * Math.sin(r) + cx + a.dx
  const ry = x * Math.sin(r) + y * Math.cos(r) + cy + a.dy
  return [rx * grid.cell_mm, ry * grid.cell_mm]
}

/** A point of the stack's frame (mm) in a level's cells - the inverse. */
export function frameMmToLevel(
  p: [number, number],
  grid: { grid_width: number; grid_height: number; cell_mm: number },
  a: LevelAlign
): [number, number] {
  const cx = grid.grid_width / 2
  const cy = grid.grid_height / 2
  const r = (-a.rot * Math.PI) / 180
  const x = p[0] / grid.cell_mm - cx - a.dx
  const y = p[1] / grid.cell_mm - cy - a.dy
  return [
    x * Math.cos(r) - y * Math.sin(r) + cx,
    x * Math.sin(r) + y * Math.cos(r) + cy,
  ]
}

/** A point of level `from` (its cells) in level `to`'s cells. */
export function levelToLevel(
  p: [number, number],
  from: FloorPlanFloor,
  to: FloorPlanFloor
): [number, number] {
  return frameMmToLevel(
    levelToFrameMm(p, gridOf(from), levelAlign(from)),
    gridOf(to),
    levelAlign(to)
  )
}

export function gridOf(f: {
  grid_width?: number
  grid_height?: number
  cell_mm?: number
}) {
  return {
    grid_width: f.grid_width ?? 24,
    grid_height: f.grid_height ?? 16,
    cell_mm: f.cell_mm ?? 600,
  }
}

/** The levels below and above `id` in `floors` (lowest first), plan kind
 * only - a live view is no level of a building. */
export function neighbours(floors: FloorPlanFloor[], id: string) {
  const levels = floors.filter((f) => f.kind !== "view")
  const i = levels.findIndex((f) => f.id === id)
  return {
    below: i > 0 ? levels[i - 1] : null,
    above: i >= 0 && i < levels.length - 1 ? levels[i + 1] : null,
  }
}
