import { BaseEdge, Position } from "@xyflow/react"
import type { EdgeProps } from "@xyflow/react"

// How far a cable travels straight out of its port before it may turn. Keeping
// this generous means a cable clears its own card edge (and its neighbours'
// ports) before bending sideways, instead of jogging across them immediately.
const STUB = 14

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

/** An orthogonal path that leaves the source port straight (a STUB), crosses a
 * staggered mid-channel, then enters the target port straight. Used when no
 * node-avoiding waypoints are available. */
function stubbedPts(
  sx: number,
  sy: number,
  sp: Position,
  tx: number,
  ty: number,
  tp: Position,
  off: number
): [number, number][] {
  const sv = DIR[sp] ?? [1, 0]
  const tv = DIR[tp] ?? [-1, 0]
  const s1: [number, number] = [sx + sv[0] * STUB, sy + sv[1] * STUB]
  const t1: [number, number] = [tx + tv[0] * STUB, ty + tv[1] * STUB]
  const vertical = sp === Position.Top || sp === Position.Bottom
  if (vertical) {
    const chY = (s1[1] + t1[1]) / 2 + off
    return [
      [sx, sy],
      s1,
      [s1[0], chY],
      [t1[0], chY],
      t1,
      [tx, ty],
    ]
  }
  const chX = (s1[0] + t1[0]) / 2 + off
  return [
    [sx, sy],
    s1,
    [chX, s1[1]],
    [chX, t1[1]],
    t1,
    [tx, ty],
  ]
}

/** Rounded orthogonal-ish path through a list of points. */
function roundedPath(pts: [number, number][], r: number): string {
  if (pts.length < 2) return ""
  const dist = (a: [number, number], b: [number, number]) =>
    Math.hypot(a[0] - b[0], a[1] - b[1])
  let d = `M ${pts[0][0]},${pts[0][1]}`
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1]
    const cur = pts[i]
    const next = pts[i + 1]
    const dIn = Math.min(r, dist(prev, cur) / 2)
    const dOut = Math.min(r, dist(cur, next) / 2)
    const inLen = dist(prev, cur) || 1
    const outLen = dist(cur, next) || 1
    const p1: [number, number] = [
      cur[0] - ((cur[0] - prev[0]) / inLen) * dIn,
      cur[1] - ((cur[1] - prev[1]) / inLen) * dIn,
    ]
    const p2: [number, number] = [
      cur[0] + ((next[0] - cur[0]) / outLen) * dOut,
      cur[1] + ((next[1] - cur[1]) / outLen) * dOut,
    ]
    d += ` L ${p1[0]},${p1[1]} Q ${cur[0]},${cur[1]} ${p2[0]},${p2[1]}`
  }
  const last = pts[pts.length - 1]
  d += ` L ${last[0]},${last[1]}`
  return d
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

  if (wp.length < 2) {
    // No node-avoiding waypoints: build a stubbed orthogonal path so the cable
    // leaves its port straight (clearing the card edge + sibling ports) and
    // parallel cables fan into separate channels instead of overlapping.
    const pts = stubbedPts(
      sourceX,
      sourceY,
      sourcePosition,
      targetX,
      targetY,
      targetPosition,
      stagger(id)
    )
    const path = roundedPath(pts, 10)
    const [lx, ly] = pts[Math.floor(pts.length / 2)]
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
  const sv = DIR[sourcePosition] ?? [1, 0]
  const tv = DIR[targetPosition] ?? [-1, 0]
  const s1: [number, number] = [
    sourceX + sv[0] * STUB,
    sourceY + sv[1] * STUB,
  ]
  const t1: [number, number] = [
    targetX + tv[0] * STUB,
    targetY + tv[1] * STUB,
  ]
  // Shared x on the two bends → a vertical channel; shared y → horizontal.
  const verticalChannel = Math.abs(b1[0] - b2[0]) < Math.abs(b1[1] - b2[1])
  const pts: [number, number][] = verticalChannel
    ? [
        [sourceX, sourceY],
        s1,
        [b1[0], s1[1]],
        [b1[0], t1[1]],
        t1,
        [targetX, targetY],
      ]
    : [
        [sourceX, sourceY],
        s1,
        [s1[0], b1[1]],
        [t1[0], b1[1]],
        t1,
        [targetX, targetY],
      ]
  const path = roundedPath(pts, 8)
  const [lx, ly] = pts[2]

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
