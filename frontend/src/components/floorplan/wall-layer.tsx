// Pure geometry shared with the 3D room (world.ts imports no three.js) - the
// same span math shapes both views, so a door gap can't sit in two places.
import { wallSegmentsWithOpenings } from "@/components/floorplan3d/world"
import type { FloorPlanWall } from "@/lib/api"

import { CELL } from "./canvas-geometry"
import { doorLeaf, pointAlong, wallThicknessMm } from "./structure"

const px = (v: number) => v * CELL

/** A wall's stroke on the plan: its true thickness on this grid, floored so
 * it always reads. */
export const wallStrokePx = (
  wall: Pick<FloorPlanWall, "thickness_mm">,
  cellMM: number
) => Math.max(3.5, (wallThicknessMm(wall) * CELL) / cellMM)

/**
 * A wall polyline: solid spans broken by door gaps (dashed threshold + jamb
 * ticks across each gap, and the leaf with its swing arc on a door that has
 * one) - the plan-view read of exactly what the 3D wall builds, via the same
 * shared span math. Interactive in Structure mode only: a press on its body
 * selects it and drags it, a double-click cuts it, a press with the Door
 * tool draws a door along it, and a press on a door selects that door. Only
 * the invisible fat hit lines take pointer events, so the visuals can't
 * steal or double-fire a grab.
 */
export function WallShape({
  wall,
  cellMM,
  selected,
  interactive,
  doorArmed,
  selectedDoor = null,
  onBodyDown,
  onSegmentDown,
  onSegmentDoubleClick,
  onDoorDown,
}: {
  wall: FloorPlanWall
  cellMM: number
  selected: boolean
  interactive: boolean
  doorArmed: boolean
  /** The index of the wall's door selected on the plan. */
  selectedDoor?: number | null
  onBodyDown?: (seg: number, e: React.PointerEvent) => void
  /** The Door tool pressed on segment `seg`. */
  onSegmentDown?: (seg: number, e: React.PointerEvent) => void
  onSegmentDoubleClick?: (seg: number, e: React.MouseEvent) => void
  onDoorDown?: (index: number, e: React.PointerEvent) => void
}) {
  if (wall.points.length < 2) return null
  // Walls without a picked color follow the theme (the svg sets
  // text-foreground), so structure reads on light and dark alike.
  const color = wall.color || "currentColor"
  const stroke = wallStrokePx(wall, cellMM)
  const openings = wall.openings
  // Height 1 is a placeholder: plan view only keeps the floor-touching spans.
  const solids = wallSegmentsWithOpenings(wall.points, openings, 1).filter(
    (b) => b.y0 === 0
  )
  const outline = wall.points.map(([x, y]) => `${px(x)},${px(y)}`).join(" ")
  return (
    <g
      data-wall={wall.id}
      pointerEvents={interactive ? "auto" : "none"}
      style={
        interactive
          ? { cursor: doorArmed ? "crosshair" : "move" }
          : undefined
      }
    >
      {selected && (
        <polyline
          points={outline}
          fill="none"
          className="stroke-primary"
          strokeOpacity={0.35}
          strokeWidth={stroke + 5}
          strokeLinecap="round"
          strokeLinejoin="round"
          pointerEvents="none"
        />
      )}
      {solids.map((b, i) => (
        <line
          key={`s${i}`}
          x1={px(b.x0)}
          y1={px(b.z0)}
          x2={px(b.x1)}
          y2={px(b.z1)}
          stroke={color}
          strokeOpacity={0.85}
          strokeWidth={stroke}
          strokeLinecap="square"
          pointerEvents="none"
        />
      ))}
      {openings.map((o, i) => {
        if (!wall.points[o.seg + 1] || o.to <= o.from) return null
        const [x0, y0] = pointAlong(wall.points, o.seg, o.from).map(px)
        const [x1, y1] = pointAlong(wall.points, o.seg, o.to).map(px)
        const len = Math.hypot(x1 - x0, y1 - y0) || 1
        const nx = -(y1 - y0) / len
        const ny = (x1 - x0) / len
        const h = stroke / 2 + 2
        const leaf = doorLeaf(wall.points, o)
        const on = selectedDoor === i
        return (
          <g key={`d${i}`} data-door={i} pointerEvents="none">
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
            {[
              [x0, y0],
              [x1, y1],
            ].map(([jx, jy], k) => (
              <line
                key={k}
                x1={jx - nx * h}
                y1={jy - ny * h}
                x2={jx + nx * h}
                y2={jy + ny * h}
                stroke={color}
                strokeOpacity={0.85}
                strokeWidth={1.5}
              />
            ))}
            {leaf && (
              <>
                <line
                  x1={px(leaf.hinge[0])}
                  y1={px(leaf.hinge[1])}
                  x2={px(leaf.open[0])}
                  y2={px(leaf.open[1])}
                  stroke={color}
                  strokeOpacity={0.85}
                  strokeWidth={1.5}
                />
                <path
                  d={`M ${px(leaf.open[0])} ${px(leaf.open[1])} A ${len} ${len} 0 0 ${leaf.sweep} ${px(leaf.jamb[0])} ${px(leaf.jamb[1])}`}
                  fill="none"
                  stroke={color}
                  strokeOpacity={0.5}
                  strokeWidth={1}
                />
              </>
            )}
            {on && (
              <line
                x1={x0}
                y1={y0}
                x2={x1}
                y2={y1}
                className="stroke-primary"
                strokeOpacity={0.45}
                strokeWidth={stroke + 6}
                strokeLinecap="butt"
              />
            )}
          </g>
        )
      })}
      {interactive &&
        wall.points.slice(0, -1).map(([x, y], i) => {
          const [ex, ey] = wall.points[i + 1]
          return (
            <line
              key={`hit${i}`}
              data-seg={i}
              x1={px(x)}
              y1={px(y)}
              x2={px(ex)}
              y2={px(ey)}
              stroke="transparent"
              strokeWidth={Math.max(stroke + 8, 12)}
              strokeLinecap="round"
              onPointerDown={(e) => {
                if (doorArmed) onSegmentDown?.(i, e)
                else onBodyDown?.(i, e)
              }}
              onDoubleClick={(e) => onSegmentDoubleClick?.(i, e)}
            />
          )
        })}
      {/* A press on a door's gap picks the door (over the wall's line). */}
      {interactive &&
        !doorArmed &&
        openings.map((o, i) => {
          if (!wall.points[o.seg + 1] || o.to <= o.from) return null
          const a = pointAlong(wall.points, o.seg, o.from)
          const b = pointAlong(wall.points, o.seg, o.to)
          return (
            <line
              key={`door-hit${i}`}
              data-door-hit={i}
              x1={px(a[0])}
              y1={px(a[1])}
              x2={px(b[0])}
              y2={px(b[1])}
              stroke="transparent"
              strokeWidth={Math.max(stroke + 8, 12)}
              style={{ cursor: "pointer" }}
              onPointerDown={(e) => onDoorDown?.(i, e)}
            />
          )
        })}
    </g>
  )
}
