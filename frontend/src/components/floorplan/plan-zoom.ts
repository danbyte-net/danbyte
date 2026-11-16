import {
  DETAIL_ENTER_PX_PER_M,
  ROOM_ENTER_PX_PER_M,
  detailLevel,
  pxPerMetre,
} from "./plan-detail"
import type { DetailLevel } from "./plan-detail"
import type { PlanRoom } from "./plan-lod"
import type { Pt } from "./shapes"
import type { Transform } from "./use-pan-zoom"

// Click to zoom (View, Detail: Auto): from afar a click on a room zooms and
// pans to fit it, a click on a row's bar to the row - eased, as the 3D
// room's fly-to is. Units: cells unless said; px on screen.

/** The view's margin round what it fits (px), as Fit to view keeps. */
export const ZOOM_MARGIN_PX = 64
/** Closer than this a click does not zoom (the plan's own limit). */
export const ZOOM_MAX_K = 4
/** A room's fit counts as a zoom in from this much closer. */
const ZOOM_IN_STEP = 1.25
/** How long a zoom eases (ms). */
export const ZOOM_MS = 360

/** Ease in and out (cubic) - the 3D fly-to's (camera-math.ts). */
export function easeInOut(p: number): number {
  const q = Math.max(0, Math.min(1, p))
  return q < 0.5 ? 4 * q ** 3 : 1 - (-2 * q + 2) ** 3 / 2
}

/** The view `p` (0-1) of the way from `a` to `b`, eased: the zoom goes
 * evenly in scale (log), the point at the middle of the screen straight. */
export function viewAt(
  a: Transform,
  b: Transform,
  p: number,
  vw: number,
  vh: number
): Transform {
  const e = easeInOut(p)
  if (e >= 1) return b
  if (e <= 0) return a
  const k = Math.exp(Math.log(a.k) + (Math.log(b.k) - Math.log(a.k)) * e)
  // The world point at the middle of the screen, from one to the other.
  const ca = [(vw / 2 - a.x) / a.k, (vh / 2 - a.y) / a.k]
  const cb = [(vw / 2 - b.x) / b.k, (vh / 2 - b.y) / b.k]
  const cx = ca[0] + (cb[0] - ca[0]) * e
  const cy = ca[1] + (cb[1] - ca[1]) * e
  return { k, x: vw / 2 - cx * k, y: vh / 2 - cy * k }
}

/** The zoom (k) at which a metre of the plan is `ppm` px on screen. */
export function kForPpm(ppm: number, cellMm: number, cell: number): number {
  return cellMm > 0 ? (ppm * cellMm) / 1000 / cell : ppm / cell
}

/** A room's upright extent (cells): its turned frame's bounding box. */
export function roomBox(r: PlanRoom): {
  x: number
  y: number
  w: number
  h: number
} {
  const a = (r.rotation * Math.PI) / 180
  const c = Math.abs(Math.cos(a))
  const s = Math.abs(Math.sin(a))
  const hw = r.hw * c + r.hh * s
  const hh = r.hw * s + r.hh * c
  return { x: r.c[0] - hw, y: r.c[1] - hh, w: hw * 2, h: hh * 2 }
}

/** The view that fits a box (cells) on a `vw` x `vh` screen, no closer
 * than `minK` and no closer than the plan allows. */
export function fitBoxView(
  box: { x: number; y: number; w: number; h: number },
  vw: number,
  vh: number,
  {
    cell,
    minK = 0,
    margin = ZOOM_MARGIN_PX,
  }: { cell: number; minK?: number; margin?: number }
): Transform {
  const w = Math.max(box.w * cell, 1)
  const h = Math.max(box.h * cell, 1)
  const fit = Math.min(
    Math.max(vw - margin, 1) / w,
    Math.max(vh - margin, 1) / h
  )
  const k = Math.min(ZOOM_MAX_K, Math.max(fit, minK))
  const cx = (box.x + box.w / 2) * cell
  const cy = (box.y + box.h / 2) * cell
  return { k, x: vw / 2 - cx * k, y: vh / 2 - cy * k }
}

/** The view a click on a room zooms to: it fitted. */
export function roomZoomView(
  room: PlanRoom,
  vw: number,
  vh: number,
  { cell }: { cell: number }
): Transform {
  return fitBoxView(roomBox(room), vw, vh, { cell })
}

/** The zoom (k) a click takes a room to when its fit is still the
 * overview: the room level, a little past its threshold. */
export function roomLevelK(cellMm: number, cell: number): number {
  return kForPpm(ROOM_ENTER_PX_PER_M * 1.15, cellMm, cell)
}

/** The least a click on a row's bar zooms to: the detail level. */
export function rowZoomMinK(cellMm: number, cell: number): number {
  return kForPpm(DETAIL_ENTER_PX_PER_M * 1.1, cellMm, cell)
}

/**
 * What a click at `p` zooms to: of the rooms round it, the biggest whose
 * fit is a zoom in - a campus's building, then the building's hall, then
 * a cage in it - fitted, with the level it lands at. A room fitted and
 * still seen from afar (a big building on a campus) has nothing smaller
 * to fit: the next click goes in to the room level about the point. Null
 * when the room round it already fills the screen at the room level or
 * closer (the click opens the area then), or no room is round it.
 */
export function clickZoomTarget(
  rooms: readonly PlanRoom[],
  p: Pt,
  view: Transform,
  vw: number,
  vh: number,
  {
    cell,
    cellMm,
    hasRooms = true,
  }: { cell: number; cellMm: number; hasRooms?: boolean }
): { room: PlanRoom; view: Transform; level: DetailLevel } | null {
  if (!(vw > 0 && vh > 0)) return null
  const levelAt = (k: number) =>
    detailLevel(pxPerMetre(cell * k, cellMm), null, { rooms: hasRooms })
  const round = rooms
    .filter((r) => r.contains(p))
    .sort((a, b) => b.size - a.size || (a.id < b.id ? -1 : 1))
  for (const room of round) {
    const v = roomZoomView(room, vw, vh, { cell })
    if (v.k < view.k * ZOOM_IN_STEP) continue
    return { room, view: v, level: levelAt(v.k) }
  }
  const inner = round.at(-1)
  const k = Math.min(ZOOM_MAX_K, roomLevelK(cellMm, cell))
  if (!inner || levelAt(view.k) !== "overview" || k < view.k * ZOOM_IN_STEP)
    return null
  const cx = p[0] * cell
  const cy = p[1] * cell
  return {
    room: inner,
    view: { k, x: vw / 2 - cx * k, y: vh / 2 - cy * k },
    level: levelAt(k),
  }
}
