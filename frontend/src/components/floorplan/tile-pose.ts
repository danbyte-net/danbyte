import { tileQuarter, tileResidual } from "./shapes"

/**
 * Where a tile stands, turned, in cell units - the ONE transform the 2D
 * canvas, the export and the 3D room all place a tile by.
 *
 * A tile's stored rectangle (x, y, w, h) is its footprint at the nearest
 * quarter turn: a quarter turn swaps width and height (as on a grid plan).
 * On a free plan it is then drawn turned about its centre by what its angle
 * has beyond that quarter turn (the residual, at most 45° either way). A grid
 * plan only stores quarter turns, so its residual is always 0.
 *
 * Two equivalent ways to draw it:
 * - a symmetric box (zone, planning tile): the stored footprint, axis-aligned,
 *   turned by `residual`;
 * - something with a front (rack, cabinet, device): its own size facing 0°
 *   (`local`), turned by the full `orientation`.
 *
 * Angles are clockwise on the plan (y down), as SVG `rotate()` reads them.
 */
export interface TilePose {
  /** Centre, cells. */
  cx: number
  cy: number
  /** The stored footprint (at the quarter turn), cells. */
  w: number
  h: number
  /** The footprint facing 0° - width along the front, depth front to back. */
  local: { w: number; h: number }
  /** The quarter turn the footprint is stored at: 0, 90, 180 or 270. */
  quarter: number
  /** The turn drawn beyond the quarter turn, degrees in (-45, 45]. */
  residual: number
  /** The whole facing, degrees [0, 360). */
  orientation: number
}

export function tilePose(t: {
  x: number
  y: number
  w: number
  h: number
  orientation: number
}): TilePose {
  const orientation = ((t.orientation % 360) + 360) % 360
  const quarter = tileQuarter(orientation)
  const turned = quarter % 180 === 90
  return {
    cx: t.x + t.w / 2,
    cy: t.y + t.h / 2,
    w: t.w,
    h: t.h,
    local: turned ? { w: t.h, h: t.w } : { w: t.w, h: t.h },
    quarter,
    residual: tileResidual(orientation),
    orientation,
  }
}

/** The pose of a plan tile (width/height fields). */
export function planTilePose(t: {
  x: number
  y: number
  width: number
  height: number
  orientation: number
}): TilePose {
  return tilePose({
    x: t.x,
    y: t.y,
    w: t.width,
    h: t.height,
    orientation: t.orientation,
  })
}

/** The SVG transform that turns a tile's drawing by its residual about its
 * centre (plan px at `cell` px per cell); "" when it is not turned. */
export function residualTransform(pose: TilePose, cell: number): string {
  if (!pose.residual) return ""
  return `rotate(${+pose.residual.toFixed(4)},${+(pose.cx * cell).toFixed(3)},${+(pose.cy * cell).toFixed(3)})`
}

/** The four corners of a tile as drawn (cells), turned by its residual. */
export function poseCorners(pose: TilePose): [number, number][] {
  const a = (pose.residual * Math.PI) / 180
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  const hw = pose.w / 2
  const hh = pose.h / 2
  const local: [number, number][] = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ]
  return local.map(([x, y]) => [
    pose.cx + x * cos - y * sin,
    pose.cy + x * sin + y * cos,
  ])
}

/** The axis-aligned bounds of a tile as drawn (cells). */
export function poseBounds(pose: TilePose): {
  minX: number
  minY: number
  maxX: number
  maxY: number
} {
  const c = poseCorners(pose)
  const xs = c.map((p) => p[0])
  const ys = c.map((p) => p[1])
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  }
}

/** A plan point (cells) in the tile's own unturned frame, from its centre:
 * x along its stored width, y along its stored height. */
export function poseLocal(
  pose: TilePose,
  p: [number, number]
): [number, number] {
  const a = (-pose.residual * Math.PI) / 180
  const dx = p[0] - pose.cx
  const dy = p[1] - pose.cy
  return [
    dx * Math.cos(a) - dy * Math.sin(a),
    dx * Math.sin(a) + dy * Math.cos(a),
  ]
}

/** Whether a plan point (cells) lies on the tile as drawn. */
export function poseContains(pose: TilePose, p: [number, number]): boolean {
  const [x, y] = poseLocal(pose, p)
  const eps = 1e-9
  return Math.abs(x) <= pose.w / 2 + eps && Math.abs(y) <= pose.h / 2 + eps
}

/** A plan angle (clockwise, degrees) as a three.js turn about +Y: the room
 * lays plan x on world x and plan y on world z, so clockwise from above is
 * a negative turn. */
export function planAngleToRotY(deg: number): number {
  return deg === 0 ? 0 : (-deg * Math.PI) / 180
}
