// Pure geometry shared with the 3D room (world.ts imports no three.js) - the
// same span math shapes both views, so a door gap can't sit in two places.
import {
  WALL_THICKNESS_M,
  wallDoorSpans,
  wallSegmentsWithOpenings,
} from "@/components/floorplan3d/world"
import type { FloorPlanWall } from "@/lib/api"

import { CELL } from "./canvas-geometry"

/**
 * A wall polyline: solid spans broken by door gaps (dashed threshold + jamb
 * ticks across each gap) - the plan-view read of exactly what the 3D wall
 * builds, via the same shared span math. Interactive only in Structure mode:
 * click selects, drag translates the whole run, and with "Add door" armed a
 * click on a segment drops an opening there. Only the invisible fat
 * per-segment hit lines take pointer events, so the visuals can't steal or
 * double-fire a grab.
 */
export function WallShape({
  wall,
  cellMM,
  selected,
  interactive,
  editable,
  doorArmed,
  onPointerDown,
  onSegmentClick,
}: {
  wall: FloorPlanWall
  cellMM: number
  selected: boolean
  interactive: boolean
  editable: boolean
  doorArmed: boolean
  onPointerDown: (e: React.PointerEvent) => void
  onSegmentClick: (seg: number, e: React.PointerEvent) => void
}) {
  if (wall.points.length < 2) return null
  // Walls without a picked color follow the theme (the svg sets
  // text-foreground), so structure reads on light and dark alike.
  const color = wall.color || "currentColor"
  // True thickness on this grid (0.1 m), floored so it always reads.
  const px = Math.max(3.5, (WALL_THICKNESS_M * 1000 * CELL) / cellMM)
  const openings = wall.openings
  // Height 1 is a placeholder: plan view only keeps the floor-touching spans.
  const solids = wallSegmentsWithOpenings(wall.points, openings, 1).filter(
    (b) => b.y0 === 0
  )
  const doors = wallDoorSpans(wall.points, openings)
  const outline = wall.points
    .map(([x, y]) => `${x * CELL},${y * CELL}`)
    .join(" ")
  return (
    <g
      pointerEvents={interactive ? "auto" : "none"}
      style={
        interactive
          ? {
              cursor: doorArmed ? "crosshair" : editable ? "move" : "pointer",
            }
          : undefined
      }
    >
      <title>
        {wall.label || "Wall"}
        {wall.height_mm ? ` · ${wall.height_mm} mm` : ""}
        {doors.length
          ? ` · ${doors.length} door${doors.length === 1 ? "" : "s"}`
          : ""}
      </title>
      {selected && (
        <polyline
          points={outline}
          fill="none"
          stroke="#0ea5e9"
          strokeOpacity={0.45}
          strokeWidth={px + 5}
          strokeLinecap="round"
          strokeLinejoin="round"
          pointerEvents="none"
        />
      )}
      {solids.map((b, i) => (
        <line
          key={`s${i}`}
          x1={b.x0 * CELL}
          y1={b.z0 * CELL}
          x2={b.x1 * CELL}
          y2={b.z1 * CELL}
          stroke={color}
          strokeOpacity={0.85}
          strokeWidth={px}
          strokeLinecap="square"
          pointerEvents="none"
        />
      ))}
      {doors.map((dv, i) => {
        const x0 = dv.x0 * CELL
        const y0 = dv.z0 * CELL
        const x1 = dv.x1 * CELL
        const y1 = dv.z1 * CELL
        const len = Math.hypot(x1 - x0, y1 - y0) || 1
        const nx = -(y1 - y0) / len
        const ny = (x1 - x0) / len
        const h = px / 2 + 2
        return (
          <g key={`d${i}`} pointerEvents="none">
            {/* Threshold across the gap + a jamb tick at each end. */}
            <line
              x1={x0}
              y1={y0}
              x2={x1}
              y2={y1}
              stroke={color}
              strokeOpacity={0.5}
              strokeWidth={1.5}
              strokeDasharray="3 3"
            />
            <line
              x1={x0 - nx * h}
              y1={y0 - ny * h}
              x2={x0 + nx * h}
              y2={y0 + ny * h}
              stroke={color}
              strokeOpacity={0.85}
              strokeWidth={1.5}
            />
            <line
              x1={x1 - nx * h}
              y1={y1 - ny * h}
              x2={x1 + nx * h}
              y2={y1 + ny * h}
              stroke={color}
              strokeOpacity={0.85}
              strokeWidth={1.5}
            />
          </g>
        )
      })}
      {interactive &&
        wall.points.slice(0, -1).map(([x, y], i) => {
          const [ex, ey] = wall.points[i + 1]
          return (
            <line
              key={`hit${i}`}
              x1={x * CELL}
              y1={y * CELL}
              x2={ex * CELL}
              y2={ey * CELL}
              stroke="transparent"
              strokeWidth={Math.max(px + 8, 12)}
              strokeLinecap="round"
              onPointerDown={(e) => {
                if (doorArmed) onSegmentClick(i, e)
                else onPointerDown(e)
              }}
            />
          )
        })}
      {selected &&
        editable &&
        wall.points.map(([x, y], i) => (
          <circle
            key={`v${i}`}
            cx={x * CELL}
            cy={y * CELL}
            r={3.5}
            fill="var(--background)"
            stroke={color}
            strokeWidth={1.5}
            pointerEvents="none"
          />
        ))}
    </g>
  )
}
