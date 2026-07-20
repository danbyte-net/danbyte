import "@xyflow/react/dist/style.css"
import { useMemo } from "react"
import { useNavigate } from "@tanstack/react-router"
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
} from "@xyflow/react"
import type { Edge, Node, NodeProps } from "@xyflow/react"

import type { Tunnel, TunnelTermination } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { useTheme } from "@/components/theme-provider"

// Card geometry — the layout math needs the DOM size, like the stencil nodes.
const CARD_W = 190
const CARD_H = 58

type EndData = {
  /** Device or VM name. */
  endpoint: string
  interfaceName: string
  outsideIp: string | null
  roleDisplay: string
  hub: boolean
  term: TunnelTermination
}

/** Both handles sit at the card's centre (hidden), so the straight tunnel
 * edges radiate from centre to centre and stay tucked behind the cards —
 * a spoke connects cleanly whichever side of the hub it lands on. */
const CENTER_HANDLE: React.CSSProperties = {
  top: "50%",
  left: "50%",
  transform: "translate(-50%,-50%)",
  opacity: 0,
  pointerEvents: "none",
}

/** One tunnel end — endpoint (device/VM), interface, outside IP, role. */
function TunnelEndNode({ data, selected }: NodeProps) {
  const d = data as EndData
  return (
    <div
      className={`cursor-pointer rounded-md border bg-card px-2.5 py-1.5 ${
        selected ? "border-primary ring-2 ring-primary/30" : "border-border"
      }`}
      style={{ width: CARD_W, minHeight: CARD_H }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-mono text-[11px] font-medium">
          {d.endpoint}
        </span>
        <Badge
          variant="secondary"
          className={`h-4 shrink-0 px-1 text-[9px] uppercase ${
            d.hub ? "font-semibold" : ""
          }`}
        >
          {d.roleDisplay}
        </Badge>
      </div>
      <div className="truncate font-mono text-[10px] text-muted-foreground">
        {d.interfaceName}
      </div>
      <div className="truncate font-mono text-[10px] text-muted-foreground">
        {d.outsideIp ?? "—"}
      </div>
      <Handle type="target" position={Position.Top} style={CENTER_HANDLE} />
      <Handle type="source" position={Position.Top} style={CENTER_HANDLE} />
    </div>
  )
}

// Defined once — re-creating nodeTypes each render re-mounts every node.
const nodeTypes = { tunnelEnd: TunnelEndNode }

function toNode(t: TunnelTermination, cx: number, cy: number): Node {
  const endpoint = t.interface?.device.name ?? t.vm_interface?.vm.name ?? "—"
  const interfaceName = t.interface?.name ?? t.vm_interface?.name ?? "—"
  return {
    id: t.id,
    type: "tunnelEnd",
    position: { x: cx - CARD_W / 2, y: cy - CARD_H / 2 },
    draggable: false,
    connectable: false,
    data: {
      endpoint,
      interfaceName,
      outsideIp: t.outside_ip?.ip_address ?? null,
      roleDisplay: t.role_display,
      hub: t.role === "hub",
      term: t,
    } satisfies EndData,
  }
}

const EDGE_STYLE: React.CSSProperties = {
  strokeWidth: 1.5,
  stroke: "var(--muted-foreground)",
  strokeDasharray: "6 4",
  opacity: 0.7,
}

function link(a: Node, b: Node): Edge {
  return {
    id: `${a.id}>${b.id}`,
    source: a.id,
    target: b.id,
    type: "straight",
    selectable: false,
    focusable: false,
    style: EDGE_STYLE,
  }
}

/** Radius so radially-placed cards don't overlap: enough circumference for
 * one card-plus-gap per node, floored for small counts. */
function radiusFor(count: number): number {
  return Math.max(240, Math.ceil((count * (CARD_W + 50)) / (2 * Math.PI)))
}

/**
 * Role-driven layout. Hub-and-spoke: hub(s) stacked in the centre, every
 * other end on a ring around them, one edge per hub↔end (hubs also chain to
 * each other). No hubs (point-to-point / mesh of peers): two ends sit side by
 * side; more form a ring, fully meshed peer↔peer.
 */
function buildGraph(terminations: TunnelTermination[]): {
  nodes: Node[]
  edges: Edge[]
} {
  const hubs = terminations.filter((t) => t.role === "hub")
  const rest = terminations.filter((t) => t.role !== "hub")
  const nodes: Node[] = []
  const edges: Edge[] = []

  if (hubs.length > 0 && rest.length > 0) {
    const hubNodes = hubs.map((h, i) =>
      toNode(h, 0, i * (CARD_H + 40) - ((hubs.length - 1) * (CARD_H + 40)) / 2)
    )
    const r = radiusFor(rest.length)
    const restNodes = rest.map((s, i) => {
      const angle = (2 * Math.PI * i) / rest.length - Math.PI / 2
      return toNode(s, r * Math.cos(angle), r * Math.sin(angle))
    })
    nodes.push(...hubNodes, ...restNodes)
    for (const h of hubNodes) for (const s of restNodes) edges.push(link(h, s))
    for (let i = 1; i < hubNodes.length; i++)
      edges.push(link(hubNodes[i - 1], hubNodes[i]))
    return { nodes, edges }
  }

  // No hub/spoke split — peers (or hubs-only / spokes-only, drawn the same).
  if (terminations.length <= 2) {
    const n = terminations.length
    terminations.forEach((t, i) =>
      nodes.push(toNode(t, (i - (n - 1) / 2) * (CARD_W + 140), 0))
    )
  } else {
    const r = radiusFor(terminations.length)
    terminations.forEach((t, i) => {
      const angle = (2 * Math.PI * i) / terminations.length - Math.PI / 2
      nodes.push(toNode(t, r * Math.cos(angle), r * Math.sin(angle)))
    })
  }
  for (let i = 0; i < nodes.length; i++)
    for (let j = i + 1; j < nodes.length; j++)
      edges.push(link(nodes[i], nodes[j]))
  return { nodes, edges }
}

/**
 * Read-only topology map of one tunnel: its terminations as cards, laid out
 * by role — hub(s) central with the spokes on a ring, or peers side by side.
 * Clicking a card jumps to the terminating interface (or the VM). Lazy-load
 * this (like the topology canvas) so React Flow stays out of the main bundle.
 */
export function TunnelMap({ tunnel }: { tunnel: Tunnel }) {
  const { theme } = useTheme()
  const navigate = useNavigate()
  const { nodes, edges } = useMemo(
    () => buildGraph(tunnel.terminations),
    [tunnel.terminations]
  )

  if (tunnel.terminations.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        No terminations on this tunnel yet — add its ends on the Terminations
        tab to draw the map.
      </p>
    )

  return (
    <div className="h-96 overflow-hidden rounded-lg border border-border bg-card">
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.25, maxZoom: 1.2 }}
          colorMode={theme}
          proOptions={{ hideAttribution: true }}
          nodesConnectable={false}
          nodesDraggable={false}
          minZoom={0.2}
          maxZoom={1.5}
          onNodeClick={(_, node) => {
            const t = (node.data as EndData).term
            if (t.interface)
              navigate({
                to: "/interfaces/$id",
                params: { id: t.interface.id },
              })
            else if (t.vm_interface)
              navigate({
                to: "/virtual-machines/$id",
                params: { id: t.vm_interface.vm.id },
              })
          }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  )
}
