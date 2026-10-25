import "@xyflow/react/dist/style.css"

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
} from "react"
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from "@xyflow/react"
import type { Edge, Node, NodeTypes } from "@xyflow/react"

import { useTheme } from "@/components/theme-provider"
import { BAND_NODE_CLASS } from "@/components/topology/diagram/band-node"
import type { BandData } from "@/components/topology/diagram/band-node"
import { LinkEdge } from "@/components/topology/diagram/link-edge"
import { FLOW_ARIA_LABELS } from "@/components/topology/flow-aria"
import { NODE_KINDS } from "@/components/topology/node-registry"
import { MIN_ZOOM } from "@/components/topology/opening-view"
import { ZoomControls } from "@/components/topology/zoom-controls"

import type { AppBand, AppCardNode, AppEdge, AppMapGraph } from "./model"

// The Application map's canvas (#163): React Flow with the topology
// Diagram's own pieces - its card (CardNode), its row band (BandNode, read
// only here) and its link (LinkEdge, with arrowheads) - in the page's
// theme, with the maps' zoom buttons and dotted ground. Only those two
// node kinds are registered, from the topology's registry: nothing new is
// added to it, so the topology map draws exactly what it drew before.
//
// The cards drag freely; where they were left is reported on drop, and
// the page keeps it (in the URL on the Maps page). Nothing on the canvas
// is deleted by a key.

const nodeTypes: NodeTypes = {
  card: NODE_KINDS.card.component,
  band: NODE_KINDS.band.component,
}
const edgeTypes = { link: LinkEdge }

const FIT = { padding: 0.12, maxZoom: 1.25 }

export interface AppMapCanvasHandle {
  fit: () => void
  /** Pan to a card, keeping the zoom. */
  focusNode: (id: string) => void
}

export interface AppMapCanvasProps {
  graph: AppMapGraph
  /** Changes when the map is a different map (view, filters): the camera
   * fits again. */
  fitKey: string
  /** Cards a search did not match: drawn faint. */
  matched?: Set<string> | null
  selectedNodeId?: string | null
  selectedEdgeId?: string | null
  onSelectNode?: (node: AppCardNode) => void
  onSelectEdge?: (edge: AppEdge) => void
  onSelectBand?: (band: AppBand) => void
  onPaneClick?: () => void
  /** Cards moved by hand: every card's centre after the drop. */
  onMoved?: (centres: Record<string, [number, number]>) => void
  onNodeContext?: (node: AppCardNode, x: number, y: number) => void
}

function bandNode(b: AppBand): Node {
  const data: BandData = {
    label: b.label,
    color: null,
    orient: "h",
    readOnly: true,
  }
  return {
    id: `band:${b.id}`,
    type: "band",
    position: { x: b.x, y: b.y },
    width: b.w,
    height: b.h,
    measured: { width: b.w, height: b.h },
    zIndex: 0,
    selectable: false,
    draggable: false,
    focusable: false,
    // Blended with the lines it lies under, and click-through but for its
    // title strip (band-node.tsx).
    className: BAND_NODE_CLASS,
    style: { pointerEvents: "none" },
    data,
  }
}

function toFlow(
  graph: AppMapGraph,
  matched: Set<string> | null | undefined,
  selectedNodeId: string | null | undefined,
  selectedEdgeId: string | null | undefined
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [
    ...graph.bands.map(bandNode),
    ...graph.nodes.map((n) => ({
      ...n,
      selected: n.id === selectedNodeId,
      data: { ...n.data, dimmed: !!matched && !matched.has(n.id) },
    })),
  ]
  const edges: Edge[] = graph.edges.map((e) => {
    const hot = e.id === selectedEdgeId
    const dim = !!matched && !(matched.has(e.source) || matched.has(e.target))
    return {
      ...e,
      selected: hot,
      ...(hot ? { className: "topo-hot", zIndex: 1 } : {}),
      data: { ...e.data!, hot },
      style: {
        ...e.style,
        ...(hot
          ? { strokeWidth: Number(e.style?.strokeWidth ?? 1.5) + 1 }
          : {}),
        ...(dim ? { opacity: 0.2 } : {}),
      },
    }
  })
  return { nodes, edges }
}

const Inner = forwardRef<AppMapCanvasHandle, AppMapCanvasProps>(function Inner(
  {
    graph,
    fitKey,
    matched,
    selectedNodeId,
    selectedEdgeId,
    onSelectNode,
    onSelectEdge,
    onSelectBand,
    onPaneClick,
    onMoved,
    onNodeContext,
  },
  ref
) {
  const { theme } = useTheme()
  const flow = useReactFlow()
  const built = useMemo(
    () => toFlow(graph, matched, selectedNodeId, selectedEdgeId),
    [graph, matched, selectedNodeId, selectedEdgeId]
  )
  const [nodes, setNodes, onNodesChange] = useNodesState(built.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(built.edges)
  useEffect(() => {
    setNodes(built.nodes)
    setEdges(built.edges)
  }, [built, setNodes, setEdges])

  const fit = useCallback(
    () => void flow.fitView({ ...FIT, duration: 200 }),
    [flow]
  )
  // A different map: frame it once its cards are in.
  useEffect(() => {
    const t = window.setTimeout(() => void flow.fitView(FIT), 30)
    return () => window.clearTimeout(t)
  }, [fitKey, flow])

  useImperativeHandle(
    ref,
    () => ({
      fit,
      focusNode: (id) => {
        const n = flow.getNode(id)
        if (n)
          void flow.setCenter(n.position.x, n.position.y, {
            zoom: Math.max(flow.getZoom(), 0.8),
            duration: 300,
          })
      },
    }),
    [fit, flow]
  )

  const byBand = useMemo(
    () => new Map(graph.bands.map((b) => [`band:${b.id}`, b])),
    [graph.bands]
  )

  return (
    // data-lod: the Diagram's line and label styles key on it.
    <div className="relative h-full w-full" data-lod="0">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={FIT}
        colorMode={theme}
        proOptions={{ hideAttribution: true }}
        nodesConnectable={false}
        deleteKeyCode={null}
        minZoom={MIN_ZOOM}
        ariaLabelConfig={FLOW_ARIA_LABELS}
        onNodeClick={(_, n) => {
          if (n.type === "card") onSelectNode?.(n as AppCardNode)
          else {
            const b = byBand.get(n.id)
            if (b) onSelectBand?.(b)
          }
        }}
        onEdgeClick={(_, e) => onSelectEdge?.(e as AppEdge)}
        onPaneClick={() => onPaneClick?.()}
        onNodeContextMenu={(ev, n) => {
          if (n.type !== "card" || !onNodeContext) return
          ev.preventDefault()
          onNodeContext(n as AppCardNode, ev.clientX, ev.clientY)
        }}
        onNodeDragStop={() => {
          if (!onMoved) return
          const out: Record<string, [number, number]> = {}
          for (const n of flow.getNodes())
            if (n.type === "card")
              out[n.id] = [Math.round(n.position.x), Math.round(n.position.y)]
          onMoved(out)
        }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
        <ZoomControls onFit={fit} />
      </ReactFlow>
    </div>
  )
})

/** The Application map's canvas. Lazy-load it: React Flow stays out of the
 * pages' own bundles. */
export const AppMapCanvas = forwardRef<AppMapCanvasHandle, AppMapCanvasProps>(
  function AppMapCanvas(props, ref) {
    return (
      <ReactFlowProvider>
        <Inner {...props} ref={ref} />
      </ReactFlowProvider>
    )
  }
)
