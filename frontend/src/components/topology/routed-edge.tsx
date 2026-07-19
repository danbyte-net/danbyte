import { BaseEdge, getSmoothStepPath } from "@xyflow/react"
import type { EdgeProps } from "@xyflow/react"

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
    const [path, lx, ly] = getSmoothStepPath({
      sourceX,
      sourceY,
      sourcePosition: sourcePosition,
      targetX,
      targetY,
      targetPosition: targetPosition,
      borderRadius: 14,
    })
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

  // The two interior bends encode one clear "channel" — a fixed main-axis
  // coordinate the cable routes through. Rebuild a clean orthogonal Z anchored
  // at the ACTUAL handle positions (not the centre-based bends), so the cable
  // leaves its port straight instead of kinking diagonally toward a centre.
  const [b1, b2] = wp
  // Shared x on the two bends → a vertical channel (side-to-side layout);
  // shared y → a horizontal channel (tree layout).
  const verticalChannel = Math.abs(b1[0] - b2[0]) < Math.abs(b1[1] - b2[1])
  const pts: [number, number][] = verticalChannel
    ? [
        [sourceX, sourceY],
        [b1[0], sourceY],
        [b1[0], targetY],
        [targetX, targetY],
      ]
    : [
        [sourceX, sourceY],
        [sourceX, b1[1]],
        [targetX, b1[1]],
        [targetX, targetY],
      ]
  const path = roundedPath(pts, 14)
  const [lx, ly] = pts[verticalChannel ? 1 : 2]

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
