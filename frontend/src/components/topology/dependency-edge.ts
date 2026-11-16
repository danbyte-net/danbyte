import type { MarkerType } from "@xyflow/react"

import type { TopoEdge } from "@/lib/api"
import {
  UNKNOWN_SPEED_HEX,
  dependencyStroke,
  edgeLook,
  flowEdgeStyle,
} from "./edge-style"

// A device dependency as a React Flow edge (#450) - the one shape the
// Diagram build and the other tabs' canvas share. It is an overlay
// (overlay-edge.tsx): centre to centre, never part of the layout, in its
// medium's colour and line style, with an arrow at the downstream card. A
// peer link has no arrow. The redundancy group rides on the line as a small
// label, so the upstreams that back each other read as a set.

/** The React Flow parts of a dependency edge: type, marker, label, style. */
export function dependencyEdgeParts(raw: TopoEdge["data"]) {
  const { stroke, dash } = dependencyStroke(raw?.medium)
  const peer = raw?.kind === "peer"
  const look = flowEdgeStyle(edgeLook("dependency", { stroke, dash }))
  return {
    type: "overlay" as const,
    label: raw?.redundancy_group || undefined,
    ...(peer
      ? {}
      : {
          markerEnd: {
            // The enum's value, spelled out: the Diagram builds in a worker
            // that must not load React Flow itself.
            type: "arrowclosed" as MarkerType,
            // A marker takes a plain colour, not a CSS variable.
            color: stroke.startsWith("#") ? stroke : UNKNOWN_SPEED_HEX,
            width: 16,
            height: 16,
          },
        }),
    style: look.style,
    labelStyle: { fontSize: 9, fill: "var(--muted-foreground)" },
  }
}
