import { getViewportForBounds } from "@xyflow/react"
import type { FitViewOptions, Rect } from "@xyflow/react"

// A map's fit, kept clear of the open legend in its bottom-left corner. The
// legend sits over the canvas; a fit that ignores it can put a card - the
// one Critical device on the map - under it. The fit keeps the map above
// the legend or beside it, whichever frames the map larger: a wide map
// gives up a strip along the foot, a tall one a strip down the side.

type Padding = NonNullable<FitViewOptions["padding"]>

export interface Sides {
  top: number
  right: number
  bottom: number
  left: number
}

/** One side's padding in px, as React Flow reads it: a bare number is a
 * share of the screen split over both sides, else px or %. */
function px(p: number | string | undefined, viewport: number): number {
  if (p === undefined) return 0
  if (typeof p === "number")
    return Math.floor((viewport - viewport / (1 + p)) * 0.5)
  const v = parseFloat(p)
  if (Number.isNaN(v)) return 0
  return Math.floor(p.endsWith("%") ? viewport * v * 0.01 : v)
}

/** A fit's padding as px per side, for a `width` × `height` screen. */
export function paddingSides(
  padding: Padding,
  width: number,
  height: number
): Sides {
  if (typeof padding !== "object") {
    const x = px(padding, width)
    const y = px(padding, height)
    return { top: y, right: x, bottom: y, left: x }
  }
  return {
    top: px(padding.top ?? padding.y, height),
    right: px(padding.right ?? padding.x, width),
    bottom: px(padding.bottom ?? padding.y, height),
    left: px(padding.left ?? padding.x, width),
  }
}

/** Room left between the legend and the map. */
const GAP = 12

/** Padding in px per side, as React Flow takes it. */
type SidesPx = Record<keyof Sides, `${number}px`>

const asPx = (s: Sides): SidesPx => ({
  top: `${s.top}px`,
  right: `${s.right}px`,
  bottom: `${s.bottom}px`,
  left: `${s.left}px`,
})

/**
 * The padding that fits `bounds` on a `width` × `height` screen clear of a
 * box in its bottom-left corner - `reach` is how far the box reaches in
 * from the left edge and up from the bottom edge, px: above the box or
 * beside it, whichever leaves the map larger (above on a tie).
 */
export function clearOfCorner(
  bounds: Rect,
  width: number,
  height: number,
  padding: Padding,
  reach: { w: number; h: number },
  maxZoom: number
): SidesPx {
  const s = paddingSides(padding, width, height)
  const above = { ...s, bottom: Math.max(s.bottom, Math.ceil(reach.h) + GAP) }
  const beside = { ...s, left: Math.max(s.left, Math.ceil(reach.w) + GAP) }
  const zoom = (p: Sides) =>
    getViewportForBounds(bounds, width, height, 0, maxZoom, asPx(p)).zoom
  return asPx(zoom(beside) > zoom(above) ? beside : above)
}
