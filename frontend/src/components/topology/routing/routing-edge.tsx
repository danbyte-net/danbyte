import { memo, useState } from "react"
import { BaseEdge, EdgeLabelRenderer, useInternalNode } from "@xyflow/react"
import type { EdgeProps } from "@xyflow/react"

import { box } from "../overlay-edge"
import { laneEnds, spotPoint } from "./routing-labels"
import type { LabelSpot } from "./routing-labels"
import type { RoutingEdgeLook } from "./routing-model"

// A line on the Routing tab: straight from card edge to card edge, its
// layer's look (routing-model.ts `routingEdgeLook`), and its label on a
// chip where routing-labels.ts found room for it (`spot`). A label with no
// room, or one the legend says for the whole AS box, shows on hover and
// while the line is selected. Several lines between the same two cards -
// eBGP in two VRFs, a session and its adjacency - run side by side
// (`lane`).

export interface RoutingEdgeData {
  look: RoutingEdgeLook
  /** What it says along it (empty when the legend says it). */
  label: string[]
  /** Its whole label: on hover when it is not on the line. */
  full: string[]
  /** Where `label` sits; null = no room (hover only). */
  spot: LabelSpot | null
  /** Its place among the lines between the same two cards: 0 for the
   * middle one, ±1, ±2… beside it. */
  lane: number
  dimmed?: boolean
  /** A Checks item is on it (with the chip on): drawn over a red halo. */
  flagged?: boolean
  [key: string]: unknown
}

/** The halo under a line a Checks item names. */
export const FLAG_WIDTH = 7

export { LANE_GAP, laneEnds } from "./routing-labels"

export const RoutingEdge = memo(function RoutingEdge({
  id,
  source,
  target,
  data,
  markerEnd,
  selected,
}: EdgeProps) {
  const d = data as RoutingEdgeData
  const [hover, setHover] = useState(false)
  const sb = box(useInternalNode(source))
  const tb = box(useInternalNode(target))
  if (!sb || !tb) return null
  const { a, b } = laneEnds(sb, tb, d.lane)
  const path = `M ${a.x} ${a.y} L ${b.x} ${b.y}`
  const { look } = d
  const opacity = d.dimmed ? 0.15 : look.faint ? 0.5 : 1
  const placed = d.label.length > 0 && !!d.spot
  // Hover (or selection) shows the whole label when the line does not.
  const tip =
    (hover || selected) &&
    d.full.length > 0 &&
    (!placed || d.full.join("\n") !== d.label.join("\n"))
  const chip = (lines: readonly string[], spot: LabelSpot, over = false) => {
    const p = spotPoint(a, b, spot)
    return (
      <div
        data-tip={over ? "" : undefined}
        className="nodrag nopan pointer-events-none absolute rounded-[5px] border border-border bg-background px-[3px] text-center text-[10px] leading-[13px] whitespace-nowrap text-foreground"
        style={{
          transform: `translate(-50%, -50%) translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)`,
          opacity: d.dimmed ? 0.3 : 1,
          // Over every other label while it shows.
          ...(over ? { zIndex: 1001 } : {}),
        }}
      >
        {lines.map((line, i) => (
          <div key={i}>{line}</div>
        ))}
      </div>
    )
  }
  return (
    <g
      data-routing-line={id}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {d.flagged && (
        <path
          d={path}
          data-flag=""
          fill="none"
          stroke="var(--destructive)"
          strokeWidth={look.width + FLAG_WIDTH}
          strokeLinecap="round"
          opacity={d.dimmed ? 0.1 : 0.3}
        />
      )}
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
      {(placed || tip) && (
        <EdgeLabelRenderer>
          {placed && !tip && chip(d.label, d.spot!)}
          {tip && chip(d.full, d.spot ?? { t: 0.5, off: 0 }, true)}
        </EdgeLabelRenderer>
      )}
    </g>
  )
})
