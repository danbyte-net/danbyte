import type { ComponentType } from "react"
import type { Node, NodeProps, NodeTypes } from "@xyflow/react"

import { GROUP_H, GROUP_W, GroupNode } from "./group-node"
import { HierarchyNode } from "./hierarchy-node"
import { hierHead, hierHeight, hierarchyWidth } from "./layout"
import { PortNode, portSize } from "./port-node"
import type { PortData } from "./port-node"
import { ZoneNode } from "./zone-node"
import { AnnotationNode } from "./diagram/annotation-node"
import { BandNode } from "./diagram/band-node"
import { CardNode } from "./diagram/card-node"
import { JUNCTION } from "./diagram/card-layout"
import { JunctionNode } from "./diagram/junction-node"
import type { DiagramCardData } from "./diagram/types"

// Every node kind the topology canvas renders: its component and the box it
// occupies. The layout takes `sizeOf` as a parameter instead of importing
// the node files, so a new kind registers here and nowhere else.

export interface NodeSize {
  width: number
  height: number
}

export interface NodeKind {
  component: ComponentType<NodeProps>
  /** The rendered box the layout reserves. Kinds without one (zones, bands,
   * notes: never laid out) are reserved `PLAIN`. */
  size?: (n: Node) => NodeSize
}

/** The box of a node with no size of its own. */
export const PLAIN: NodeSize = { width: 156, height: 46 }

const portBox = (n: Node): NodeSize => portSize(n.data as unknown as PortData)

export const NODE_KINDS = {
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
      return {
        width: hierarchyWidth(d),
        height: hierHeight(d.portSpan ?? 0, hierHead(d)),
      }
    },
  },
  // The Diagram tab's card: its box is laid out in code (card-layout.ts).
  card: {
    component: CardNode,
    size: (n: Node) => {
      const box = (n.data as Partial<DiagramCardData>).diagram?.box
      return box ? { width: box.w, height: box.h } : PLAIN
    },
  },
  // Where a breakout cable splits (diagram/fanout.ts).
  junction: {
    component: JunctionNode,
    size: () => ({ width: JUNCTION.w, height: JUNCTION.h }),
  },
  // A port-level trace graph's ports (port-node.tsx).
  interface: { component: PortNode, size: portBox },
  front_port: { component: PortNode, size: portBox },
  rear_port: { component: PortNode, size: portBox },
  zone: { component: ZoneNode },
  // A Diagram layer band (diagram/bands.ts): a region, never laid out.
  band: { component: BandNode },
  // A Diagram note (diagram/notes.ts): over the map, never laid out.
  note: { component: AnnotationNode },
} satisfies Record<string, NodeKind>

// Defined once, at module level (re-creating nodeTypes each render
// re-mounts every node - a classic React Flow footgun).
export const nodeTypes: NodeTypes = Object.fromEntries(
  Object.entries(NODE_KINDS).map(([type, kind]) => [type, kind.component])
)

/** The box a node renders at - what the layout reserves and routes around. */
export function sizeOf(n: Node): NodeSize {
  const kind = (NODE_KINDS as Record<string, NodeKind | undefined>)[
    n.type ?? ""
  ]
  return kind?.size?.(n) ?? PLAIN
}
