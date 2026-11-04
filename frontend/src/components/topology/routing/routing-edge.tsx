import { memo } from "react"
import { BaseEdge, EdgeLabelRenderer, useInternalNode } from "@xyflow/react"
import type { EdgeProps } from "@xyflow/react"

import { box, exitPoint } from "../overlay-edge"
import type { Box } from "../overlay-edge"
import type { RoutingEdgeLook } from "./routing-model"

// A line on the Routing tab: straight from card edge to card edge, its
// layer's look (routing-model.ts `routingEdgeLook`), and its label on a
// chip at the middle. Several lines between the same two cards - eBGP in
// two VRFs, a session and its cable - run side by side (`lane`).

export interface RoutingEdgeData {
  look: RoutingEdgeLook
  label: string[]
  /** Its place among the lines between the same two cards: 0 for the
   * middle one, ±1, ±2… beside it. */
  lane: number
  dimmed?: boolean
  [key: string]: unknown
}

/** How far apart side-by-side lines run, px. */
export const LANE_GAP = 12

/** The two ends of a line between boxes `s` and `t`, moved `lane` lanes
 * to its side. */
export function laneEnds(s: Box, t: Box, lane: number) {
  const a = exitPoint(s, t)
  const b = exitPoint(t, s)
  if (!lane) return { a, b }
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy) || 1
  // Perpendicular, the same way whichever end is the source.
  const flip = s.x + s.y <= t.x + t.y ? 1 : -1
  const ox = (-dy / len) * lane * LANE_GAP * flip
  const oy = (dx / len) * lane * LANE_GAP * flip
  return {
    a: { x: a.x + ox, y: a.y + oy },
    b: { x: b.x + ox, y: b.y + oy },
  }
}

export const RoutingEdge = memo(function RoutingEdge({
  id,
  source,
  target,
  data,
  markerEnd,
  selected,
}: EdgeProps) {
  const d = data as RoutingEdgeData
  const sb = box(useInternalNode(source))
  const tb = box(useInternalNode(target))
  if (!sb || !tb) return null
  const { a, b } = laneEnds(sb, tb, d.lane)
  const path = `M ${a.x} ${a.y} L ${b.x} ${b.y}`
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  const { look } = d
  const opacity = d.dimmed ? 0.15 : look.faint ? 0.5 : 1
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={look.arrow ? markerEnd : undefined}
        interactionWidth={14}
        style={{
          stroke: look.stroke,
          strokeWidth: selected ? look.width + 1.5 : look.width,
          strokeDasharray: look.dash,
          opacity,
        }}
      />
      {d.label.length > 0 && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-none absolute rounded-[5px] border border-border bg-background px-1 text-center text-[10px] leading-[13px] whitespace-nowrap text-foreground"
            style={{
              transform: `translate(-50%, -50%) translate(${Math.round(mid.x)}px, ${Math.round(mid.y)}px)`,
              opacity: d.dimmed ? 0.3 : 1,
            }}
          >
            {d.label.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
})
