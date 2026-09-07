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
import {
  ABOVE,
  BELOW,
  PortNode,
  RIGHT,
  StencilNode,
  handleId,
} from "./stencil-node"
import type { PortSide } from "./stencil-node"
import { FLAT_H, FlatNode, flatHeight, flatW, flatWidth } from "./flat-node"
import type { FlatAnchor, FlatData } from "./flat-node"
import { GROUP_H, GROUP_W, GroupNode } from "./group-node"
import { HierarchyNode, hierarchyWidth } from "./hierarchy-node"
import type { GroupEdgeInfo, TopoGroupData } from "./group-node"
import {
  edgeWaypoints,
  hierarchyWaypoints,
  layoutHierarchy,
  layoutNodes,
  realignHierPorts,
} from "./layout"
import { resolveLevels } from "./level-organiser"
import { roleTiers } from "./levels-param"
import { RoutedEdge } from "./routed-edge"
import { groupLagEdges, lagBundleLabel, sharedLag } from "./lag-bundles"

// Defined once, outside the component (re-creating nodeTypes each render
// re-mounts every node - a classic React Flow footgun).
const nodeTypes = {
  device: StencilNode,
  flat: FlatNode,
  // "sitegroup", not "group": React Flow reserves "group" and paints its own
  // grey stock box behind it.
  sitegroup: GroupNode,
  hier: HierarchyNode,
  interface: PortNode,
  front_port: PortNode,
  rear_port: PortNode,
}
const edgeTypes = { routed: RoutedEdge }

export type EdgeColorMode = "cable" | "type" | "status" | "speed" | "none"

/** "stencil" = wiring cards with port rows; "hierarchy" = tall cards with
 * peer-aligned port chips (near-straight cables); "flat" = barebones fixed
 * chips with parallel cables bundled into one ×N edge. */
export type NodeStyle = "stencil" | "hierarchy" | "flat"

/** One member of a Flat-view bundled edge (the underlying cable's data). */
export type BundleMember = NonNullable<TopoEdge["data"]>

const flatSize = (n: Node) => ({
  width: flatW(n.data as { name?: string }),
  height: FLAT_H,
})
const groupSize = () => ({ width: GROUP_W, height: GROUP_H })

export interface CanvasHandle {
  /** Current node positions (for saving a view). */
  positions: () => Record<string, [number, number]>
  /** Zoom/center on one node. */
  focusNode: (id: string) => void
  /** Render the graph to a PNG data URL - the whole diagram, or just the
   * visible viewport. */
  exportPng: (viewportOnly?: boolean) => Promise<string | null>
}

// Deterministic palette per cable type - informational hue, not state.
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

/** "10G" / "2.5 Gbps" / "1000" (Mbps) → Mbps, or null when unparsable. */
function speedMbps(s: string): number | null {
  const m = /([\d.]+)\s*([tgm]?)/i.exec(s.trim())
  if (!m) return null
  const n = parseFloat(m[1])
  if (!isFinite(n)) return null
  const u = m[2].toLowerCase()
  return u === "t" ? n * 1e6 : u === "g" ? n * 1000 : n
}

/** Speed tier hue - faster = hotter. Unparsable/absent speeds stay zinc. */
export function speedColor(s?: string | null): string | undefined {
  if (!s) return undefined
  const mb = speedMbps(s)
  if (mb == null) return "#71717a"
  if (mb >= 100000) return "#e11d48" // 100G+
  if (mb >= 40000) return "#f59e0b" // 40G
  if (mb >= 25000) return "#8b5cf6" // 25G
  if (mb >= 10000) return "#0ea5e9" // 10G
  if (mb >= 1000) return "#10b981" // 1G
  return "#71717a"
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
  if (mode === "speed") return speedColor(data?.speed)
  if (mode === "cable" && data?.color) return data.color
  return undefined
}

/** Edge semantics that carry node-avoiding routing. */
const ROUTABLE = new Set(["cable", "lagbundle", "bundle", "groupedge"])

/** The full name a cable edge announces on hover - label/number, media,
 * speed, and its endpoint pair(s). Bundles and group edges summarize. */
function hoverLabel(e: Edge): string | undefined {
  const d = e.data as
    | {
        sem?: string
        raw?: TopoEdge["data"]
        cables?: BundleMember[]
        group?: GroupEdgeInfo
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
    if (pair)
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

function build(
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
  const nodeIds = new Set(nodes.map((n) => n.id))

  const allEdges: Edge[] = []
  // Flat view: parallel cables between a device pair collapse into one edge.
  const bundles = new Map<
    string,
    { source: string; target: string; cables: BundleMember[] }
  >()
  // Link aggregation: member cables of one bundle draw as ONE edge - the
  // logical link people think in - unless the view asks for every cable.
  const lagFold =
    !flat && opts.bundleLags !== false
      ? groupLagEdges(graph.edges)
      : { bundles: [], rest: graph.edges }
  for (const e of lagFold.rest) {
    if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) continue

    // Aggregated group-to-group edge (group_by mode): ×N cables, width
    // scaled gently by the bundle size.
    if (e.type === "group") {
      const info = e.data as unknown as GroupEdgeInfo
      const n = info?.cable_count ?? 1
      allEdges.push({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: "n",
        targetHandle: "n",
        type: "smoothstep",
        pathOptions: { borderRadius: 10 },
        label: `×${n}`,
        data: { sem: "groupedge", group: info, baseS: "n", baseT: "n" },
        style: { strokeWidth: Math.min(1 + Math.log2(n + 1) * 0.6, 3) },
        labelStyle: { fontSize: 9 },
        labelBgStyle: { fill: "var(--card)" },
      } as Edge)
      continue
    }

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

    // LLDP "ghost" link - SNMP-adjacent, no cable. Clicking offers to
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

    if (flat) {
      const key = [e.source, e.target].sort().join(">")
      let b = bundles.get(key)
      if (!b) {
        b = { source: e.source, target: e.target, cables: [] }
        bundles.set(key, b)
      }
      if (e.data) b.cables.push(e.data)
      continue
    }

    const via = e.data?.via ?? []
    const count = pairs.length
    const labelBits: string[] = []
    if (count > 1) labelBits.push(`×${count}`)
    if (via.length) labelBits.push(`via ${via.join(", ")}`)
    if (e.data?.cable_label) labelBits.push(e.data.cable_label)
    if (opts.colorMode === "speed" && e.data?.speed)
      labelBits.push(e.data.speed)

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
        ? { strokeWidth: 2.5, stroke: "var(--primary)" }
        : {
            strokeWidth: count > 1 ? 1.75 : 1.25,
            ...(stroke ? { stroke } : {}),
            ...(via.length ? { strokeDasharray: "10 4" } : {}),
          },
      labelStyle: { fontSize: 9 },
      labelBgStyle: { fill: "var(--card)" },
    } as Edge)
  }

  for (const b of lagFold.bundles) {
    const first = b.edges[0].data?.pairs?.[0]
    const cables = b.edges.map((e) => e.data).filter(Boolean) as BundleMember[]
    const strokes = new Set(cables.map((c) => edgeStroke(c, opts.colorMode) ?? ""))
    const stroke = strokes.size === 1 ? [...strokes][0] || undefined : undefined
    const marked = cables.some((c) => c.marked)
    allEdges.push({
      id: `lag:${b.key}`,
      source: b.source,
      target: b.target,
      ...(first?.a_port ? { sourceHandle: first.a_port } : {}),
      ...(first?.b_port ? { targetHandle: first.b_port } : {}),
      type: "smoothstep",
      pathOptions: { borderRadius: 10 },
      label: lagBundleLabel(b.lag, cables.length),
      animated: marked,
      data: { sem: "lagbundle", cables, lag: b.lag },
      style: marked
        ? { strokeWidth: 3, stroke: "var(--primary)" }
        : { strokeWidth: 2.5, ...(stroke ? { stroke } : {}) },
      labelStyle: { fontSize: 9, fontWeight: 600 },
      labelBgStyle: { fill: "var(--card)" },
    } as Edge)
  }

  if (flat) {
    for (const [key, b] of bundles) {
      const n = b.cables.length
      // A pair joined by ONE cable is that cable, not a bundle of one: it
      // carries the cable's real label, colours by its own data, gets the
      // full hover identity, and clicking it opens the cable panel rather
      // than a one-row bundle list.
      if (n === 1) {
        const c = b.cables[0]
        const stroke = edgeStroke(c, opts.colorMode)
        const bits: string[] = []
        if (c.via?.length) bits.push(`via ${c.via.join(", ")}`)
        if (c.cable_label) bits.push(c.cable_label)
        if (opts.colorMode === "speed" && c.speed) bits.push(c.speed)
        allEdges.push({
          id: `f:${key}`,
          source: b.source,
          target: b.target,
          sourceHandle: "n",
          targetHandle: "n",
          type: "smoothstep",
          pathOptions: { borderRadius: 10 },
          label: bits.length ? bits.join(" · ") : undefined,
          animated: c.marked,
          data: { sem: "cable", raw: c },
          style: c.marked
            ? { strokeWidth: 2.5, stroke: "var(--primary)" }
            : {
                strokeWidth: 1.25,
                ...(stroke ? { stroke } : {}),
                ...(c.via?.length ? { strokeDasharray: "10 4" } : {}),
              },
          labelStyle: { fontSize: 9 },
          labelBgStyle: { fill: "var(--card)" },
        } as Edge)
        continue
      }
      // The bundle keeps a colour only when every member agrees under the
      // active mode - a mixed bundle stays neutral rather than lying.
      const strokes = new Set(
        b.cables.map((c) => edgeStroke(c, opts.colorMode) ?? "")
      )
      const stroke =
        strokes.size === 1 ? [...strokes][0] || undefined : undefined
      // In speed mode a bundle that agrees announces the shared speed.
      const speeds = new Set(b.cables.map((c) => c.speed ?? ""))
      const speed =
        opts.colorMode === "speed" && speeds.size === 1
          ? [...speeds][0] || undefined
          : undefined
      allEdges.push({
        id: `f:${key}`,
        source: b.source,
        target: b.target,
        sourceHandle: "n",
        targetHandle: "n",
        type: "smoothstep",
        pathOptions: { borderRadius: 10 },
        label: (() => {
          const lag = sharedLag(b.cables)
          const base = lag ? lagBundleLabel(lag, n) : `×${n}`
          return speed ? `${base} · ${speed}` : base
        })(),
        data: { sem: "bundle", cables: b.cables },
        style: {
          strokeWidth: 1.75,
          ...(stroke ? { stroke } : {}),
        },
        labelStyle: { fontSize: 9 },
        labelBgStyle: { fill: "var(--card)" },
      } as Edge)
    }
  }

  // Orient hub → leaf: dagre ranks along edge direction, and the backend's
  // uuid-sorted endpoints put leaves on random sides of their switch. Making
  // the higher-degree device the source ranks cores before distribution
  // before access before servers - consistently one direction.
  {
    const deg = new Map<string, number>()
    for (const ed of allEdges) {
      deg.set(ed.source, (deg.get(ed.source) ?? 0) + 1)
      deg.set(ed.target, (deg.get(ed.target) ?? 0) + 1)
    }
    for (let i = 0; i < allEdges.length; i++) {
      const ed = allEdges[i]
      const sem = (ed.data as { sem?: string } | undefined)?.sem
      if (!ROUTABLE.has(sem ?? "")) continue
      if ((deg.get(ed.target) ?? 0) > (deg.get(ed.source) ?? 0)) {
        allEdges[i] = {
          ...ed,
          source: ed.target,
          target: ed.source,
          sourceHandle: ed.targetHandle,
          targetHandle: ed.sourceHandle,
        }
      }
    }
  }

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
    const groups = resolveLevels(opts.roleOrder, opts.roleBonds ?? [])
    const { rank, fallback: last } = roleTiers(
      graph.nodes
        .filter((n) => n.data.role && !n.data.role.is_patch_panel)
        .map((n) => n.data.role!.name),
      groups
    )
    levels = new Map()
    for (const n of graph.nodes) {
      // Patch panels aren't a device tier - leave them at their structural
      // position so they sit between the cables they join.
      if (n.data.role?.is_patch_panel) continue
      levels.set(n.id, rank.get(n.data.role?.name ?? "") ?? last)
    }
    // Cumulative main-axis offset per LEVEL. A level's gap comes from the
    // distance step of its FIRST role (bonded roles share the level, so they
    // share its gap - their own dots are hidden in the organiser to match).
    const base = opts.direction === "TB" ? 200 : 360
    const mult = [0.6, 0.8, 1, 1.4, 2] // 5 distance steps
    const gapOf = (role: string) => base * mult[opts.roleDistance?.[role] ?? 2]
    mainOffsets = [0]
    for (let i = 1; i <= last; i++)
      mainOffsets[i] = mainOffsets[i - 1] + gapOf(groups[i]?.[0] ?? "")
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
      opts.positions,
      dir,
      levels,
      mainOffsets,
      grouped ? groupSize : flatSize
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
        opts.positions,
        dir,
        levels,
        mainOffsets,
        (n) => ({
          width: flatWidth(n.data as FlatData),
          height: flatHeight(n.data as FlatData),
        })
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
  onSelectEdge?: (data: NonNullable<TopoEdge["data"]>, edgeId: string) => void
  /** Flat view: a bundled edge was clicked - its member cables. */
  onSelectBundle?: (cables: BundleMember[], edgeId: string) => void
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
  onPaneContext?: (x: number, y: number) => void
  onGhostEdge?: (ghost: GhostEdgeData) => void
  onCanvasClick?: () => void
  /** Fired after a node drag settles - the parent can persist positions(). */
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
    bundleLags = true,
    nodeStyle = "stencil",
    positions,
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

  // Aligned hierarchy cables are already near-straight; flat draws floating
  // point-to-point beziers - neither re-routes orthogonally.
  const routingActive =
    edgeRouting === "routed" &&
    nodeStyle !== "hierarchy" &&
    nodeStyle !== "flat"

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
        nodeStyle,
        bundleLags,
        // Positions pin whenever the parent supplies them. A deliberate
        // relayout CLEARS them at the source (the page sets positions to
        // undefined before bumping layoutTick) - gating on the tick here
        // instead made every drag AFTER a relayout snap straight back.
        positions,
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
      nodeStyle,
      bundleLags,
      positions,
      layoutTick,
      matchedIds,
      hiddenPorts,
      originId,
    ]
  )

  const [nodes, setNodes, onNodesChange] = useNodesState(built.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(built.edges)
  // Zoom level-of-detail: far out, edge labels (and further out, port text)
  // hide via CSS keyed on the wrapper's data-lod - pure paint, no re-layout,
  // so a big graph reads as clean boxes-and-lines until you zoom in.
  const [lod, setLod] = useState(0)
  const onMove = useCallback((_: unknown, vp: { zoom: number }) => {
    // Cable labels are the map's most useful text - they stay until the
    // graph is genuinely too small to read, not at the zoom a fitted
    // fabric happens to land on.
    const next = vp.zoom < 0.2 ? 2 : vp.zoom < 0.32 ? 1 : 0
    setLod((cur) => (cur === next ? cur : next))
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
  // Cursor tooltip naming the hovered cable - follows the mouse, so on a
  // long cable it can never sit off-screen the way a midpoint label does.
  // Position updates go straight to the DOM (no re-render per mousemove).
  const [tip, setTip] = useState<string | null>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const moveTip = useCallback((ev: { clientX: number; clientY: number }) => {
    const el = tipRef.current
    if (!el) return
    el.style.left = `${ev.clientX + 14}px`
    el.style.top = `${ev.clientY + 14}px`
  }, [])
  // The spotlight card's direct neighbours - everything else fades.
  const spotSet = useMemo(() => {
    if (!spotId) return null
    const keep = new Set([spotId])
    for (const e of edges) {
      if (e.source === spotId) keep.add(e.target)
      if (e.target === spotId) keep.add(e.source)
    }
    return keep
  }, [edges, spotId])
  const shownEdges = useMemo(() => {
    if (!hotEdge && !selectedEdgeId && !spotSet) return edges
    return edges.map((e) => {
      const isHot = e.id === hotEdge
      const isSel = e.id === selectedEdgeId
      if (isHot || isSel)
        return {
          ...e,
          // The hot edge keeps its label at any LOD (CSS exempts .topo-hot).
          className: isHot ? "topo-hot" : e.className,
          zIndex: 1000,
          style: {
            ...e.style,
            strokeWidth: 2.5,
            opacity: 1,
            ...(isSel ? { stroke: "var(--primary)" } : {}),
          },
        }
      const offSpot = spotSet && e.source !== spotId && e.target !== spotId
      return hotEdge || offSpot
        ? {
            ...e,
            style: { ...e.style, opacity: 0.15 },
            labelStyle: { ...e.labelStyle, opacity: 0.2 },
          }
        : e
    })
  }, [edges, hotEdge, selectedEdgeId, spotSet, spotId])
  const shownNodes = useMemo(() => {
    if (!spotSet) return nodes
    return nodes.map((n) =>
      spotSet.has(n.id) || n.type === "sitegroup"
        ? n
        : { ...n, data: { ...n.data, dimmed: true } }
    )
  }, [nodes, spotSet])
  // Re-sync when the built graph changes, but keep user-dragged positions
  // for nodes that are still present (so a color-mode flip doesn't shuffle).
  const prevNodes = useRef<Node[]>([])
  const prevTick = useRef(layoutTick)
  const prevStyle = useRef(nodeStyle)
  const prevDirection = useRef(direction)
  const prevFitKey = useRef(fitKey)
  useEffect(() => {
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
    const restyled = nodeStyle !== prevStyle.current
    prevStyle.current = nodeStyle
    const requeried = fitKey !== prevFitKey.current
    prevFitKey.current = fitKey
    const redirected = direction !== prevDirection.current
    prevDirection.current = direction
    const relaidOut =
      layoutTick !== prevTick.current || restyled || requeried || redirected
    prevTick.current = layoutTick
    // A new layout is a new map - a stale spotlight would dim everything
    // with no visible cause.
    if (relaidOut) setSpotId(null)
    const keepingDrags =
      !relaidOut && !positions && prevNodes.current.length > 0
    const nextNodes = built.nodes.map((n) => {
      const kept = prev.get(n.id)
      return kept && keepingDrags ? { ...n, position: kept } : n
    })
    setNodes(nextNodes)
    // When we kept dragged positions, `built.edges` were routed for the
    // layout's positions, not the kept ones - re-route from the actual
    // rendered positions so cables always match their cards.
    if (routingActive && keepingDrags) {
      const wp = edgeWaypoints(nextNodes, built.edges, direction)
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
    // reads as a frozen/blank map on big graphs.
    if (relaidOut)
      requestAnimationFrame(() =>
        flow.fitView({ padding: 0.15, duration: 300 })
      )
  }, [
    built,
    setNodes,
    setEdges,
    layoutTick,
    positions,
    direction,
    routingActive,
    flow,
    fitKey,
    nodeStyle,
  ])
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
      exportPng: async (viewportOnly = false) => {
        const el = wrapper.current?.querySelector<HTMLElement>(
          ".react-flow__viewport"
        )
        if (!el) return null
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
        }
      },
    }),
    [flow, theme]
  )

  const onNodeClick = useCallback(
    (_: unknown, node: Node) => {
      if (node.type === "sitegroup")
        onSelectGroup?.(node.data as unknown as TopoGroupData)
      else {
        setSpotId(node.id)
        onSelectNode?.(node.data as TopologyGraph["nodes"][number]["data"])
      }
    },
    [onSelectNode, onSelectGroup]
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
            raw?: TopoEdge["data"]
            cables?: BundleMember[]
            group?: GroupEdgeInfo
          }
        | undefined
      if (data?.sem === "ghost" && data.ghost) onGhostEdge?.(data.ghost)
      else if (
        (data?.sem === "bundle" || data?.sem === "lagbundle") &&
        data.cables
      )
        onSelectBundle?.(data.cables, edge.id)
      else if (data?.sem === "groupedge" && data.group)
        onSelectGroupEdge?.(data.group, edge.id)
      else if (data?.raw) onSelectEdge?.(data.raw, edge.id)
    },
    [onGhostEdge, onSelectEdge, onSelectBundle, onSelectGroupEdge]
  )

  // Dragging a card changes which side of it faces each neighbour - re-snap
  // the edges, and RE-ROUTE the cables from the new positions (so moving a
  // node re-bends its cables around cards instead of leaving them straight).
  const onNodeDragStop = useCallback(() => {
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
      const wp = edgeWaypoints(liveNodes, next, direction)
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
  }, [flow, setEdges, setNodes, direction, routingActive, onDragEnd, nodeStyle])

  if (!mounted)
    return <div className="h-full w-full animate-pulse bg-muted/30" />
  if (graph.nodes.length === 0)
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Nothing to map yet - cable some devices first.
      </div>
    )

  return (
    <div ref={wrapper} className="h-full w-full" data-lod={lod}>
      <ReactFlow
        nodes={shownNodes}
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
        onNodeDoubleClick={onNodeDoubleClick}
        zoomOnDoubleClick={!onOpenDevice}
        onNodeContextMenu={(ev, node) => {
          ev.preventDefault()
          onNodeContext?.(node, ev.clientX, ev.clientY)
        }}
        onPaneContextMenu={(ev) => {
          ev.preventDefault()
          onPaneContext?.(ev.clientX, ev.clientY)
        }}
        onNodeDragStop={onNodeDragStop}
        onEdgeClick={onEdgeClick}
        onEdgeMouseEnter={(ev, e) => {
          setHotEdge(e.id)
          setTip(
            hoverLabel(e) ?? (typeof e.label === "string" ? e.label : null)
          )
          moveTip(ev)
        }}
        onEdgeMouseMove={(ev) => moveTip(ev)}
        onEdgeMouseLeave={() => {
          setHotEdge(null)
          setTip(null)
        }}
        onPaneClick={() => {
          setSpotId(null)
          onCanvasClick?.()
        }}
        onMove={onMove}
        onlyRenderVisibleElements
        minZoom={0.05}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
        {tip && (
          <div
            ref={tipRef}
            className="pointer-events-none fixed z-[1100] max-w-96 rounded-md border border-border bg-popover px-2 py-1 font-mono text-[11px] text-popover-foreground shadow-md"
          >
            {tip}
          </div>
        )}
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
