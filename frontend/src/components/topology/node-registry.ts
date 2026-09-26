import type { ComponentType } from "react"
import type { Node, NodeProps, NodeTypes } from "@xyflow/react"

import { FlatNode, flatHeight, flatWidth } from "./flat-node"
import { GROUP_H, GROUP_W, GroupNode } from "./group-node"
import { HierarchyNode } from "./hierarchy-node"
import { hierHeight, hierarchyWidth } from "./layout"
import { PortNode, StencilNode, stencilSize } from "./stencil-node"
import type { StencilData } from "./stencil-node"
import { ZoneNode } from "./zone-node"

// Every node kind the topology canvas renders: its component and the box it
// occupies. The layout takes `sizeOf` as a parameter instead of importing
// the node files, so a new kind registers here and nowhere else.

export interface NodeSize {
  width: number
  height: number
}

export interface NodeKind {
  component: ComponentType<NodeProps>
  /** The rendered box the layout reserves. Kinds without one (trace-map
   * ports, zones) are reserved a stencil card's box. */
  size?: (n: Node) => NodeSize
}

const stencilBox = (n: Node): NodeSize => stencilSize(n.data as StencilData)

export const NODE_KINDS = {
  device: { component: StencilNode, size: stencilBox },
  flat: {
    component: FlatNode,
    size: (n: Node) => ({
      width: flatWidth(n.data),
      height: flatHeight(n.data),
    }),
  },
  // "sitegroup", not "group": React Flow reserves "group" and paints its own
  // grey stock box behind it.
  sitegroup: {
    component: GroupNode,
    size: () => ({ width: GROUP_W, height: GROUP_H }),
  },
  hier: {
    component: HierarchyNode,
    size: (n: Node) => {
      const d = n.data as { name?: string; portSpan?: number }
      return { width: hierarchyWidth(d), height: hierHeight(d.portSpan ?? 0) }
    },
  },
  interface: { component: PortNode },
  front_port: { component: PortNode },
  rear_port: { component: PortNode },
  zone: { component: ZoneNode },
} satisfies Record<string, NodeKind>

// Defined once, at module level (re-creating nodeTypes each render
// re-mounts every node - a classic React Flow footgun).
export const nodeTypes: NodeTypes = Object.fromEntries(
  Object.entries(NODE_KINDS).map(([type, kind]) => [type, kind.component])
)

/** The box a node renders at - what the layout reserves and routes around. */
export function sizeOf(n: Node): NodeSize {
  const kind = (NODE_KINDS as Record<string, NodeKind | undefined>)[
    n.type ?? "device"
  ]
  return (kind?.size ?? stencilBox)(n)
}
