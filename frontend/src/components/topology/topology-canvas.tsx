import "@xyflow/react/dist/style.css"
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react"
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  getNodesBounds,
  getViewportForBounds,
  useEdgesState,
  useNodesState,
  useReactFlow,
  ReactFlowProvider,
} from "@xyflow/react"
import type { Edge, Node } from "@xyflow/react"
import { toPng } from "html-to-image"

import type { GhostEdgeData, TopoEdge, TopologyGraph } from "@/lib/api"
import { useTheme } from "@/components/theme-provider"
import { PortNode, StencilNode, handleId } from "./stencil-node"
import type { PortSide } from "./stencil-node"
import { edgeWaypoints, layoutNodes } from "./layout"
import { resolveLevels } from "./level-organiser"
import { RoutedEdge } from "./routed-edge"

// Defined once, outside the component (re-creating nodeTypes each render
// re-mounts every node — a classic React Flow footgun).
const nodeTypes = {
  device: StencilNode,
  interface: PortNode,
  front_port: PortNode,
  rear_port: PortNode,
}
const edgeTypes = { routed: RoutedEdge }

export type EdgeColorMode = "cable" | "type" | "status" | "none"

export interface CanvasHandle {
  /** Current node positions (for saving a view). */
  positions: () => Record<string, [number, number]>
  /** Zoom/center on one node. */
  focusNode: (id: string) => void
  /** Render the whole graph to a PNG data URL. */
  exportPng: () => Promise<string | null>
}

// Deterministic palette per cable type — informational hue, not state.
const TYPE_PALETTE = [
  "#0ea5e9",
  "#8b5cf6",
  "#f59e0b",
  "#10b981",
  "#ec4899",
  "#14b8a6",
  "#f97316",
  "#6366f1",
  "#84cc16",
  "#e11d48",
  "#06b6d4",
  "#a855f7",
]

export function typeColor(type: string): string {
  let h = 0
  for (let i = 0; i < type.length; i++) h = (h * 31 + type.charCodeAt(i)) | 0
  return TYPE_PALETTE[Math.abs(h) % TYPE_PALETTE.length]
}

function statusColor(slug?: string | null): string | undefined {
  if (!slug) return undefined
  if (/(active|connected|up)/.test(slug)) return "#10b981"
  if (/(plan|staged|reserved)/.test(slug)) return "#f59e0b"
  if (/(fail|broken|down|decom)/.test(slug)) return "#ef4444"
  return "#71717a"
}

function edgeStroke(
  data: TopoEdge["data"],
  mode: EdgeColorMode
): string | undefined {
  if (mode === "type" && data?.cable_type) return typeColor(data.cable_type)
  if (mode === "status") return statusColor(data?.status)
  if (mode === "cable" && data?.color) return data.color
  return undefined
}

type PosOf = (id: string) => { x: number; y: number } | undefined

/** Point each cable edge at the port-handle side facing its neighbour, and
 * record which side each port landed on. Idempotent — the base (unsuffixed)
 * port names live in edge.data so this can re-run with fresh positions after
 * a drag. */
// Two cards count as "adjacent" (same rank) when their main-axis centres are
// within this — closer than a rank gap. Only then do we connect them on the
// cross axis (side by side); otherwise the link runs along the main axis.
const ADJACENCY = 120

function assignSides(
  edges: Edge[],
  posOf: PosOf,
  direction: "LR" | "TB"
): {
  edges: Edge[]
  sides: Map<string, Record<string, PortSide>>
  orders: Map<string, Record<string, number>>
} {
  const tb = direction === "TB"
  const sides = new Map<string, Record<string, PortSide>>()
  // Per node+port: the neighbour's cross-axis position, used to order ports
  // on a side so their edges don't cross.
  const orders = new Map<string, Record<string, number>>()
  const set = (nodeId: string, port: string, side: PortSide) => {
    let m = sides.get(nodeId)
    if (!m) sides.set(nodeId, (m = {}))
    m[port] = side
  }
  // A port on a vertical side (L/R) orders by the neighbour's y; on a
  // horizontal side (T/B) by the neighbour's x.
  const order = (
    nodeId: string,
    port: string,
    side: PortSide,
    nbr: { x: number; y: number }
  ) => {
    let m = orders.get(nodeId)
    if (!m) orders.set(nodeId, (m = {}))
    m[port] = side === "L" || side === "R" ? nbr.y : nbr.x
  }
  const out = edges.map((e) => {
    const a = posOf(e.source)
    const b = posOf(e.target)
    const data = e.data as { baseS?: string; baseT?: string } | undefined
    const baseS =
      data?.baseS ?? (e.sourceHandle ? String(e.sourceHandle) : null)
    const baseT =
      data?.baseT ?? (e.targetHandle ? String(e.targetHandle) : null)
    if (!a || !b || !baseS || !baseT) return e
    const dx = b.x - a.x
    const dy = b.y - a.y
    // Main axis follows the layout direction (x in side-to-side, y in tree);
    // the cross axis is the other one. Side-by-side (cross-axis) links are
    // only for cards on the same rank — far-apart cards across ranks connect
    // along the main axis so the tree stays legible.
    const mainD = tb ? dy : dx
    const crossD = tb ? dx : dy
    const sameRank = Math.abs(mainD) < ADJACENCY
    let sSide: PortSide
    let tSide: PortSide
    if (!sameRank) {
      // Different ranks → connect on the main axis.
      if (tb) {
        sSide = mainD >= 0 ? "B" : "T"
        tSide = mainD >= 0 ? "T" : "B"
      } else {
        sSide = mainD >= 0 ? "R" : "L"
        tSide = mainD >= 0 ? "L" : "R"
      }
    } else {
      // Same rank, adjacent → connect on the cross axis (facing sides).
      if (tb) {
        sSide = crossD >= 0 ? "R" : "L"
        tSide = crossD >= 0 ? "L" : "R"
      } else {
        sSide = crossD >= 0 ? "B" : "T"
        tSide = crossD >= 0 ? "T" : "B"
      }
    }
    set(e.source, baseS, sSide)
    set(e.target, baseT, tSide)
    order(e.source, baseS, sSide, b) // source port faces its target
    order(e.target, baseT, tSide, a) // target port faces its source
    return {
      ...e,
      sourceHandle: handleId(baseS, sSide),
      targetHandle: handleId(baseT, tSide),
      data: { ...e.data, baseS, baseT },
    }
  })
  return { edges: out, sides, orders }
}

function build(
  graph: TopologyGraph,
  opts: {
    focusNodeId?: string
    direction?: "LR" | "TB"
    roleOrder?: string[]
    roleBonds?: string[]
    roleDistance?: Record<string, number>
    edgeRouting?: "routed" | "straight"
    colorMode: EdgeColorMode
    positions?: Record<string, [number, number]>
    matched?: Set<string> | null
    hiddenPorts?: Set<string>
    originId?: string
  }
) {
  const nodes: Node[] = graph.nodes.map((n) => ({
    id: n.id,
    type: n.type ?? "device",
    position: { x: 0, y: 0 },
    selected: opts.focusNodeId === n.id,
    data: {
      ...n.data,
      dimmed: opts.matched ? !opts.matched.has(n.id) : false,
    },
  }))
  const nodeIds = new Set(nodes.map((n) => n.id))

  const allEdges: Edge[] = []
  for (const e of graph.edges) {
    if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) continue

    // Trace graphs: device→port membership + patch-panel pass-through.
    if (e.type === "membership") {
      allEdges.push({
        id: e.id,
        source: e.source,
        target: e.target,
        type: "smoothstep",
        pathOptions: { borderRadius: 10 },
        selectable: false,
        style: { strokeWidth: 1, stroke: "var(--border)", opacity: 0.6 },
      } as Edge)
      continue
    }
    if (e.type === "through") {
      allEdges.push({
        id: e.id,
        source: e.source,
        target: e.target,
        type: "smoothstep",
        pathOptions: { borderRadius: 10 },
        label: "patch",
        style: {
          strokeWidth: 1.5,
          stroke: "var(--muted-foreground)",
          strokeDasharray: "4 3",
        },
        labelStyle: { fontSize: 9 },
        labelBgStyle: { fill: "var(--card)" },
      } as Edge)
      continue
    }

    // LLDP "ghost" link — SNMP-adjacent, no cable. Clicking offers to
    // materialise it.
    if (e.type === "ghost") {
      const ep = e.data?.pairs?.[0]
      allEdges.push({
        id: e.id,
        source: e.source,
        target: e.target,
        type: "smoothstep",
        pathOptions: { borderRadius: 10 },
        label: ep ? `${ep.a} ↔ ${ep.b} · LLDP` : "LLDP",
        data: { sem: "ghost", ghost: e.data },
        style: {
          strokeWidth: 1.5,
          stroke: "var(--muted-foreground)",
          strokeDasharray: "6 4",
          opacity: 0.8,
        },
        labelStyle: { fontSize: 9, fontStyle: "italic" },
        labelBgStyle: { fill: "var(--card)" },
      } as Edge)
      continue
    }

    const pairs = e.data?.pairs ?? []
    const first = pairs[0]
    // Hide edges whose origin-side port was toggled off (device mini map).
    if (
      opts.hiddenPorts?.size &&
      opts.originId &&
      ((e.source === opts.originId &&
        first?.a_port &&
        opts.hiddenPorts.has(first.a_port)) ||
        (e.target === opts.originId &&
          first?.b_port &&
          opts.hiddenPorts.has(first.b_port)))
    )
      continue

    const via = e.data?.via ?? []
    const count = pairs.length
    const labelBits: string[] = []
    if (count > 1) labelBits.push(`×${count}`)
    if (via.length) labelBits.push(`via ${via.join(", ")}`)
    if (e.data?.cable_label) labelBits.push(e.data.cable_label)

    const stroke = edgeStroke(e.data, opts.colorMode)
    const marked = e.data?.marked
    allEdges.push({
      id: e.id,
      source: e.source,
      target: e.target,
      ...(first?.a_port ? { sourceHandle: first.a_port } : {}),
      ...(first?.b_port ? { targetHandle: first.b_port } : {}),
      type: "smoothstep",
      pathOptions: { borderRadius: 10 },
      label: labelBits.length ? labelBits.join(" · ") : undefined,
      animated: marked,
      data: { sem: "cable", raw: e.data },
      // Traced cable (trace map): thick primary stroke so the run stands out.
      style: marked
        ? { strokeWidth: 3, stroke: "var(--primary)" }
        : {
            strokeWidth: count > 1 ? 2.25 : 1.5,
            ...(stroke ? { stroke } : {}),
            ...(via.length ? { strokeDasharray: "10 4" } : {}),
          },
      labelStyle: { fontSize: 9 },
      labelBgStyle: { fill: "var(--card)" },
    } as Edge)
  }

  // Role tiers from the Level organiser, if any: node id → level index.
  let levels: Map<string, number> | undefined
  let mainOffsets: number[] | undefined
  if (opts.roleOrder && opts.roleOrder.length) {
    // Bonded roles share one level, so a level can hold several roles — rank by
    // LEVEL index, not by position in the order.
    const groups = resolveLevels(opts.roleOrder, opts.roleBonds ?? [])
    const rank = new Map<string, number>()
    groups.forEach((group, i) => group.forEach((name) => rank.set(name, i)))
    const last = groups.length
    levels = new Map()
    for (const n of graph.nodes) {
      // Patch panels aren't a device tier — leave them at their structural
      // position so they sit between the cables they join.
      if (n.data.role?.is_patch_panel) continue
      levels.set(n.id, rank.get(n.data.role?.name ?? "") ?? last)
    }
    // Cumulative main-axis offset per LEVEL. A level's gap comes from the
    // distance step of its FIRST role (bonded roles share the level, so they
    // share its gap — their own dots are hidden in the organiser to match).
    const base = opts.direction === "TB" ? 200 : 360
    const mult = [0.6, 0.8, 1, 1.4, 2] // 5 distance steps
    const gapOf = (role: string) => base * mult[opts.roleDistance?.[role] ?? 2]
    mainOffsets = [0]
    for (let i = 1; i <= last; i++)
      mainOffsets[i] = mainOffsets[i - 1] + gapOf(groups[i]?.[0] ?? "")
  }

  // Pass 1: a nominal layout (no port sides yet) just to learn each card's
  // rank/position, so we can decide which side of a card faces each neighbour.
  const pass1 = layoutNodes(
    nodes,
    allEdges,
    opts.positions,
    opts.direction,
    levels,
    mainOffsets
  ).nodes
  const pos1 = new Map(pass1.map((n) => [n.id, n.position]))

  // Point each edge at the card side facing its neighbour (dominant axis:
  // side-by-side → left/right, stacked → top/bottom), and learn per-node
  // port sides. Re-runnable on drag via assignSides.
  const { edges, sides, orders } = assignSides(
    allEdges,
    (id) => pos1.get(id),
    opts.direction ?? "LR"
  )

  // Inject the sides + port order so each card sizes to its per-side port
  // split and its ports render in crossing-free order, then lay out again
  // with the real dimensions.
  const sized = nodes.map((n) =>
    sides.has(n.id)
      ? {
          ...n,
          data: {
            ...n.data,
            portSide: sides.get(n.id),
            portOrder: orders.get(n.id),
          },
        }
      : n
  )
  const { nodes: laid, waypoints } = layoutNodes(
    sized,
    edges,
    opts.positions,
    opts.direction,
    levels,
    mainOffsets
  )
  // Route cable edges along the node-avoiding interior bends (the ends snap to
  // the port handles). Skipped in "straight" mode.
  const routeEdges = opts.edgeRouting !== "straight"
  const routed = edges.map((e) => {
    const wp = routeEdges ? waypoints.get(`${e.source}>${e.target}`) : undefined
    if (
      (e.data as { sem?: string } | undefined)?.sem === "cable" &&
      wp &&
      wp.length > 0
    ) {
      return {
        ...e,
        type: "routed",
        data: { ...e.data, waypoints: wp },
      }
    }
    return e
  })
  return { nodes: laid, edges: routed }
}

export interface TopologyCanvasProps {
  graph: TopologyGraph
  focusNodeId?: string
  /** "LR" side-to-side (default) or "TB" tree (top-down). */
  direction?: "LR" | "TB"
  /** Role names in tier order (Level organiser); [] → structural layout. */
  roleOrder?: string[]
  /** Roles sharing the level of the role above them in `roleOrder` — so several
   * roles can occupy one level. */
  roleBonds?: string[]
  /** Role name → distance step (0–4) for the gap above its tier. */
  roleDistance?: Record<string, number>
  /** "routed" bends cables around cards (where the auto-layout supplies a
   * node-avoiding route); "straight" forces the plain smoothstep line. */
  edgeRouting?: "routed" | "straight"
  colorMode?: EdgeColorMode
  /** Saved-view node positions; nodes not listed get the auto layout. */
  positions?: Record<string, [number, number]>
  /** Bump to discard drags/saved positions and re-run the auto layout. */
  layoutTick?: number
  /** Node ids matching the search — everything else renders dimmed. */
  matchedIds?: Set<string> | null
  /** Device mini map: hide edges leaving these origin ports. */
  hiddenPorts?: Set<string>
  originId?: string
  onSelectNode?: (data: TopologyGraph["nodes"][number]["data"]) => void
  onSelectEdge?: (data: NonNullable<TopoEdge["data"]>) => void
  onGhostEdge?: (ghost: GhostEdgeData) => void
  onCanvasClick?: () => void
  /** Fired after a node drag settles — the parent can persist positions(). */
  onDragEnd?: () => void
}

const Inner = forwardRef<CanvasHandle, TopologyCanvasProps>(function Inner(
  {
    graph,
    focusNodeId,
    colorMode = "cable",
    direction = "LR",
    roleOrder,
    roleBonds,
    roleDistance,
    edgeRouting = "routed",
    positions,
    layoutTick = 0,
    matchedIds,
    hiddenPorts,
    originId,
    onSelectNode,
    onSelectEdge,
    onGhostEdge,
    onCanvasClick,
    onDragEnd,
  },
  ref
) {
  const { theme } = useTheme()
  const flow = useReactFlow()
  const wrapper = useRef<HTMLDivElement>(null)
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const built = useMemo(
    () =>
      build(graph, {
        focusNodeId,
        direction,
        roleOrder,
        roleBonds,
        roleDistance,
        edgeRouting,
        colorMode,
        positions: layoutTick > 0 ? undefined : positions,
        matched: matchedIds,
        hiddenPorts,
        originId,
      }),
    // layoutTick discards saved positions on purpose.
    [
      graph,
      focusNodeId,
      direction,
      roleOrder,
      roleDistance,
      edgeRouting,
      colorMode,
      positions,
      layoutTick,
      matchedIds,
      hiddenPorts,
      originId,
    ]
  )

  const [nodes, setNodes, onNodesChange] = useNodesState(built.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(built.edges)
  // Hover/select emphasis: the active edge thickens and rises; every other
  // edge fades — the only way crossings stay readable in a dense mesh.
  const [hotEdge, setHotEdge] = useState<string | null>(null)
  const shownEdges = useMemo(() => {
    if (!hotEdge) return edges
    return edges.map((e) => {
      if (e.id === hotEdge)
        return {
          ...e,
          zIndex: 1000,
          style: {
            ...e.style,
            strokeWidth: 3,
            opacity: 1,
          },
        }
      return {
        ...e,
        style: { ...e.style, opacity: 0.15 },
        labelStyle: { ...e.labelStyle, opacity: 0.2 },
      }
    })
  }, [edges, hotEdge])
  // Re-sync when the built graph changes, but keep user-dragged positions
  // for nodes that are still present (so a color-mode flip doesn't shuffle).
  const prevNodes = useRef<Node[]>([])
  const prevTick = useRef(layoutTick)
  useEffect(() => {
    const prev = new Map(prevNodes.current.map((n) => [n.id, n.position]))
    // Keep the user's dragged positions only across INCIDENTAL rebuilds
    // (colour mode, search highlight, a late graph refetch) — not when they
    // deliberately re-ran the layout. Every deliberate relayout (direction,
    // Levels order/distance, Re-layout, applyView) bumps `layoutTick`, so a
    // changed tick means "use the fresh layout"; an unchanged tick means "an
    // incidental rebuild — don't shuffle the user's arrangement". (A saved
    // view that pins `positions` bypasses keeping too.)
    const relaidOut = layoutTick !== prevTick.current
    prevTick.current = layoutTick
    const keepingDrags =
      !relaidOut && !positions && prevNodes.current.length > 0
    const nextNodes = built.nodes.map((n) => {
      const kept = prev.get(n.id)
      return kept && keepingDrags ? { ...n, position: kept } : n
    })
    setNodes(nextNodes)
    // When we kept dragged positions, `built.edges` were routed for the
    // layout's positions, not the kept ones — re-route from the actual
    // rendered positions so cables always match their cards.
    if (edgeRouting === "routed" && keepingDrags) {
      const wp = edgeWaypoints(nextNodes, built.edges, direction)
      setEdges(
        built.edges.map((e) => {
          if ((e.data as { sem?: string } | undefined)?.sem !== "cable")
            return e
          const pts = wp.get(`${e.source}>${e.target}`)
          return pts?.length
            ? { ...e, type: "routed", data: { ...e.data, waypoints: pts } }
            : {
                ...e,
                type: "smoothstep",
                data: { ...e.data, waypoints: undefined },
              }
        })
      )
    } else {
      setEdges(built.edges)
    }
  }, [built, setNodes, setEdges, layoutTick, positions, direction, edgeRouting])
  useEffect(() => {
    prevNodes.current = nodes
  }, [nodes])

  useImperativeHandle(
    ref,
    () => ({
      positions: () =>
        Object.fromEntries(
          flow
            .getNodes()
            .map((n) => [
              n.id,
              [n.position.x, n.position.y] as [number, number],
            ])
        ),
      focusNode: (id: string) => {
        const n = flow.getNode(id)
        if (n)
          flow.setCenter(n.position.x + 110, n.position.y + 40, {
            zoom: 1.1,
            duration: 500,
          })
      },
      exportPng: async () => {
        const el = wrapper.current?.querySelector<HTMLElement>(
          ".react-flow__viewport"
        )
        if (!el) return null
        const bounds = getNodesBounds(flow.getNodes())
        const w = Math.min(4096, Math.max(800, Math.ceil(bounds.width) + 160))
        const h = Math.min(4096, Math.max(600, Math.ceil(bounds.height) + 160))
        const vp = getViewportForBounds(bounds, w, h, 0.2, 2, 0.06)
        return toPng(el, {
          backgroundColor: theme === "dark" ? "#09090b" : "#ffffff",
          width: w,
          height: h,
          style: {
            width: `${w}px`,
            height: `${h}px`,
            transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})`,
          },
        })
      },
    }),
    [flow, theme]
  )

  const onNodeClick = useCallback(
    (_: unknown, node: Node) => {
      onSelectNode?.(node.data as TopologyGraph["nodes"][number]["data"])
    },
    [onSelectNode]
  )
  const onEdgeClick = useCallback(
    (_: unknown, edge: Edge) => {
      const data = edge.data as
        | { sem?: string; ghost?: GhostEdgeData; raw?: TopoEdge["data"] }
        | undefined
      if (data?.sem === "ghost" && data.ghost) onGhostEdge?.(data.ghost)
      else if (data?.raw) onSelectEdge?.(data.raw)
    },
    [onGhostEdge, onSelectEdge]
  )

  // Dragging a card changes which side of it faces each neighbour — re-snap
  // the edges, and RE-ROUTE the cables from the new positions (so moving a
  // node re-bends its cables around cards instead of leaving them straight).
  const onNodeDragStop = useCallback(() => {
    const liveNodes = flow.getNodes()
    const live = new Map(liveNodes.map((n) => [n.id, n.position]))
    setEdges((cur) => {
      const {
        edges: next,
        sides,
        orders,
      } = assignSides(cur, (id) => live.get(id), direction)
      setNodes((ns) =>
        ns.map((n) =>
          sides.has(n.id)
            ? {
                ...n,
                data: {
                  ...n.data,
                  portSide: sides.get(n.id),
                  portOrder: orders.get(n.id),
                },
              }
            : n
        )
      )
      // Straight mode: only re-snapped sides, nothing to route.
      if (edgeRouting !== "routed") return next
      const wp = edgeWaypoints(liveNodes, next, direction)
      return next.map((e) => {
        if ((e.data as { sem?: string } | undefined)?.sem !== "cable") return e
        const pts = wp.get(`${e.source}>${e.target}`)
        return pts?.length
          ? { ...e, type: "routed", data: { ...e.data, waypoints: pts } }
          : {
              ...e,
              type: "smoothstep",
              data: { ...e.data, waypoints: undefined },
            }
      })
    })
    onDragEnd?.()
  }, [flow, setEdges, setNodes, direction, edgeRouting, onDragEnd])

  if (!mounted)
    return <div className="h-full w-full animate-pulse bg-muted/30" />
  if (graph.nodes.length === 0)
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Nothing to map yet — cable some devices first.
      </div>
    )

  return (
    <div ref={wrapper} className="h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={shownEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        colorMode={theme}
        proOptions={{ hideAttribution: true }}
        nodesConnectable={false}
        onNodeClick={onNodeClick}
        onNodeDragStop={onNodeDragStop}
        onEdgeClick={onEdgeClick}
        onEdgeMouseEnter={(_, e) => setHotEdge(e.id)}
        onEdgeMouseLeave={() => setHotEdge(null)}
        onPaneClick={onCanvasClick}
        onlyRenderVisibleElements
        minZoom={0.05}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          className="rounded-md border !border-border !bg-card"
        />
      </ReactFlow>
    </div>
  )
})

/** Shared React Flow renderer for the topology map and the device mini map.
 * Lazy-loaded by callers so its code + CSS stay out of the main bundle. */
export const TopologyCanvas = forwardRef<CanvasHandle, TopologyCanvasProps>(
  function TopologyCanvas(props, ref) {
    return (
      <ReactFlowProvider>
        <Inner {...props} ref={ref} />
      </ReactFlowProvider>
    )
  }
)
