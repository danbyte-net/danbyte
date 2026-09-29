import { forwardRef, useMemo } from "react"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type {
  BulkStatusResponse,
  GhostEdgeData,
  TopologyGraph,
} from "@/lib/api"
import { CanvasLegend, graphLegend } from "./legend"
import { TopologyCanvas } from "./topology-canvas"
import type { CanvasHandle, TopologyCanvasProps } from "./topology-canvas"

// The Diagram as other pages embed it: a device's Map tab and the trace
// maps. Detailed cards in their role's colour with a nub per cabled
// interface, Elbow lines with the port names and addresses on their own
// cable, the device the map is about outlined, and a trace's run drawn
// thick in the accent colour. No overview in the corner - it would cover
// a small map's cards - and a compact legend waiting on its chip. Loaded
// lazily with the canvas, so React Flow stays out of the pages' own
// bundles.

/** Where an embedded map's legend is remembered open or closed - apart
 * from the Topology page's own. */
const LEGEND_KEY = "topology:legend:embedded"

/** The map's cards' monitoring states, when some card lists the
 * monitoring pill (`meta.card.uses_monitor`). */
function useCardMonitor(graph: TopologyGraph) {
  const on = !!graph.meta?.card?.uses_monitor
  const ids = useMemo(
    () =>
      graph.nodes
        .map((n) => n.data.device_id)
        .filter((x): x is string => !!x)
        .sort(),
    [graph]
  )
  const q = useQuery({
    // The Topology page's key: the same devices share one answer.
    queryKey: ["device-mon-status", ids],
    queryFn: () =>
      api<BulkStatusResponse>("/api/monitoring/status/", {
        method: "POST",
        body: JSON.stringify({ devices: ids }),
      }),
    enabled: on && ids.length > 0,
    staleTime: 30_000,
  })
  return on ? q.data?.statuses : undefined
}

export interface EmbeddedMapProps {
  graph: TopologyGraph
  /** The device the map is about: outlined. */
  focusNodeId?: string
  direction?: "LR" | "TB"
  onGhostEdge?: (ghost: GhostEdgeData) => void
  onSelectNode?: TopologyCanvasProps["onSelectNode"]
  onSelectEdge?: TopologyCanvasProps["onSelectEdge"]
}

export const EmbeddedMap = forwardRef<CanvasHandle, EmbeddedMapProps>(
  function EmbeddedMap(
    { graph, focusNodeId, direction = "LR", ...handlers },
    ref
  ) {
    const monitor = useCardMonitor(graph)
    const legend = useMemo(() => graphLegend(graph), [graph])
    return (
      <div className="relative h-full w-full">
        <TopologyCanvas
          ref={ref}
          graph={graph}
          nodeStyle="diagram"
          diagramMode="detailed"
          diagramLine="elbow"
          direction={direction}
          focusNodeId={focusNodeId}
          monitor={monitor}
          minimap={false}
          {...handlers}
        />
        {graph.nodes.length > 1 && (
          // left-16 clears the zoom buttons in the corner.
          <div className="absolute bottom-4 left-16 z-10">
            <CanvasLegend
              viewStyle="diagram"
              grouped={false}
              colorMode="cable"
              {...legend}
              storageKey={LEGEND_KEY}
              defaultOpen={false}
            />
          </div>
        )}
      </div>
    )
  }
)
