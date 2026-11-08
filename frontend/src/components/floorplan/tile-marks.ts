/**
 * Where a rack tile's two edge marks sit: the facing bar (the edge its
 * front points at) and the figure bar (its capacity, along the foot).
 * Shared by the canvas (tile-layer.tsx) and the SVG/PDF export
 * (plan-svg.ts) so the two never drift apart. Plan px, tile-local: (0,0)
 * is the tile's top-left corner of its full cell footprint.
 */
import { GUTTER } from "./canvas-geometry"

export interface MarkRect {
  x: number
  y: number
  width: number
  height: number
}

/** Facing bar thickness. */
export const FACING_T = 3
/** The facing bar sits just inside the tile's stroke. */
const FACING_EDGE = 1.5
/** Corner clearance, keeping the rounded corners clean. */
const FACING_INSET = 7
/** Figure bar height. */
export const FIGURE_H = 4
/** Figure bar's gap above the tile's inner bottom edge. */
const FIGURE_FOOT = 3
/** Clear space between the facing bar and the figure bar. */
const MARK_GAP = 2

/** The facing quarter: 0 up, 90 right, 180 down, 270 left. */
function quarter(orientation: number): number {
  return (((Math.round(orientation / 90) * 90) % 360) + 360) % 360
}

/**
 * How far the figure bar (and its text) lifts off its usual place: a front
 * facing down takes the foot, so the figure moves up clear of it.
 */
export function figureLift(orientation: number): number {
  if (quarter(orientation) !== 180) return 0
  const facingTop = FACING_EDGE + FACING_T // from the inner bottom edge
  return Math.max(0, facingTop + MARK_GAP - FIGURE_FOOT)
}

/** The figure bar's track, for a tile w x h facing `orientation`. */
export function figureBarRect(
  w: number,
  h: number,
  orientation: number
): MarkRect {
  return {
    x: GUTTER + 3,
    y: h - GUTTER - FIGURE_FOOT - FIGURE_H - figureLift(orientation),
    width: Math.max(0, w - GUTTER * 2 - 6),
    height: FIGURE_H,
  }
}

/**
 * The facing bar, for a tile w x h facing `orientation`. With a figure
 * bar on the tile, a side-facing bar stops short of it.
 */
export function facingBarRect(
  w: number,
  h: number,
  orientation: number,
  withFigure = false
): MarkRect {
  const iw = w - GUTTER * 2
  const ih = h - GUTTER * 2
  const q = quarter(orientation)
  if (q === 0 || q === 180) {
    const y = q === 0 ? FACING_EDGE : ih - FACING_EDGE - FACING_T
    return {
      x: GUTTER + FACING_INSET,
      y: GUTTER + y,
      width: Math.max(0, iw - FACING_INSET * 2),
      height: FACING_T,
    }
  }
  const x = q === 90 ? iw - FACING_EDGE - FACING_T : FACING_EDGE
  const top = FACING_INSET
  let bottom = ih - FACING_INSET
  if (withFigure) {
    const figTop = figureBarRect(w, h, orientation).y - GUTTER
    bottom = Math.min(bottom, figTop - MARK_GAP)
  }
  return {
    x: GUTTER + x,
    y: GUTTER + top,
    width: FACING_T,
    height: Math.max(0, bottom - top),
  }
}

/** True when two rects share any area. */
export function marksOverlap(a: MarkRect, b: MarkRect): boolean {
  return (
    a.width > 0 &&
    a.height > 0 &&
    b.width > 0 &&
    b.height > 0 &&
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  )
}
