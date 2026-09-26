import { BaseEdge, Position, useStore } from "@xyflow/react"
import type { EdgeProps } from "@xyflow/react"

import { channelPts, roundedPath, stubbedPts } from "./diagram/link-geometry"

const DIR: Record<Position, [number, number]> = {
  [Position.Top]: [0, -1],
  [Position.Bottom]: [0, 1],
  [Position.Left]: [-1, 0],
  [Position.Right]: [1, 0],
}

/** Deterministic per-edge offset so cables sharing a run don't stack into one
 * line - each gets its own channel a few px apart. Derived from the edge id so
 * it's stable across renders. */
function stagger(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
  return (((h % 9) + 9) % 9) * 3 - 12 // -12..12 in 3px steps
}

// ── Keeping the label on screen ─────────────────────────────────────────────
// A cable's name belongs at its middle, but on a long run that middle is
// often panned out of sight - so the label rides the visible stretch of the
// cable instead. The viewport rect is quantised before it reaches the edges:
// re-labelling every edge on every pan frame would cost more than the label
// is worth, and a step of one grid square is invisible in use.

const VIEW_STEP = 64
/** Inset so a clamped label never sits half-off the window edge. */
const VIEW_PAD = 40

type Rect = { x0: number; y0: number; x1: number; y1: number }

function useVisibleRect(): Rect | null {
  const key = useStore((s) => {
    const [tx, ty, zoom] = s.transform
    if (!s.width || !s.height) return ""
    const q = (v: number) => Math.round(v / VIEW_STEP) * VIEW_STEP
    return `${q(-tx / zoom)},${q(-ty / zoom)},${Math.round(s.width / zoom)},${Math.round(
      s.height / zoom
    )}`
  })
  if (!key) return null
  const [x, y, w, h] = key.split(",").map(Number)
  const padX = Math.min(VIEW_PAD, w / 4)
  const padY = Math.min(VIEW_PAD, h / 4)
  return { x0: x + padX, y0: y + padY, x1: x + w - padX, y1: y + h - padY }
}

/** Liang-Barsky: the [t0,t1] slice of a segment that lies inside the rect,
 * or null when the segment misses it entirely. */
function clipSegment(
  a: [number, number],
  b: [number, number],
  r: Rect
): [number, number] | null {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  let t0 = 0
  let t1 = 1
  const edges: [number, number][] = [
    [-dx, a[0] - r.x0],
    [dx, r.x1 - a[0]],
    [-dy, a[1] - r.y0],
    [dy, r.y1 - a[1]],
  ]
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null
      continue
    }
    const t = q / p
    if (p < 0) {
      if (t > t1) return null
      if (t > t0) t0 = t
    } else {
      if (t < t0) return null
      if (t < t1) t1 = t
    }
  }
  return [t0, t1]
}

/** Where to put the label: its natural spot when that is on screen, else the
 * middle of the cable's longest visible stretch. */
export function labelPoint(
  pts: [number, number][],
  natural: [number, number],
  rect: Rect | null
): [number, number] {
  if (!rect) return natural
  const inside =
    natural[0] >= rect.x0 &&
    natural[0] <= rect.x1 &&
    natural[1] >= rect.y0 &&
    natural[1] <= rect.y1
  if (inside) return natural
  let best: [number, number] | null = null
  let bestLen = 0
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    const slice = clipSegment(a, b, rect)
    if (!slice) continue
    const [t0, t1] = slice
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) * (t1 - t0)
    if (len <= bestLen) continue
    bestLen = len
    const t = (t0 + t1) / 2
    best = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
  }
  return best ?? natural
}

/**
 * An edge that routes along Dagre's node-avoiding waypoints (passed in
 * `data.waypoints`, flow coords), so a long cable bends around intervening
 * cards instead of cutting through them. Falls back to smoothstep when it
 * has no waypoints.
 */
export function RoutedEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  style,
  markerEnd,
  label,
  labelStyle,
  labelShowBg,
  labelBgStyle,
  labelBgPadding,
  labelBgBorderRadius,
}: EdgeProps) {
  const wp = (data?.waypoints as [number, number][] | undefined) ?? []
  const rect = useVisibleRect()

  if (wp.length < 2) {
    // No node-avoiding waypoints: build a stubbed orthogonal path so the cable
    // leaves its port straight (clearing the card edge + sibling ports) and
    // parallel cables fan into separate channels instead of overlapping.
    const pts = stubbedPts(
      sourceX,
      sourceY,
      DIR[sourcePosition] ?? [1, 0],
      targetX,
      targetY,
      DIR[targetPosition] ?? [-1, 0],
      stagger(id)
    )
    const path = roundedPath(pts, 10)
    const [lx, ly] = labelPoint(
      pts,
      pts[Math.floor(pts.length / 2)],
      rect
    )
    return (
      <BaseEdge
        id={id}
        path={path}
        style={style}
        markerEnd={markerEnd}
        label={label}
        labelX={lx}
        labelY={ly}
        labelStyle={labelStyle}
        labelShowBg={labelShowBg}
        labelBgStyle={labelBgStyle}
        labelBgPadding={labelBgPadding}
        labelBgBorderRadius={labelBgBorderRadius}
      />
    )
  }

  // The two interior bends encode one clear "channel" - a fixed coordinate
  // the cable routes through. Build the path direction-aware: leave the
  // source port straight along ITS side, cross the channel, enter the target
  // straight along ITS side - anchoring bends to raw handle positions used
  // to loop cables around their own cards.
  const [b1, b2] = wp
  const pts = channelPts(
    sourceX,
    sourceY,
    DIR[sourcePosition] ?? [1, 0],
    targetX,
    targetY,
    DIR[targetPosition] ?? [-1, 0],
    b1,
    b2
  )
  const path = roundedPath(pts, 8)
  const [lx, ly] = labelPoint(pts, pts[2], rect)

  return (
    <BaseEdge
      id={id}
      path={path}
      style={style}
      markerEnd={markerEnd}
      label={label}
      labelX={lx}
      labelY={ly}
      labelStyle={labelStyle}
      labelShowBg={labelShowBg}
      labelBgStyle={labelBgStyle}
      labelBgPadding={labelBgPadding}
      labelBgBorderRadius={labelBgBorderRadius}
    />
  )
}
