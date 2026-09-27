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
import type { DragEvent, ReactNode } from "react"
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ViewportPortal,
  getNodesBounds,
  getViewportForBounds,
  useEdgesState,
  useNodesState,
  useReactFlow,
  ReactFlowProvider,
} from "@xyflow/react"
import type { Edge, Node } from "@xyflow/react"
import { toPng } from "html-to-image"

import type {
  BulkStatusEntry,
  GhostEdgeData,
  TopoEdge,
  TopologyGraph,
  TopologyLinkOverride,
} from "@/lib/api"
import { useTheme } from "@/components/theme-provider"
import { EmptyState } from "@/components/empty-state"
import { readableText } from "@/lib/color"
import { cn, cssColor } from "@/lib/utils"
import { useStatusLabels } from "@/components/monitoring/status-palette"
import { diagramFontsReady } from "@/lib/diagram/measure"
import type { DiagramDocument } from "@/lib/diagram/types"
import { CanvasTip } from "./canvas-tip"
import type { CanvasTipHandle } from "./canvas-tip"
import { ABOVE, BELOW, RIGHT, handleId } from "./stencil-node"
import type { PortSide } from "./stencil-node"
import { FLAT_H, flatHeight, flatW, flatWidth } from "./flat-node"
import type { FlatAnchor, FlatData } from "./flat-node"
import { GROUP_H, GROUP_W } from "./group-node"
import { hierarchyWidth } from "./hierarchy-node"
import type { GroupEdgeInfo, TopoGroupData } from "./group-node"
import {
  edgeWaypoints,
  hierarchyWaypoints,
  layoutHierarchy,
  layoutNodes,
  realignHierPorts,
} from "./layout"
import type { NodeSizing } from "./layout"
import { resolveLevels } from "./level-organiser"
import { graphLevels } from "./levels-param"
import { OverlayEdge } from "./overlay-edge"
import { RoutedEdge } from "./routed-edge"
import { ZONE_DRAG_HANDLE } from "./zone-node"
import { ZONE_H, ZONE_W } from "./view-positions"
import type { Zone } from "./view-positions"
import { lagBundleLabel, sharedLag } from "./lag-bundles"
import {
  CANVAS_MINIMAP_AT,
  MiniMapCanvas,
  NoMiniMapNode,
} from "./minimap-canvas"
import { bundleStroke, edgeLook, edgeStroke, flowEdgeStyle } from "./edge-style"
import type { EdgeColorMode } from "./edge-style"
import { ROUTABLE, classifyEdges, orientHubToLeaf } from "./edge-semantics"
import type { BundleMember, EdgeClass } from "./edge-semantics"
import { nodeTypes, sizeOf } from "./node-registry"
import {
  buildDiagram,
  relinkDiagram,
  remeasureDiagram,
} from "./diagram/build-diagram"
import type { DiagramModel } from "./diagram/build-diagram"
import {
  DiagramWorker,
  canBuildOffThread,
  relinkedModel,
} from "./diagram/diagram-client"
import { LinkEdge } from "./diagram/link-edge"
import { DEVICE_IDS_MIME, NEW_CARD, parseDragIds } from "./diagram/placement"
import type { LabelToken } from "./diagram/link-labels"
import { toDocument } from "./diagram/to-document"
import type { DocumentOptions } from "./diagram/to-document"
import type {
  DiagramCardData,
  DiagramEdgeData,
  DiagramLinkRef,
  DiagramMode,
  LineType,
  Rect,
} from "./diagram/types"
import { fromFlow } from "./export/from-flow"

export { speedColor, typeColor } from "./edge-style"
export type { EdgeColorMode } from "./edge-style"
export type { BundleMember } from "./edge-semantics"

/** The Diagram link behind a clicked edge, when it is wiring. */
function linkRef(e: Edge): DiagramLinkRef | undefined {
  if (e.type !== "link") return undefined
  const d = e.data as DiagramEdgeData | undefined
  if (!d?.pairKey || d.fan?.role === "trunk") return undefined
  if (d.sem !== "cable" && d.sem !== "bundle" && d.sem !== "lagbundle")
    return undefined
  return { pairKey: d.pairKey, ...(d.arc ? { arc: d.arc.flip } : {}) }
}

const edgeTypes = { routed: RoutedEdge, overlay: OverlayEdge, link: LinkEdge }

/**
 * Zones paint under the cards - they are prepended to the node array, and
 * React Flow keeps array order for equal zIndex.
 *
 * NOT a negative zIndex, which is where this started: a node below zero
 * renders behind `.react-flow__pane`, and the pane then swallows every
 * click, drag and right-click aimed at the zone.
 */
const ZONE_Z = 0

interface ZoneCallbacks {
  onRename: (id: string, label: string) => void
  onRecolor: (id: string, color: string) => void
  onDelete: (id: string) => void
  onResizeEnd: () => void
}

function zoneToNode(z: Zone, cb: ZoneCallbacks): Node {
  return {
    id: `zone:${z.id}`,
    type: "zone",
    position: { x: z.x, y: z.y },
    width: z.w,
    height: z.h,
    zIndex: ZONE_Z,
    selectable: true,
    draggable: true,
    // Only the label bar drags. With the whole box as the handle, every
    // grab at a resize corner moved the zone instead of resizing it.
    dragHandle: `.${ZONE_DRAG_HANDLE}`,
    data: {
      label: z.label,
      color: z.color,
      onRename: (label: string) => cb.onRename(z.id, label),
      onRecolor: (color: string) => cb.onRecolor(z.id, color),
      onDelete: () => cb.onDelete(z.id),
      onResizeEnd: cb.onResizeEnd,
    },
  }
}

/** Zone nodes as the canvas currently holds them, back in save shape. */
function nodesToZones(nodes: Node[], previous: Zone[]): Zone[] {
  const was = new Map(previous.map((z) => [z.id, z]))
  const out: Zone[] = []
  for (const n of nodes) {
    if (n.type !== "zone") continue
    const id = n.id.slice(5)
    const prev = was.get(id)
    if (!prev) continue
    out.push({
      ...prev,
      x: Math.round(n.position.x),
      y: Math.round(n.position.y),
      w: Math.round(n.width ?? n.measured?.width ?? ZONE_W),
      h: Math.round(n.height ?? n.measured?.height ?? ZONE_H),
    })
  }
  return out
}

/** "stencil" = wiring cards with port rows; "hierarchy" = tall cards with
 * peer-aligned port chips (near-straight cables); "flat" = barebones fixed
 * chips with parallel cables bundled into one ×N edge; "diagram" = the
 * role-coloured cards of the Diagram tab (diagram/build-diagram.ts). */
export type NodeStyle = "stencil" | "hierarchy" | "flat" | "diagram"

const flatSize = (n: Node) => ({
  width: flatW(n.data as { name?: string }),
  height: FLAT_H,
})
const groupSize = () => ({ width: GROUP_W, height: GROUP_H })
/** Wiring cards (and trace-map ports) at their registered size, with the
 * roomy spacing port-anchored cables need. */
const CARD_SIZING: NodeSizing = { sizeOf, compact: false }

export interface CanvasHandle {
  /** Current node positions (for saving a view). */
  positions: () => Record<string, [number, number]>
  /** The middle of what is on screen, in canvas coordinates. */
  center: () => { x: number; y: number }
  /** Zoom/center on one node. */
  focusNode: (id: string) => void
  /** Spotlight one node as a click on it would - the caller reports the
   * selection to its own panels. */
  selectNode: (id: string) => void
  /** Center between the two ends of one edge. */
  focusEdge: (id: string) => void
  /** Fit the viewport to one zone's box. */
  focusZone: (box: { x: number; y: number; w: number; h: number }) => void
  /** Render the graph to a PNG data URL - the whole diagram, or just the
   * visible viewport. */
  exportPng: (viewportOnly?: boolean) => Promise<string | null>
  /** The map as an export document (lib/diagram): the Diagram from its
   * model, the other tabs in the Diagram's Simple look. Built from the
   * canvas's data - every card, on screen or not - never the DOM. */
  document: (opts: CanvasDocumentOptions) => DiagramDocument
  /** Every card's box (top-left corner and size) by node id: where a new
   * card must not land. Zones and breakout junctions are not cards. */
  boxes: () => Record<string, Rect>
  /** The devices behind the selected cards. */
  selectedDevices: () => string[]
}

/** A device just added to the map and not fetched yet: drawn muted, a
 * card's size, centred where it will land. */
export interface PendingCard {
  /** The node id it will have (`dev:<uuid>`). */
  id: string
  name: string
  /** Its role colour, when it has one. */
  color?: string | null
  /** Its centre, in canvas coordinates. */
  at: [number, number]
}

function PendingCardView({ card }: { card: PendingCard }) {
  const fill = cssColor(card.color)
  return (
    <div
      aria-busy
      data-pending={card.id}
      className={cn(
        "pointer-events-none absolute flex items-center justify-center rounded-lg border border-dashed px-2.5 opacity-50",
        !fill && "border-border bg-muted text-foreground"
      )}
      style={{
        width: NEW_CARD.w,
        height: NEW_CARD.h,
        transform: `translate(${card.at[0] - NEW_CARD.w / 2}px, ${
          card.at[1] - NEW_CARD.h / 2
        }px)`,
        ...(fill
          ? {
              backgroundColor: fill,
              borderColor: readableText(fill),
              color: readableText(fill),
            }
          : {}),
      }}
    >
      <span className="truncate text-xs font-bold">{card.name}</span>
    </div>
  )
}

export interface CanvasDocumentOptions extends Omit<
  DocumentOptions,
  "area" | "monitor" | "checkLabels" | "measure"
> {
  /** "visible": only the cards on screen and the lines between them. */
  area?: "all" | "visible"
}

/** The full name a cable edge announces on hover - label/number, media,
 * speed, and its endpoint pair(s). Bundles and group edges summarize. */
function hoverLabel(e: Edge): string | undefined {
  const d = e.data as
    | {
        sem?: string
        raw?: TopoEdge["data"]
        cables?: BundleMember[]
        group?: GroupEdgeInfo
        fan?: { ports?: string[] }
      }
    | undefined
  if (!d) return undefined
  if (d.sem === "cable" && d.raw) {
    const r = d.raw
    const bits = [
      r.cable_label || (r.cable_numid ? `Cable #${r.cable_numid}` : "Cable"),
    ]
    if (r.cable_type) bits.push(r.cable_type)
    if (r.speed) bits.push(r.speed)
    const pair = r.pairs?.[0]
    // A breakout leg folding several ports (Simple) names them all.
    if (d.fan?.ports?.length) bits.push(d.fan.ports.join(", "))
    else if (pair)
      bits.push(
        `${pair.a} ↔ ${pair.b}${
          (r.pairs?.length ?? 0) > 1 ? `  ×${r.pairs!.length}` : ""
        }`
      )
    if (r.via?.length) bits.push(`via ${r.via.join(", ")}`)
    return bits.join(" · ")
  }
  if (d.sem === "lagbundle" && d.cables) {
    const lag = sharedLag(d.cables)
    const names = d.cables
      .map((c) => c.cable_label || (c.cable_numid ? `#${c.cable_numid}` : ""))
      .filter(Boolean)
    const speeds = [...new Set(d.cables.map((c) => c.speed).filter(Boolean))]
    return [
      lag ? `${lag.a?.name} ⇄ ${lag.b?.name}` : "Bundle",
      `${d.cables.length} cable${d.cables.length === 1 ? "" : "s"}`,
      ...(names.length ? [names.join(", ")] : []),
      ...(speeds.length === 1 ? [speeds[0] as string] : []),
    ].join(" · ")
  }
  if (d.sem === "bundle" && d.cables) {
    const types = [
      ...new Set(d.cables.map((c) => c.cable_type).filter(Boolean)),
    ]
    const names = d.cables
      .map((c) => c.cable_label || (c.cable_numid ? `#${c.cable_numid}` : ""))
      .filter(Boolean)
    const shown = names.slice(0, 3).join(", ")
    const more = names.length > 3 ? ` +${names.length - 3}` : ""
    return `${d.cables.length} cable${d.cables.length === 1 ? "" : "s"}${
      types.length ? ` · ${types.join(", ")}` : ""
    }${shown ? ` · ${shown}${more}` : ""}`
  }
  if (d.sem === "groupedge" && d.group)
    return `${d.group.cable_count} cable${
      d.group.cable_count === 1 ? "" : "s"
    }${d.group.types.length ? ` · ${d.group.types.join(", ")}` : ""}`
  return undefined
}

type PosOf = (id: string) => { x: number; y: number } | undefined

/** Point each cable edge at the port-handle side facing its neighbour, and
 * record which side each port landed on. Idempotent - the base (unsuffixed)
 * port names live in edge.data so this can re-run with fresh positions after
 * a drag. */
// Two cards count as "adjacent" (same rank) when their main-axis centres are
// within this - closer than a rank gap. Only then do we connect them on the
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
    // only for cards on the same rank - far-apart cards across ranks connect
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

type CablePair = NonNullable<BundleMember["pairs"]>[number]

/** Port handles for an edge whose ends are real ports. */
const portHandles = (first: CablePair | undefined) => ({
  ...(first?.a_port ? { sourceHandle: first.a_port } : {}),
  ...(first?.b_port ? { targetHandle: first.b_port } : {}),
})

const smoothstep = () => ({
  type: "smoothstep",
  pathOptions: { borderRadius: 10 },
})

/** One classified payload edge as a React Flow edge, styled for the colour
 * mode. */
function flowEdge(c: EdgeClass, colorMode: EdgeColorMode): Edge {
  const ends = { id: c.id, source: c.source, target: c.target }
  switch (c.sem) {
    // Aggregated group-to-group edge (group_by mode): ×N cables, width
    // scaled gently by the bundle size.
    case "groupedge": {
      const n = c.group?.cable_count ?? 1
      return {
        ...ends,
        sourceHandle: "n",
        targetHandle: "n",
        ...smoothstep(),
        label: `×${n}`,
        data: { sem: "groupedge", group: c.group, baseS: "n", baseT: "n" },
        ...flowEdgeStyle(edgeLook("groupedge", { count: n })),
      }
    }
    // Trace graphs: device→port membership + patch-panel pass-through.
    case "membership":
      return {
        ...ends,
        ...smoothstep(),
        selectable: false,
        ...flowEdgeStyle(edgeLook("membership")),
      }
    case "through":
      return {
        ...ends,
        ...smoothstep(),
        label: "patch",
        ...flowEdgeStyle(edgeLook("through")),
      }
    // A BGP session between the two cards - a faint straight line from
    // centre to centre under the wiring, one per device pair and table,
    // named on hover; the sidebar lists them and a click opens the session.
    case "bgp":
      return {
        ...ends,
        type: "overlay",
        data: { sem: "bgp", bgp: c.raw },
        ...flowEdgeStyle(edgeLook("bgp")),
      }
    // LLDP "ghost" link - SNMP-adjacent, no cable. Clicking offers to
    // materialise it.
    case "ghost": {
      const ep = c.raw?.pairs?.[0]
      return {
        ...ends,
        ...smoothstep(),
        label: ep ? `${ep.a} ↔ ${ep.b} · LLDP` : "LLDP",
        data: { sem: "ghost", ghost: c.raw },
        ...flowEdgeStyle(edgeLook("ghost")),
      }
    }
    case "cable": {
      const r = c.raw
      const stroke = edgeStroke(r, colorMode)
      // Flat view: a pair joined by ONE cable is that cable, not a bundle of
      // one - it carries the cable's real label, colours by its own data,
      // gets the full hover identity, and clicking it opens the cable panel
      // rather than a one-row bundle list.
      if (c.byPair) {
        const bits: string[] = []
        if (r?.via?.length) bits.push(`via ${r.via.join(", ")}`)
        if (r?.cable_label) bits.push(r.cable_label)
        if (colorMode === "speed" && r?.speed) bits.push(r.speed)
        return {
          ...ends,
          sourceHandle: "n",
          targetHandle: "n",
          ...smoothstep(),
          label: bits.length ? bits.join(" · ") : undefined,
          animated: r?.marked,
          data: { sem: "cable", raw: r },
          ...flowEdgeStyle(
            edgeLook("cable", {
              stroke,
              via: !!r?.via?.length,
              marked: r?.marked,
            })
          ),
        }
      }
      const pairs = r?.pairs ?? []
      const first: CablePair | undefined = pairs[0]
      const via = r?.via ?? []
      const count = pairs.length
      const labelBits: string[] = []
      if (count > 1) labelBits.push(`×${count}`)
      if (via.length) labelBits.push(`via ${via.join(", ")}`)
      if (r?.cable_label) labelBits.push(r.cable_label)
      if (colorMode === "speed" && r?.speed) labelBits.push(r.speed)
      return {
        ...ends,
        ...portHandles(first),
        ...smoothstep(),
        label: labelBits.length ? labelBits.join(" · ") : undefined,
        animated: r?.marked,
        data: { sem: "cable", raw: r },
        ...flowEdgeStyle(
          edgeLook("cable", {
            stroke,
            count,
            via: via.length > 0,
            marked: r?.marked,
          })
        ),
      }
    }
    case "lagbundle": {
      const marked = c.cables.some((x) => x.marked)
      return {
        ...ends,
        ...portHandles(c.cables[0].pairs?.[0]),
        ...smoothstep(),
        label: lagBundleLabel(c.lag, c.cables.length),
        animated: marked,
        data: { sem: "lagbundle", cables: c.cables, lag: c.lag },
        ...flowEdgeStyle(
          edgeLook("lagbundle", {
            stroke: bundleStroke(c.cables, colorMode),
            marked,
          })
        ),
      }
    }
    case "bundle": {
      const n = c.cables.length
      // In speed mode a bundle that agrees announces the shared speed.
      const speeds = new Set(c.cables.map((x) => x.speed ?? ""))
      const speed =
        colorMode === "speed" && speeds.size === 1
          ? [...speeds][0] || undefined
          : undefined
      const lag = sharedLag(c.cables)
      const base = lag ? lagBundleLabel(lag, n) : `×${n}`
      return {
        ...ends,
        sourceHandle: "n",
        targetHandle: "n",
        ...smoothstep(),
        label: speed ? `${base} · ${speed}` : base,
        data: { sem: "bundle", cables: c.cables },
        ...flowEdgeStyle(
          edgeLook("bundle", { stroke: bundleStroke(c.cables, colorMode) })
        ),
      }
    }
  }
}

/** Graph payload → React Flow nodes and edges, laid out. Exported for the
 * golden parity test (`build-parity.test.ts`). */
export function build(
  graph: TopologyGraph,
  opts: {
    focusNodeId?: string
    direction?: "LR" | "TB"
    roleOrder?: string[]
    roleBonds?: string[]
    roleDistance?: Record<string, number>
    edgeRouting?: "routed" | "straight" | "curved"
    colorMode: EdgeColorMode
    nodeStyle?: NodeStyle
    /** Fold a link aggregation's member cables into one edge (stencil and
     * hierarchy views; the flat view bundles every parallel cable anyway). */
    bundleLags?: boolean
    positions?: Record<string, [number, number]>
    matched?: Set<string> | null
    hiddenPorts?: Set<string>
    originId?: string
  }
) {
  const flat = opts.nodeStyle === "flat"
  const hier = opts.nodeStyle === "hierarchy"
  // A grouped payload (group_by=site|location) renders like the flat view:
  // fixed-size cards, whole-node edges, one compact layout pass.
  const grouped = graph.nodes.some((n) => n.type === "group")
  const nodes: Node[] = graph.nodes.map((n) => ({
    id: n.id,
    type:
      n.type === "group"
        ? "sitegroup"
        : (n.type ?? "device") !== "device"
          ? (n.type ?? "device")
          : flat
            ? "flat"
            : hier
              ? "hier"
              : "device",
    position: { x: 0, y: 0 },
    selected: opts.focusNodeId === n.id,
    data: {
      ...n.data,
      dimmed: opts.matched ? !opts.matched.has(n.id) : false,
    },
  }))
  const allEdges = orientHubToLeaf(
    classifyEdges(graph, {
      // Link aggregation: member cables of one bundle draw as ONE edge - the
      // logical link people think in - unless the view asks for every
      // cable. Flat collapses every parallel cable between a device pair.
      fold: flat ? "pair" : opts.bundleLags !== false ? "lag" : "none",
      originId: opts.originId,
      hiddenPorts: opts.hiddenPorts,
    }).map((c) => flowEdge(c, opts.colorMode))
  ).edges

  // Hierarchy view: port-aligned layout, near-straight cables, no channel
  // routing (alignment removes the need). Levels don't apply here - the
  // rank structure IS the hierarchy.
  if (hier) {
    const widthOf = (n: Node) => hierarchyWidth(n.data as { name?: string })
    const res = layoutHierarchy(nodes, allEdges, widthOf, opts.positions)
    const laid = res.nodes.map((n) => ({
      ...n,
      data: {
        ...n.data,
        portPos: res.portPos.get(n.id),
        portSpan: res.span.get(n.id) ?? 0,
      },
    }))
    const hedges = allEdges.map((e) => {
      const sem = (e.data as { sem?: string } | undefined)?.sem
      if (sem !== "cable" && sem !== "lagbundle") return e
      const baseS = e.sourceHandle ? String(e.sourceHandle) : null
      const baseT = e.targetHandle ? String(e.targetHandle) : null
      if (!baseS || !baseT) return e
      const sS = res.sides.get(e.source)?.[baseS] ?? "R"
      const tS = res.sides.get(e.target)?.[baseT] ?? "L"
      return {
        ...e,
        sourceHandle: handleId(baseS, sS),
        targetHandle: handleId(baseT, tS),
        pathOptions: { borderRadius: 4 },
        data: { ...e.data, baseS, baseT },
      }
    })
    // Port-anchored routing: a cable bends only to get past a card that
    // stands in its way, and always leaves and arrives at its own port
    // level - never at the card's centre.
    // Curved skips port-anchored routing here too - one control, one
    // meaning in every view.
    if (opts.edgeRouting === "curved")
      return {
        nodes: laid,
        edges: hedges.map((e) => {
          const sem = (e.data as { sem?: string } | undefined)?.sem
          if (sem !== "cable" && sem !== "lagbundle") return e
          return { ...e, type: "default", pathOptions: undefined }
        }),
      }
    const hwp = hierarchyWaypoints(laid, hedges, res.portPos)
    const hrouted = hedges.map((e) => {
      const sem = (e.data as { sem?: string } | undefined)?.sem
      if (sem !== "cable" && sem !== "lagbundle") return e
      const pts = hwp.get(e.id)
      return pts?.length
        ? { ...e, type: "routed", data: { ...e.data, waypoints: pts } }
        : e
    })
    return { nodes: laid, edges: hrouted }
  }

  // Role tiers from the Level organiser, if any: node id → level index.
  let levels: Map<string, number> | undefined
  let mainOffsets: number[] | undefined
  if (opts.roleOrder && opts.roleOrder.length) {
    // Bonded roles share one level, so a level can hold several roles - rank by
    // LEVEL index, not by position in the order.
    ;({ levels, mainOffsets } = graphLevels(
      graph.nodes,
      resolveLevels(opts.roleOrder, opts.roleBonds ?? []),
      opts.direction,
      opts.roleDistance
    ))
  }

  // Flat + grouped views: compact dagre passes with fixed card sizes and no
  // per-port split. Flat chips EXTEND with their fan and spread distributed
  // anchors along the side facing each neighbour (ordered so links don't
  // cross); grouped cards keep single-point edges. Both still route around
  // cards in the way.
  if (flat || grouped) {
    const dir = opts.direction ?? "LR"
    const pre = layoutNodes(
      nodes,
      allEdges,
      { sizeOf: grouped ? groupSize : flatSize, compact: true },
      opts.positions,
      dir,
      levels,
      mainOffsets
    )
    const posPre = new Map(pre.nodes.map((n) => [n.id, n.position]))
    const { edges: sided } = assignSides(allEdges, (id) => posPre.get(id), dir)
    let outNodes = pre.nodes
    let outEdges = sided
    let wpMap = pre.waypoints
    if (flat) {
      const sideOf = (h?: string | null): PortSide =>
        h?.endsWith(RIGHT)
          ? "R"
          : h?.endsWith(ABOVE)
            ? "T"
            : h?.endsWith(BELOW)
              ? "B"
              : "L"
      type Slot = { e: Edge; end: "s" | "t"; side: PortSide; order: number }
      const perNode = new Map<string, Slot[]>()
      const crossOf = (id: string, side: PortSide) => {
        const p = posPre.get(id)
        if (!p) return 0
        return side === "L" || side === "R" ? p.y : p.x
      }
      for (const e of sided) {
        const sem = (e.data as { sem?: string } | undefined)?.sem
        if (!sem || !ROUTABLE.has(sem)) continue
        const sS = sideOf(e.sourceHandle as string | undefined)
        const tS = sideOf(e.targetHandle as string | undefined)
        ;(
          perNode.get(e.source) ?? perNode.set(e.source, []).get(e.source)!
        ).push({ e, end: "s", side: sS, order: crossOf(e.target, sS) })
        ;(
          perNode.get(e.target) ?? perNode.set(e.target, []).get(e.target)!
        ).push({ e, end: "t", side: tS, order: crossOf(e.source, tS) })
      }
      const anchorsOf = new Map<string, FlatAnchor[]>()
      const fanH = new Map<string, number>()
      const fanW = new Map<string, number>()
      const patched = new Map<Edge, { s?: string; t?: string }>()
      for (const [nid, slots] of perNode) {
        const bySide = new Map<PortSide, Slot[]>()
        for (const s of slots)
          (bySide.get(s.side) ?? bySide.set(s.side, []).get(s.side)!).push(s)
        const anchors: FlatAnchor[] = []
        for (const [side, list] of bySide) {
          list.sort((a, b) => a.order - b.order)
          // The card grows along the axis the fan occupies: left/right
          // fans stretch it down, top/bottom fans stretch it wide.
          if (side === "L" || side === "R")
            fanH.set(nid, Math.max(fanH.get(nid) ?? 0, list.length))
          else fanW.set(nid, Math.max(fanW.get(nid) ?? 0, list.length))
          list.forEach((s, i) => {
            const id = `a${side}${i}`
            anchors.push({ id, side, frac: (i + 1) / (list.length + 1) })
            const rec = patched.get(s.e) ?? patched.set(s.e, {}).get(s.e)!
            if (s.end === "s") rec.s = id
            else rec.t = id
          })
        }
        anchorsOf.set(nid, anchors)
      }
      outEdges = sided.map((e) => {
        const rec = patched.get(e)
        if (!rec) return e
        return {
          ...e,
          sourceHandle: rec.s ?? e.sourceHandle,
          targetHandle: rec.t ?? e.targetHandle,
        }
      })
      const nodes2 = pre.nodes.map((n) => ({
        ...n,
        data: {
          ...n.data,
          flatAnchors: anchorsOf.get(n.id) ?? [],
          flatFanH: fanH.get(n.id) ?? 0,
          flatFanW: fanW.get(n.id) ?? 0,
        },
      }))
      const grown = layoutNodes(
        nodes2,
        outEdges,
        {
          sizeOf: (n) => ({
            width: flatWidth(n.data as FlatData),
            height: flatHeight(n.data as FlatData),
          }),
          compact: true,
        },
        opts.positions,
        dir,
        levels,
        mainOffsets
      )
      outNodes = grown.nodes
      wpMap = grown.waypoints
    }
    if (flat) {
      // Floating point-to-point: plain beziers between the distributed
      // anchors, never routed or locked into channels.
      return {
        nodes: outNodes,
        edges: outEdges.map((e) => {
          const sem = (e.data as { sem?: string } | undefined)?.sem
          if (!sem || !ROUTABLE.has(sem)) return e
          return { ...e, type: "default", pathOptions: undefined }
        }),
      }
    }
    // Curved: the Flat view's floating beziers on the wiring cards - no
    // channels, no orthogonal bends, just point-to-point curves.
    if (opts.edgeRouting === "curved")
      return {
        nodes: outNodes,
        edges: outEdges.map((e) => {
          const sem = (e.data as { sem?: string } | undefined)?.sem
          if (!sem || !ROUTABLE.has(sem)) return e
          return { ...e, type: "default", pathOptions: undefined }
        }),
      }
    const routeThem = opts.edgeRouting !== "straight"
    const routedOut = outEdges.map((e) => {
      const sem = (e.data as { sem?: string } | undefined)?.sem
      if (!routeThem || !sem || !ROUTABLE.has(sem)) return e
      const wp = wpMap.get(e.id)
      return wp?.length
        ? { ...e, type: "routed", data: { ...e.data, waypoints: wp } }
        : e
    })
    return { nodes: outNodes, edges: routedOut }
  }

  // Pass 1: a nominal layout (no port sides yet) just to learn each card's
  // rank/position, so we can decide which side of a card faces each neighbour.
  const pass1 = layoutNodes(
    nodes,
    allEdges,
    CARD_SIZING,
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
    CARD_SIZING,
    opts.positions,
    opts.direction,
    levels,
    mainOffsets
  )
  // Curved: floating point-to-point beziers on the wiring cards - no
  // channels, no orthogonal bends. The curved branch above only covers the
  // flat/grouped payloads, so without this the Cables control silently did
  // nothing in the Wiring view (it fell through to routed).
  if (opts.edgeRouting === "curved")
    return {
      nodes: laid,
      edges: edges.map((e) => {
        const sem = (e.data as { sem?: string } | undefined)?.sem
        if (!sem || !ROUTABLE.has(sem)) return e
        return { ...e, type: "default", pathOptions: undefined }
      }),
    }
  // Route cable edges along the node-avoiding interior bends (the ends snap to
  // the port handles). Skipped in "straight" mode.
  const routeEdges = opts.edgeRouting !== "straight"
  const routed = edges.map((e) => {
    const sem = (e.data as { sem?: string } | undefined)?.sem
    const wp = routeEdges ? waypoints.get(e.id) : undefined
    if ((sem === "cable" || sem === "lagbundle") && wp && wp.length > 0) {
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
  /** Roles sharing the level of the role above them in `roleOrder` - so several
   * roles can occupy one level. */
  roleBonds?: string[]
  /** Role name → distance step (0–4) for the gap above its tier. */
  roleDistance?: Record<string, number>
  /** "routed" bends cables around cards (where the auto-layout supplies a
   * node-avoiding route); "straight" forces the plain smoothstep line. */
  edgeRouting?: "routed" | "straight" | "curved"
  /** "stencil" (default) wiring cards; "flat" barebones chips with bundled
   * edges - the view for big graphs. */
  nodeStyle?: NodeStyle
  colorMode?: EdgeColorMode
  /** Fold a link aggregation's member cables into one edge. Default on. */
  bundleLags?: boolean
  /** Saved-view node positions; nodes not listed get the auto layout. */
  positions?: Record<string, [number, number]>
  /** Labelled backdrop boxes drawn behind the map. */
  zones?: Zone[]
  /** A zone was moved, resized or renamed - the parent persists the list. */
  onZonesChange?: (zones: Zone[]) => void
  /** Bump to discard drags/saved positions and re-run the auto layout. */
  layoutTick?: number
  /** Identity of the underlying query (filters/focus/grouping). When it
   * changes the camera re-fits - a reshaped graph with yesterday's viewport
   * reads as a frozen or blank map. Incidental rebuilds (color mode, search,
   * refetch of the same query) keep the viewport. */
  fitKey?: string
  /** Node ids matching the search - everything else renders dimmed. */
  matchedIds?: Set<string> | null
  /** The edge whose panel is open - drawn emphasized in primary. */
  selectedEdgeId?: string | null
  /** Device mini map: hide edges leaving these origin ports. */
  hiddenPorts?: Set<string>
  originId?: string
  onSelectNode?: (data: TopologyGraph["nodes"][number]["data"]) => void
  /** A cable was clicked. `link`: the Diagram link it draws. */
  onSelectEdge?: (
    data: NonNullable<TopoEdge["data"]>,
    edgeId: string,
    link?: DiagramLinkRef
  ) => void
  /** Flat view: a bundled edge was clicked - its member cables. */
  onSelectBundle?: (
    cables: BundleMember[],
    edgeId: string,
    link?: DiagramLinkRef
  ) => void
  /** Grouped mode: a group card was clicked. */
  onSelectGroup?: (data: TopoGroupData) => void
  /** Grouped mode: an aggregated group-to-group edge was clicked. */
  onSelectGroupEdge?: (data: GroupEdgeInfo, edgeId: string) => void
  /** Grouped mode: a group card was double-clicked - drill into it. */
  onDrillGroup?: (data: TopoGroupData) => void
  /** Double-clicking a device card opens its page (double-click on a group
   * still drills). Disables React Flow's double-click zoom when set. */
  onOpenDevice?: (deviceId: string) => void
  /** Right-click on a node - screen coords + the raw RF node for branching
   * on type (device/flat vs sitegroup). */
  onNodeContext?: (node: Node, x: number, y: number) => void
  /** Right-click on empty canvas. */
  /** Right-click on empty canvas. `fx`/`fy` are the same point in canvas
   * coordinates, so a zone can be created where the click landed. */
  onPaneContext?: (x: number, y: number, fx: number, fy: number) => void
  onGhostEdge?: (ghost: GhostEdgeData) => void
  /** A BGP overlay line was clicked - its sessions, both directions. */
  onBgpEdge?: (bgp: NonNullable<TopoEdge["data"]>) => void
  onCanvasClick?: () => void
  /** Fired after a node drag settles - the parent can persist positions(). */
  onDragEnd?: () => void
  /** Diagram: Simple (lines meet at side midpoints) or Detailed (a nub per
   * cabled interface). */
  diagramMode?: DiagramMode
  /** Diagram: the view's line type. */
  diagramLine?: LineType
  /** Diagram: per device-pair line overrides from the saved view. */
  linkOverrides?: Record<string, TopologyLinkOverride>
  /** Diagram: which labels the links carry (subnets, addresses, port
   * names); all three when absent. Keep the array stable. */
  diagramLabels?: readonly LabelToken[]
  /** Diagram: monitoring state per device id, for the cards' pills. Kept
   * out of the build so a refresh never re-lays the map out. */
  monitor?: Record<string, BulkStatusEntry | undefined>
  /** A map built by hand: the canvas takes devices dragged in from a
   * device list (`DEVICE_IDS_MIME`), and an empty one still draws so
   * there is somewhere to drop them. `at` is the pointer in canvas
   * coordinates. */
  onDropDevices?: (ids: string[], at: { x: number; y: number }) => void
  /** Over an empty map that takes drops. */
  emptyState?: ReactNode
  /** Devices just added and not fetched yet, muted where they will land. */
  pending?: readonly PendingCard[]
}

/** Where to aim the camera for a node: diagram nodes are placed by their
 * centre, the older cards by their corner. */
function nodeCentre(n: Node): { x: number; y: number } {
  return n.origin ? n.position : { x: n.position.x + 110, y: n.position.y + 40 }
}

/** A built map: React Flow's nodes and edges, and the Diagram's model
 * (with the worker's name for it when it was built there). */
interface Built {
  nodes: Node[]
  edges: Edge[]
  model: DiagramModel | null
  modelId?: number
  /** What the build was asked with that restarts the layout. */
  stamp?: Stamp
}

/** The inputs that decide whether an applied build restarts the layout. */
interface Stamp {
  layoutTick: number
  nodeStyle: NodeStyle
  fitKey: string
  direction: "LR" | "TB"
  diagramMode: DiagramMode
  positions: Record<string, [number, number]> | undefined
}

const EMPTY_BUILT: Built = { nodes: [], edges: [], model: null }

/** Nodes carrying the Diagram cards' new boxes and nubs, and the
 * breakout junctions where they now sit (relinkDiagram). */
function withCards(
  nodes: Node[],
  cards: Map<string, DiagramCardData["diagram"]>,
  junctions?: Map<string, { x: number; y: number }>
): Node[] {
  if (!cards.size && !junctions?.size) return nodes
  return nodes.map((n) => {
    const next = cards.get(n.id)
    if (next)
      return {
        ...n,
        width: next.box.w,
        height: next.box.h,
        data: { ...n.data, diagram: next },
      }
    const j = junctions?.get(n.id)
    return j && (j.x !== n.position.x || j.y !== n.position.y)
      ? { ...n, position: { x: j.x, y: j.y }, hidden: false }
      : n
  })
}

/** The cable a Diagram link draws, when it is one part of a breakout -
 * its trunk and legs hover and select together. */
function cableOfEdge(e: Edge | undefined): string | undefined {
  return (e?.data as { cableId?: string } | undefined)?.cableId
}

/** The minimap paints a diagram card in its role colour. */
function miniColor(n: Node): string {
  const role = (n.data as { role?: { color?: string } | null }).role
  return role?.color ? `#${role.color.replace(/^#/, "")}` : "var(--muted)"
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
    bundleLags = true,
    nodeStyle = "stencil",
    positions,
    zones,
    onZonesChange,
    layoutTick = 0,
    fitKey = "",
    matchedIds,
    selectedEdgeId = null,
    hiddenPorts,
    originId,
    onSelectNode,
    onSelectEdge,
    onSelectBundle,
    onSelectGroup,
    onSelectGroupEdge,
    onDrillGroup,
    onOpenDevice,
    onNodeContext,
    onPaneContext,
    onGhostEdge,
    onBgpEdge,
    onCanvasClick,
    onDragEnd,
    diagramMode = "simple",
    diagramLine = "straight",
    linkOverrides,
    diagramLabels,
    monitor,
    onDropDevices,
    emptyState,
    pending,
  },
  ref
) {
  const { theme } = useTheme()
  const flow = useReactFlow()
  const wrapper = useRef<HTMLDivElement>(null)
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  // A map that opens empty to be built on is not fitted when its first
  // card lands: the camera stays where the card was dropped.
  const [fitOnOpen] = useState(
    () => !(onDropDevices && graph.nodes.length === 0)
  )

  // Aligned hierarchy cables are already near-straight; flat draws floating
  // point-to-point beziers - neither re-routes orthogonally. The Diagram
  // re-anchors its own links (relinkDiagram).
  const diagram = nodeStyle === "diagram"
  const routingActive =
    edgeRouting === "routed" &&
    nodeStyle !== "hierarchy" &&
    nodeStyle !== "flat" &&
    !diagram

  // The tenant's names for "down" and "degraded": a card keeps room for its
  // pill as it will actually read.
  const statusLabels = useStatusLabels()
  const downLabel = statusLabels.down?.name
  const degradedLabel = statusLabels.degraded?.name
  const checkLabels = useMemo(
    () => ({ down: downLabel, degraded: degradedLabel }),
    [downLabel, degradedLabel]
  )

  // Diagram cards are sized from measured text. Until Inter has loaded the
  // widths are estimates: once it has - and only if a card was measured
  // without it - the cards are measured again where they stand (no new
  // layout).
  const [fontTick, setFontTick] = useState(0)
  useEffect(() => {
    if (!diagram) return
    let live = true
    void diagramFontsReady().then((changed) => {
      if (live && changed) setFontTick((t) => t + 1)
    })
    return () => {
      live = false
    }
  }, [diagram])

  // The Diagram is laid out in a worker (diagram-client.ts) wherever the
  // browser has one, so a big map never holds the page while it is built;
  // the server, tests and a worker that fails build it here instead.
  const [workerFailed, setWorkerFailed] = useState(false)
  // The worker sizes devices and site/location cards (the kinds the
  // topology API sends); anything else is sized by the node registry here.
  const plainGraph = useMemo(
    () => graph.nodes.every((n) => n.type === "device" || n.type === "group"),
    [graph]
  )
  const offThread =
    diagram && plainGraph && !workerFailed && canBuildOffThread()
  const workerRef = useRef<DiagramWorker | null>(null)
  const worker = useCallback(
    () => (workerRef.current ??= new DiagramWorker()),
    []
  )
  useEffect(
    () => () => {
      workerRef.current?.dispose()
      workerRef.current = null
    },
    []
  )
  const lostWorker = useCallback(() => {
    workerRef.current?.dispose()
    workerRef.current = null
    setWorkerFailed(true)
  }, [])
  // Builds and relinks in flight: the map shows "Loading..." meanwhile.
  const [busy, setBusy] = useState(0)

  const inPlace = useMemo<Built | null>(
    () =>
      offThread
        ? null
        : diagram
          ? buildDiagram(graph, {
              mode: diagramMode,
              line: diagramLine,
              links: linkOverrides,
              ...(diagramLabels ? { labels: diagramLabels } : {}),
              colorMode,
              direction,
              roleOrder,
              roleBonds,
              roleDistance,
              bundleLags,
              positions,
              matched: matchedIds,
              focusNodeId,
              checkLabels,
              sizeOf,
            })
          : {
              ...build(graph, {
                focusNodeId,
                direction,
                roleOrder,
                roleBonds,
                roleDistance,
                edgeRouting,
                colorMode,
                nodeStyle,
                bundleLags,
                // Positions pin whenever the parent supplies them. A
                // deliberate relayout CLEARS them at the source (the page
                // sets positions to undefined before bumping layoutTick) -
                // gating on the tick here instead made every drag AFTER a
                // relayout snap straight back.
                positions,
                matched: matchedIds,
                hiddenPorts,
                originId,
              }),
              model: null,
            },
    // layoutTick discards saved positions on purpose.
    [
      offThread,
      graph,
      focusNodeId,
      direction,
      roleOrder,
      roleDistance,
      edgeRouting,
      colorMode,
      nodeStyle,
      bundleLags,
      positions,
      layoutTick,
      matchedIds,
      hiddenPorts,
      originId,
      diagram,
      diagramMode,
      diagramLine,
      linkOverrides,
      diagramLabels,
      checkLabels,
    ]
  )

  // Off the main thread: what to build, and what the build restarts (the
  // same signals the in-place path reads from its props when it applies a
  // build). Search dimming and the focused card are no part of it - the
  // page applies them, and they change no layout.
  const request = useMemo(
    () =>
      offThread
        ? {
            graph,
            opts: {
              mode: diagramMode,
              line: diagramLine,
              links: linkOverrides,
              ...(diagramLabels ? { labels: diagramLabels } : {}),
              colorMode,
              direction,
              roleOrder,
              roleBonds,
              roleDistance,
              bundleLags,
              positions,
              checkLabels,
            },
            stamp: {
              layoutTick,
              nodeStyle,
              fitKey,
              direction,
              diagramMode,
              positions,
            },
          }
        : null,
    [
      offThread,
      graph,
      diagramMode,
      diagramLine,
      linkOverrides,
      diagramLabels,
      colorMode,
      direction,
      roleOrder,
      roleBonds,
      roleDistance,
      bundleLags,
      positions,
      checkLabels,
      layoutTick,
      nodeStyle,
      fitKey,
    ]
  )
  const [offBuilt, setOffBuilt] = useState<Built | null>(null)
  useEffect(() => {
    // Back on another tab: a Diagram built before is stale by the time the
    // tab comes back - it waits for its new build instead.
    if (!request) {
      setOffBuilt(null)
      return
    }
    let live = true
    setBusy((b) => b + 1)
    worker()
      .build(request.graph, request.opts)
      .then(
        (res) => {
          if (live && res)
            setOffBuilt({
              nodes: res.nodes,
              edges: res.edges,
              model: res.model,
              modelId: res.modelId,
              stamp: request.stamp,
            })
        },
        () => {
          if (live) lostWorker()
        }
      )
      .finally(() => setBusy((b) => b - 1))
    return () => {
      live = false
    }
  }, [request, worker, lostWorker])

  const built: Built = (offThread ? offBuilt : inPlace) ?? EMPTY_BUILT
  // What an applied build restarts, as of the build: off the main thread
  // the props may already be a build further on.
  const stamp: Stamp | null = offThread
    ? (offBuilt?.stamp ?? null)
    : { layoutTick, nodeStyle, fitKey, direction, diagramMode, positions }
  /** The Diagram's anchoring state, as the last build or drag left it. */
  const modelRef = useRef<DiagramModel | null>(null)
  /** The worker's name for that model, when it was built there. */
  const modelIdRef = useRef<number | null>(null)
  const focusRef = useRef(focusNodeId)
  focusRef.current = focusNodeId

  // ── zones ──────────────────────────────────────────────────────────
  // Held outside `built`, because a zone drag must not rebuild the graph -
  // and a graph rebuild must not drop the zones.
  const zonesRef = useRef<Zone[]>(zones ?? [])
  zonesRef.current = zones ?? []
  // Through a ref, and the callbacks are built ONCE. The parent passes a
  // fresh arrow every render, so a callback that depended on it changed
  // identity every render too - which re-ran the sync effect below and put
  // the zone back where it was saved, mid-drag. Nothing moved, ever.
  const onZonesChangeRef = useRef(onZonesChange)
  onZonesChangeRef.current = onZonesChange
  const zoneCb = useMemo<ZoneCallbacks>(() => {
    const patch = (id: string, p: Partial<Zone>) =>
      onZonesChangeRef.current?.(
        zonesRef.current.map((z) => (z.id === id ? { ...z, ...p } : z))
      )
    return {
      onRename: (id, label) => patch(id, { label }),
      onRecolor: (id, color) => patch(id, { color }),
      onDelete: (id) =>
        onZonesChangeRef.current?.(
          zonesRef.current.filter((z) => z.id !== id)
        ),
      onResizeEnd: () => emitZonesRef.current(),
    }
  }, [])
  const zoneNodes = useRef<Node[]>([])
  // A ref, because the zone nodes are built before emitZones is declared and
  // must not be rebuilt every time its identity changes.
  const emitZonesRef = useRef<() => void>(() => undefined)
  // Signature, not identity: the parent hands back a new array after every
  // drag, and re-seeding the nodes from it on each one would fight the drag
  // that produced it.
  const zoneSig = (zones ?? [])
    .map((z) => `${z.id}:${z.label}:${z.color}:${z.x}:${z.y}:${z.w}:${z.h}`)
    .join("|")

  const [nodes, setNodes, onNodesChange] = useNodesState(built.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(built.edges)
  // Zoom level-of-detail: far out, edge labels (and further out, port text)
  // hide via CSS keyed on the wrapper's data-lod - pure paint, no re-layout,
  // so a big graph reads as clean boxes-and-lines until you zoom in.
  const [lod, setLod] = useState(0)
  // Diagram port names are 9px along the line: unreadable well before the
  // cable labels are, so they go first.
  const [portText, setPortText] = useState(true)
  const onMove = useCallback((_: unknown, vp: { zoom: number }) => {
    // Cable labels are the map's most useful text - they stay until the
    // graph is genuinely too small to read, not at the zoom a fitted
    // fabric happens to land on.
    const next = vp.zoom < 0.2 ? 2 : vp.zoom < 0.32 ? 1 : 0
    setLod((cur) => (cur === next ? cur : next))
    setPortText(vp.zoom >= 0.55)
  }, [])
  // Hover/select emphasis: the active edge thickens, rises, and always
  // carries a full label (synthesized when the resting edge has none - a
  // cable must name itself on hover whatever the view or zoom); every other
  // edge fades - the only way crossings stay readable in a dense mesh.
  const [hotEdge, setHotEdge] = useState<string | null>(null)
  // Clicking a card spotlights its neighbourhood: everything not cabled to
  // it fades, so "what does this switch touch" reads instantly on a dense
  // map. Cleared by clicking empty canvas.
  const [spotId, setSpotId] = useState<string | null>(null)
  // Cursor tooltip naming the hovered cable (and any card element carrying
  // a data-tip) - see canvas-tip.tsx.
  const tipApi = useRef<CanvasTipHandle>(null)
  // A whole-map PNG needs every card in the DOM, but React Flow only mounts
  // what is on screen. Set for the length of that capture.
  const [capturing, setCapturing] = useState(false)
  // The spotlight card's direct neighbours - everything else fades.
  const spotSet = useMemo(() => {
    if (!spotId) return null
    const keep = new Set([spotId])
    for (const e of edges) {
      if (e.source === spotId) keep.add(e.target)
      if (e.target === spotId) keep.add(e.source)
    }
    // A breakout's junction passes the spotlight on to its far cards.
    for (const e of edges)
      if (keep.has(e.source) && e.source !== spotId && cableOfEdge(e))
        keep.add(e.target)
    return keep
  }, [edges, spotId])
  // A spotlit card taken off the map takes the spotlight with it - else
  // every card left would stay dimmed with no visible cause.
  useEffect(() => {
    if (spotId && !nodes.some((n) => n.id === spotId)) setSpotId(null)
  }, [nodes, spotId])
  const shownEdges = useMemo(() => {
    if (!hotEdge && !selectedEdgeId && !spotSet) return edges
    // A breakout's trunk and legs light up together.
    const hotCable = hotEdge
      ? cableOfEdge(edges.find((e) => e.id === hotEdge))
      : undefined
    const selCable = selectedEdgeId
      ? cableOfEdge(edges.find((e) => e.id === selectedEdgeId))
      : undefined
    return edges.map((e) => {
      const cable = cableOfEdge(e)
      const isHot = e.id === hotEdge || (!!cable && cable === hotCable)
      const isSel = e.id === selectedEdgeId || (!!cable && cable === selCable)
      if (isHot || isSel)
        return {
          ...e,
          // The hot edge keeps its label at any LOD (CSS exempts .topo-hot;
          // a diagram link's mid-line chip lives outside the edge, so it
          // is told through its data).
          className: isHot ? "topo-hot" : e.className,
          zIndex: 1000,
          style: {
            ...e.style,
            strokeWidth: 2.5,
            opacity: 1,
            ...(isSel ? { stroke: "var(--primary)" } : {}),
          },
          ...(e.type === "link" ? { data: { ...e.data, hot: true } } : {}),
        }
      const offSpot =
        spotSet &&
        e.source !== spotId &&
        e.target !== spotId &&
        !(cable && spotSet.has(e.source) && spotSet.has(e.target))
      return hotEdge || offSpot
        ? {
            ...e,
            style: { ...e.style, opacity: 0.15 },
            labelStyle: { ...e.labelStyle, opacity: 0.2 },
          }
        : e
    })
  }, [edges, hotEdge, selectedEdgeId, spotSet, spotId])
  // A card's monitoring pill, merged per node and remembered, so a drag
  // (a new nodes array every frame) re-renders only the card that moved.
  const monMemo = useRef(
    new Map<string, { src: Node; status: string | null; out: Node }>()
  )
  // Built off the main thread, the search dims here (the in-place build
  // dims in the build).
  const searchSet = offThread ? (matchedIds ?? null) : null
  const shownNodes = useMemo(() => {
    if (!spotSet && !monitor && !searchSet) return nodes
    const memo = monMemo.current
    return nodes.map((n) => {
      let out = n
      if (monitor && n.type === "card") {
        const dev = (n.data as DiagramCardData).device_id
        const status = (dev && monitor[dev]?.status) || null
        const hit = memo.get(n.id)
        if (hit && hit.src === n && hit.status === status) out = hit.out
        else {
          out = status ? { ...n, data: { ...n.data, monitor: status } } : n
          memo.set(n.id, { src: n, status, out })
        }
      }
      const unmatched =
        !!searchSet &&
        !searchSet.has(n.id) &&
        n.type !== "zone" &&
        n.type !== "junction"
      return !unmatched &&
        (!spotSet || spotSet.has(n.id) || n.type === "sitegroup")
        ? out
        : { ...out, data: { ...out.data, dimmed: true } }
    })
  }, [nodes, spotSet, monitor, searchSet])
  // Built off the main thread, a newly focused card is selected here (the
  // in-place build selects it).
  useEffect(() => {
    if (!offThread) return
    setNodes((cur) =>
      cur.some((n) => n.selected !== (n.id === focusNodeId))
        ? cur.map((n) =>
            n.type === "zone" || n.selected === (n.id === focusNodeId)
              ? n
              : { ...n, selected: n.id === focusNodeId }
          )
        : cur
    )
  }, [offThread, focusNodeId, setNodes])
  // Re-sync when the built graph changes, but keep user-dragged positions
  // for nodes that are still present (so a color-mode flip doesn't shuffle).
  const prevNodes = useRef<Node[]>([])
  const prevTick = useRef(layoutTick)
  const prevStyle = useRef(nodeStyle)
  const prevDirection = useRef(direction)
  const prevFitKey = useRef(fitKey)
  const prevMode = useRef(diagramMode)
  const shownEmpty = useRef(false)
  const sLayoutTick = stamp?.layoutTick
  const sNodeStyle = stamp?.nodeStyle
  const sFitKey = stamp?.fitKey
  const sDirection = stamp?.direction
  const sMode = stamp?.diagramMode
  const sPositions = stamp?.positions
  useEffect(() => {
    // Off the main thread nothing is built yet: the map waits.
    if (!stamp) return
    const prev = new Map(prevNodes.current.map((n) => [n.id, n.position]))
    // Keep the user's dragged positions only across INCIDENTAL rebuilds
    // (colour mode, search highlight, a late graph refetch) - not when the
    // layout genuinely restarted. Three things restart it:
    //  - `layoutTick` bumped (Re-layout, direction, Levels, applying a view);
    //  - the NODE STYLE changed - node ids are identical across styles, so
    //    keeping "positions of nodes still present" here would hand Flat's
    //    coordinates to Hierarchy's cards (with port spans computed for a
    //    completely different arrangement). The page can't signal this via
    //    the tick: the style rides on the URL, so its render arrives a beat
    //    after any tick bump and the bump is consumed on the wrong style;
    //  - the QUERY changed (filter, focus, drill, builder set) - a different
    //    device set is never an incidental rebuild;
    //  - the DIRECTION changed. The trace maps flip it with a plain prop (no
    //    tick), and keeping side-to-side positions under tree-direction
    //    routing draws every cable as a giant loop around the map.
    // Read from the build's stamp: a build made off the main thread lands
    // after the props that asked for it, and it is the build that restarts.
    const restyled = stamp.nodeStyle !== prevStyle.current
    prevStyle.current = stamp.nodeStyle
    const requeried = stamp.fitKey !== prevFitKey.current
    prevFitKey.current = stamp.fitKey
    const redirected = stamp.direction !== prevDirection.current
    prevDirection.current = stamp.direction
    const relaidOut =
      stamp.layoutTick !== prevTick.current ||
      restyled ||
      requeried ||
      redirected
    prevTick.current = stamp.layoutTick
    // Simple and Detailed cards differ in size: an auto layout from one
    // mode is not kept for the other (a saved arrangement is - it pins the
    // centres both modes share). No re-fit, though: same map, same place.
    const remoded = stamp.diagramMode !== prevMode.current
    prevMode.current = stamp.diagramMode
    // A new layout is a new map - a stale spotlight would dim everything
    // with no visible cause.
    if (relaidOut) setSpotId(null)
    const first = !prevNodes.current.some((n) => n.type !== "zone")
    // The map was on screen empty (a view being built from scratch): its
    // first cards were dropped where the camera is, so it stays there.
    const wasEmpty = shownEmpty.current
    shownEmpty.current = built.nodes.length === 0
    const keepingDrags =
      !relaidOut &&
      !(diagram && remoded) &&
      !stamp.positions &&
      prevNodes.current.length > 0
    let nextNodes = built.nodes.map((n) => {
      const kept = prev.get(n.id)
      return kept && keepingDrags ? { ...n, position: kept } : n
    })
    // Built off the main thread: the focused card is selected here.
    if (built.modelId !== undefined)
      nextNodes = nextNodes.map((n) =>
        n.selected !== (n.id === focusRef.current)
          ? { ...n, selected: n.id === focusRef.current }
          : n
      )
    modelRef.current = built.model
    modelIdRef.current = built.modelId ?? null
    const refit = () =>
      requestAnimationFrame(() =>
        flow.fitView({ padding: 0.15, duration: 300 })
      )
    // Diagram: the kept positions are not the ones the links were anchored
    // for - re-anchor (and re-size the Detailed cards) where they are. Off
    // the main thread the worker does it, and the map stays as it was until
    // the answer is back.
    if (built.model && keepingDrags && built.modelId !== undefined) {
      const id = built.modelId
      const kept = nextNodes
      setBusy((b) => b + 1)
      worker()
        .relink(id, kept)
        .then(
          (re) => {
            if (modelIdRef.current !== id || !modelRef.current) return
            modelRef.current = relinkedModel(modelRef.current, re.cards)
            setNodes([
              ...zoneNodes.current,
              ...withCards(kept, re.cards, re.junctions),
            ])
            setEdges(re.edges)
          },
          () => lostWorker()
        )
        .finally(() => setBusy((b) => b - 1))
      return
    }
    let diagramEdges: Edge[] | null = null
    if (built.model && keepingDrags) {
      const re = relinkDiagram(built.model, nextNodes)
      modelRef.current = re.model
      diagramEdges = re.edges
      nextNodes = withCards(nextNodes, re.cards, re.junctions)
    }
    // Zones are not part of the built graph, so a rebuild would drop them.
    setNodes([...zoneNodes.current, ...nextNodes])
    if (diagramEdges) {
      setEdges(diagramEdges)
    } else if (routingActive && keepingDrags) {
      // When we kept dragged positions, `built.edges` were routed for the
      // layout's positions, not the kept ones - re-route from the actual
      // rendered positions so cables always match their cards.
      const wp = edgeWaypoints(nextNodes, built.edges, sizeOf, stamp.direction)
      setEdges(
        built.edges.map((e) => {
          const sem = (e.data as { sem?: string } | undefined)?.sem
          if (!sem || !ROUTABLE.has(sem)) return e
          const pts = wp.get(e.id)
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
    // Any relayout re-fits the viewport - without this the camera keeps
    // staring at wherever it was while the graph reshapes elsewhere, which
    // reads as a frozen/blank map on big graphs. A map built off the main
    // thread arrives after React Flow's own first fit: it fits then.
    // Never on an empty map: React Flow holds a fit it cannot do yet and
    // does it when the first card lands - which a map being built by hand
    // must not.
    if (
      built.nodes.length > 0 &&
      (relaidOut || (built.modelId !== undefined && first && !wasEmpty))
    )
      refit()
    // `stamp` is read through its fields: the in-place one is made afresh
    // every render.
  }, [
    built,
    setNodes,
    setEdges,
    sLayoutTick,
    sPositions,
    sDirection,
    routingActive,
    flow,
    sFitKey,
    sNodeStyle,
    diagram,
    sMode,
    worker,
    lostWorker,
  ])
  useEffect(() => {
    prevNodes.current = nodes
  }, [nodes])

  // Inter loaded after the cards were measured with the estimate: measure
  // them again where they stand and re-plan the lines, without a layout.
  // (A worker measures with Inter loaded in the worker: nothing to redo.)
  useEffect(() => {
    const model = modelRef.current
    if (!fontTick || !diagram || !model || modelIdRef.current !== null) return
    const re = remeasureDiagram(model, flow.getNodes())
    modelRef.current = re.model
    setNodes((cur) => withCards(cur, re.cards, re.junctions))
    setEdges(re.edges)
  }, [fontTick, diagram, flow, setNodes, setEdges])

  // Zone nodes live alongside the built graph: replaced whole whenever the
  // parent's list changes (added, deleted, renamed, or restored with a saved
  // view), never on the graph rebuilds that would otherwise drop them.
  useEffect(() => {
    // Read through the ref: `zones` is a fresh array after every drag, and
    // zoneSig is what actually decides whether anything changed.
    setNodes((cur) => {
      // Keep whatever was selected: re-seeding after a resize would
      // otherwise drop the selection, and the handles with it.
      const sel = new Set(
        cur.filter((n) => n.type === "zone" && n.selected).map((n) => n.id)
      )
      zoneNodes.current = zonesRef.current.map((z) => {
        const n = zoneToNode(z, zoneCb)
        return sel.has(n.id) ? { ...n, selected: true } : n
      })
      return [...zoneNodes.current, ...cur.filter((n) => n.type !== "zone")]
    })
  }, [zoneSig, zoneCb, setNodes])

  // What an export reads, through a ref so the handle keeps one identity:
  // the canvas's own state (not the rendered nodes and edges, which carry
  // the spotlight, hover emphasis and search dimming).
  const exportRef = useRef({ nodes, edges, monitor, statusLabels, diagram })
  exportRef.current = { nodes, edges, monitor, statusLabels, diagram }

  useImperativeHandle(
    ref,
    () => ({
      positions: () =>
        Object.fromEntries(
          flow
            .getNodes()
            // Zones carry their own geometry - a zone id in the arrangement
            // would be a node the layout keeps trying to place.
            .filter((n) => n.type !== "zone")
            .map((n) => [
              n.id,
              [n.position.x, n.position.y] as [number, number],
            ])
        ),
      center: () => {
        const el = wrapper.current
        if (!el) return { x: 0, y: 0 }
        const r = el.getBoundingClientRect()
        return flow.screenToFlowPosition({
          x: r.left + r.width / 2,
          y: r.top + r.height / 2,
        })
      },
      focusNode: (id: string) => {
        const n = flow.getNode(id)
        if (!n) return
        const c = nodeCentre(n)
        flow.setCenter(c.x, c.y, { zoom: 1.1, duration: 500 })
      },
      selectNode: (id: string) => {
        setSpotId(id)
        flow.setNodes((cur) =>
          cur.map((n) =>
            n.selected !== (n.id === id) ? { ...n, selected: n.id === id } : n
          )
        )
      },
      focusEdge: (id: string) => {
        const e = flow.getEdge(id)
        const a = e && flow.getNode(e.source)
        const b = e && flow.getNode(e.target)
        if (!a || !b) return
        const ca = nodeCentre(a)
        const cb = nodeCentre(b)
        flow.setCenter((ca.x + cb.x) / 2, (ca.y + cb.y) / 2, {
          zoom: 1,
          duration: 500,
        })
      },
      focusZone: (box) => {
        void flow.fitBounds(
          { x: box.x, y: box.y, width: box.w, height: box.h },
          { duration: 500, padding: 0.2 }
        )
      },
      exportPng: async (viewportOnly = false) => {
        const el = wrapper.current?.querySelector<HTMLElement>(
          ".react-flow__viewport"
        )
        if (!el) return null
        // The whole map: onlyRenderVisibleElements keeps offscreen cards
        // and cables out of the DOM, so the snapshot would silently drop
        // them. Mount everything, wait until React Flow has, then capture.
        if (!viewportOnly) {
          setCapturing(true)
          const want = flow.getNodes().filter((n) => !n.hidden).length
          const frame = () =>
            new Promise<void>((r) => requestAnimationFrame(() => r()))
          // At least two frames (commit, then React Flow placing the new
          // nodes and their edges), bounded so a stray count can't hang it.
          for (let i = 0; i < 60; i++) {
            await frame()
            if (
              i >= 1 &&
              el.querySelectorAll(".react-flow__node").length >= want
            )
              break
          }
        }
        // React Flow v12 draws each edge in an <svg> with NO width/height -
        // live it renders through `overflow: visible`, but the PNG rasterizer
        // clips every svg to its 0×0 box, exporting a map with no cables.
        // Give each such svg an explicit box covering its own content for the
        // duration of the export, then restore.
        const bare = [...el.querySelectorAll("svg")].filter(
          (svg) => !svg.getAttribute("width")
        )
        const restore = bare.map((svg) => {
          const prev = {
            svg,
            viewBox: svg.getAttribute("viewBox"),
            style: svg.getAttribute("style"),
          }
          try {
            const b = (svg as unknown as SVGGraphicsElement).getBBox()
            if (b.width > 0 || b.height > 0) {
              const pad = 24 // stroke width + labels overhang the bbox
              const x = b.x - pad
              const y = b.y - pad
              const w = b.width + pad * 2
              const h = b.height + pad * 2
              svg.setAttribute("width", String(w))
              svg.setAttribute("height", String(h))
              svg.setAttribute("viewBox", `${x} ${y} ${w} ${h}`)
              svg.style.position = "absolute"
              svg.style.left = `${x}px`
              svg.style.top = `${y}px`
              svg.style.overflow = "visible"
            }
          } catch {
            /* detached/empty svg - leave it alone */
          }
          return prev
        })
        const undo = () => {
          for (const r of restore) {
            r.svg.removeAttribute("width")
            r.svg.removeAttribute("height")
            if (r.viewBox) r.svg.setAttribute("viewBox", r.viewBox)
            else r.svg.removeAttribute("viewBox")
            if (r.style) r.svg.setAttribute("style", r.style)
            else r.svg.removeAttribute("style")
          }
        }
        try {
          if (viewportOnly) {
            // Just what's on screen - for pasting a detail into a ticket
            // without shipping the whole estate.
            const w = wrapper.current?.clientWidth ?? 1200
            const h = wrapper.current?.clientHeight ?? 800
            const vp = flow.getViewport()
            return await toPng(el, {
              backgroundColor: theme === "dark" ? "#09090b" : "#ffffff",
              width: w,
              height: h,
              style: {
                width: `${w}px`,
                height: `${h}px`,
                transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})`,
              },
            })
          }
          const bounds = getNodesBounds(flow.getNodes())
          const w = Math.min(4096, Math.max(800, Math.ceil(bounds.width) + 160))
          const h = Math.min(
            4096,
            Math.max(600, Math.ceil(bounds.height) + 160)
          )
          const vp = getViewportForBounds(bounds, w, h, 0.2, 2, 0.06)
          return await toPng(el, {
            backgroundColor: theme === "dark" ? "#09090b" : "#ffffff",
            width: w,
            height: h,
            style: {
              width: `${w}px`,
              height: `${h}px`,
              transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})`,
            },
          })
        } finally {
          undo()
          if (!viewportOnly) setCapturing(false)
        }
      },
      document: ({ area = "all", ...opts }) => {
        const live = exportRef.current
        let box: Rect | null = null
        const el = wrapper.current
        if (area === "visible" && el) {
          const vp = flow.getViewport()
          box = {
            x: -vp.x / vp.zoom,
            y: -vp.y / vp.zoom,
            w: el.clientWidth / vp.zoom,
            h: el.clientHeight / vp.zoom,
          }
        }
        const cards = live.nodes.filter((n) => n.type !== "zone")
        const model = modelRef.current
        if (live.diagram && model)
          return toDocument(
            model,
            { nodes: cards, edges: live.edges },
            zonesRef.current,
            {
              ...opts,
              area: box,
              monitor: live.monitor,
              checkLabels: live.statusLabels,
            }
          )
        return fromFlow(cards, live.edges, zonesRef.current, {
          ...opts,
          area: box,
        })
      },
      boxes: () => {
        const out: Record<string, Rect> = {}
        for (const n of flow.getNodes()) {
          if (n.type === "zone" || n.type === "junction" || n.hidden) continue
          const w = n.width ?? n.measured?.width
          const h = n.height ?? n.measured?.height
          if (!w || !h) continue
          // Diagram cards stand on their centre, the older cards on
          // their corner.
          const [ox, oy] = n.origin ?? [0, 0]
          out[n.id] = {
            x: n.position.x - ox * w,
            y: n.position.y - oy * h,
            w,
            h,
          }
        }
        return out
      },
      selectedDevices: () =>
        flow
          .getNodes()
          .filter((n) => n.selected)
          .map((n) => (n.data as { device_id?: string }).device_id)
          .filter((id): id is string => !!id),
    }),
    [flow, theme]
  )

  // Devices dragged in from a device list. Only a map built by hand takes
  // them; anything else dragged over the canvas is left alone.
  const takesDrops = !!onDropDevices
  const onDragOver = useCallback(
    (e: DragEvent) => {
      if (!takesDrops) return
      if (!Array.from(e.dataTransfer.types).includes(DEVICE_IDS_MIME)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = "copy"
    },
    [takesDrops]
  )
  const onDrop = useCallback(
    (e: DragEvent) => {
      if (!onDropDevices) return
      const ids = parseDragIds(e.dataTransfer.getData(DEVICE_IDS_MIME))
      if (!ids.length) return
      e.preventDefault()
      onDropDevices(
        ids,
        flow.screenToFlowPosition({ x: e.clientX, y: e.clientY })
      )
    },
    [onDropDevices, flow]
  )

  const onNodeClick = useCallback(
    (_: unknown, node: Node) => {
      // A breakout's junction is part of its cable.
      if (node.type === "junction") {
        const { raw, trunk } = node.data as {
          raw?: TopoEdge["data"]
          trunk?: string
        }
        if (raw) onSelectEdge?.(raw, trunk ?? `${node.id}:t`)
        return
      }
      if (node.type === "sitegroup")
        onSelectGroup?.(node.data as unknown as TopoGroupData)
      else {
        setSpotId(node.id)
        onSelectNode?.(node.data as TopologyGraph["nodes"][number]["data"])
      }
    },
    [onSelectNode, onSelectGroup, onSelectEdge]
  )
  const onNodeDoubleClick = useCallback(
    (_: unknown, node: Node) => {
      if (node.type === "sitegroup") {
        const d = node.data as unknown as TopoGroupData
        if (d.group_id) onDrillGroup?.(d)
        return
      }
      const dev = (node.data as { device_id?: string }).device_id
      if (dev) onOpenDevice?.(dev)
    },
    [onDrillGroup, onOpenDevice]
  )
  const onEdgeClick = useCallback(
    (_: unknown, edge: Edge) => {
      const data = edge.data as
        | {
            sem?: string
            ghost?: GhostEdgeData
            bgp?: NonNullable<TopoEdge["data"]>
            raw?: TopoEdge["data"]
            cables?: BundleMember[]
            group?: GroupEdgeInfo
          }
        | undefined
      if (data?.sem === "ghost" && data.ghost) onGhostEdge?.(data.ghost)
      if (data?.sem === "bgp" && data.bgp) onBgpEdge?.(data.bgp)
      else if (
        (data?.sem === "bundle" || data?.sem === "lagbundle") &&
        data.cables
      )
        onSelectBundle?.(data.cables, edge.id, linkRef(edge))
      else if (data?.sem === "groupedge" && data.group)
        onSelectGroupEdge?.(data.group, edge.id)
      else if (data?.raw) onSelectEdge?.(data.raw, edge.id, linkRef(edge))
    },
    [onGhostEdge, onBgpEdge, onSelectEdge, onSelectBundle, onSelectGroupEdge]
  )

  // Dragging a card changes which side of it faces each neighbour - re-snap
  // the edges, and RE-ROUTE the cables from the new positions (so moving a
  // node re-bends its cables around cards instead of leaving them straight).
  /** Zone geometry back to the parent. Called on drag stop and on resize
   * end, the only two things that move a box. */
  const emitZones = useCallback(() => {
    if (!onZonesChangeRef.current) return
    const next = nodesToZones(flow.getNodes(), zonesRef.current)
    const same =
      next.length === zonesRef.current.length &&
      next.every((z, i) => {
        const p = zonesRef.current[i]
        return z.id === p.id && z.x === p.x && z.y === p.y && z.w === p.w && z.h === p.h
      })
    if (!same) onZonesChangeRef.current(next)
  }, [flow])

  emitZonesRef.current = emitZones

  const onNodeDragStop = useCallback(() => {
    emitZones()
    const model = modelRef.current
    const modelId = modelIdRef.current
    if (diagram && model && modelId !== null) {
      // Built off the main thread: the worker re-anchors, and the lines
      // follow when it answers (unless a newer build took over).
      setBusy((b) => b + 1)
      worker()
        .relink(modelId, flow.getNodes())
        .then(
          (re) => {
            if (modelIdRef.current !== modelId || !modelRef.current) return
            modelRef.current = relinkedModel(modelRef.current, re.cards)
            setNodes((cur) => withCards(cur, re.cards, re.junctions))
            setEdges(re.edges)
          },
          () => lostWorker()
        )
        .finally(() => setBusy((b) => b - 1))
      onDragEnd?.()
      return
    }
    if (diagram && model) {
      // Re-anchor from where the cards are now: sides re-chosen, Detailed
      // cards re-sized around their centres, elbow channels re-routed.
      const re = relinkDiagram(model, flow.getNodes())
      modelRef.current = re.model
      // Into the real state, not the rendered nodes (those carry the
      // spotlight's dimming and the monitoring pill).
      setNodes((cur) => withCards(cur, re.cards, re.junctions))
      setEdges(re.edges)
      onDragEnd?.()
      return
    }
    if (nodeStyle === "hierarchy") {
      // Both ends of every moved cable re-align: chips re-stack toward
      // their peers' current positions, handles follow, blocked cables
      // re-route around cards.
      const liveNodes = flow.getNodes()
      setEdges((cur) => {
        const res = realignHierPorts(liveNodes, cur)
        const nextNodes = liveNodes.map((n) =>
          res.portPos.has(n.id)
            ? {
                ...n,
                data: {
                  ...n.data,
                  portPos: res.portPos.get(n.id),
                  portSpan: res.span.get(n.id) ?? 0,
                },
              }
            : n
        )
        // `flow.getNodes()` returns the RENDERED nodes, which carry the
        // derived spotlight flag - writing them straight back froze the
        // dimming into state, so clearing the spotlight left cards greyed
        // and a new spotlight highlighted nothing. Merge positions and port
        // geometry into the real state instead, and drop `dimmed`.
        setNodes((cur) => {
          const byId = new Map(nextNodes.map((n) => [n.id, n]))
          return cur.map((n) => {
            const live = byId.get(n.id)
            if (!live) return n
            const { dimmed: _dimmed, ...liveData } = live.data as Record<
              string,
              unknown
            >
            return {
              ...n,
              position: live.position,
              data: { ...(n.data as object), ...liveData },
            }
          })
        })
        const next = cur.map((e) => {
          const d = e.data as { sem?: string; baseS?: string; baseT?: string }
          if ((d.sem !== "cable" && d.sem !== "lagbundle") || !d.baseS || !d.baseT)
            return e
          const sS = res.sides.get(e.source)?.[d.baseS] ?? "R"
          const tS = res.sides.get(e.target)?.[d.baseT] ?? "L"
          return {
            ...e,
            sourceHandle: handleId(d.baseS, sS),
            targetHandle: handleId(d.baseT, tS),
          }
        })
        const wp = hierarchyWaypoints(nextNodes, next, res.portPos)
        return next.map((e) => {
          const sem = (e.data as { sem?: string } | undefined)?.sem
          if (sem !== "cable" && sem !== "lagbundle") return e
          const pts = wp.get(e.id)
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
      return
    }
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
      // Straight mode (and the flat view): only re-snapped sides, nothing
      // to route.
      if (!routingActive) return next
      const wp = edgeWaypoints(liveNodes, next, sizeOf, direction)
      return next.map((e) => {
        const sem = (e.data as { sem?: string } | undefined)?.sem
        if (!sem || !ROUTABLE.has(sem)) return e
        const pts = wp.get(e.id)
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
  }, [
    flow,
    setEdges,
    setNodes,
    direction,
    routingActive,
    onDragEnd,
    nodeStyle,
    emitZones,
    diagram,
    worker,
    lostWorker,
  ])

  if (!mounted)
    return <div className="h-full w-full animate-pulse bg-muted/30" />
  // A map built by hand stays a live canvas while empty: it is where the
  // first devices get dropped.
  const empty = graph.nodes.length === 0
  // Too many cards for an SVG rect each in the minimap.
  const bigMap = nodes.length > CANVAS_MINIMAP_AT
  if (empty && !takesDrops)
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState title="Nothing to map yet." className="bg-card">
          Cable some devices first.
        </EmptyState>
      </div>
    )

  return (
    <div
      ref={wrapper}
      className="relative h-full w-full"
      data-lod={lod}
      data-ports={portText ? undefined : "off"}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <ReactFlow
        nodes={shownNodes}
        edges={shownEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView={fitOnOpen}
        colorMode={theme}
        proOptions={{ hideAttribution: true }}
        nodesConnectable={false}
        onNodeClick={onNodeClick}
        onNodeDoubleClick={onNodeDoubleClick}
        zoomOnDoubleClick={!onOpenDevice}
        onNodeContextMenu={(ev, node) => {
          ev.preventDefault()
          if (node.type !== "junction")
            onNodeContext?.(node, ev.clientX, ev.clientY)
        }}
        onPaneContextMenu={(ev) => {
          ev.preventDefault()
          const p = flow.screenToFlowPosition({
            x: ev.clientX,
            y: ev.clientY,
          })
          onPaneContext?.(ev.clientX, ev.clientY, p.x, p.y)
        }}
        onNodeDragStop={onNodeDragStop}
        onEdgeClick={onEdgeClick}
        onEdgeMouseEnter={(ev, e) => {
          setHotEdge(e.id)
          tipApi.current?.show(
            hoverLabel(e) ?? (typeof e.label === "string" ? e.label : null),
            ev
          )
        }}
        onEdgeMouseMove={(ev) => tipApi.current?.move(ev)}
        onEdgeMouseLeave={() => {
          setHotEdge(null)
          tipApi.current?.hide()
        }}
        onPaneClick={() => {
          setSpotId(null)
          onCanvasClick?.()
        }}
        onMove={onMove}
        onlyRenderVisibleElements={!capturing}
        // Cards and zones leave the map through explicit actions (the
        // context menu, the zone toolbar) - never a stray Backspace.
        deleteKeyCode={null}
        minZoom={0.05}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
        <Controls showInteractive={false} />
        {bigMap && (
          <MiniMapCanvas
            nodeColor={diagram ? miniColor : undefined}
            theme={theme}
          />
        )}
        <MiniMap
          pannable
          zoomable
          nodeColor={diagram ? miniColor : undefined}
          // A big map's cards are painted underneath, on one canvas.
          nodeComponent={bigMap ? NoMiniMapNode : undefined}
          className={cn(
            "rounded-md border !border-border",
            bigMap ? "!bg-transparent" : "!bg-card"
          )}
        />
        {!!pending?.length && (
          <ViewportPortal>
            {pending.map((p) => (
              <PendingCardView key={p.id} card={p} />
            ))}
          </ViewportPortal>
        )}
      </ReactFlow>
      {empty && !pending?.length && emptyState && !(offThread && !offBuilt) && (
        // Drops land on the canvas underneath; only the card's own
        // controls take the pointer.
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-6">
          <div className="pointer-events-auto">{emptyState}</div>
        </div>
      )}
      <CanvasTip ref={tipApi} root={wrapper} />
      {offThread && (busy > 0 || !offBuilt) && (
        // Laid out off the main thread: the map stays usable, and the last
        // layout stays up until the new one lands.
        <div
          className={cn(
            "pointer-events-none absolute inset-x-0 z-10 flex justify-center text-sm text-muted-foreground",
            offBuilt ? "top-3" : "inset-y-0 items-center"
          )}
        >
          Loading...
        </div>
      )}
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
