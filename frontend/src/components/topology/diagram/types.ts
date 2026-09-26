import type {
  TopoEdge,
  TopologyDiagramDisplay,
  TopologyLineType,
} from "@/lib/api"
import type { Weight } from "@/lib/diagram/measure"
import type { EdgeSem } from "../edge-style"
import type { BundleMember } from "../edge-semantics"
import type { EdgeLag } from "../lag-bundles"

// The Diagram tab's shared vocabulary: what the pure layout core (card
// fields, card layout, anchors, link geometry) hands the renderers and the
// exporters. Coordinates are flow px; y grows downwards.

/** How a link is drawn between its two anchors. */
export type LineType = TopologyLineType

/** Simple: compact cards, every line on a side meets at its midpoint.
 * Detailed: one nub per cabled interface, the card grows to fit them. */
export type DiagramMode = TopologyDiagramDisplay["mode"]

/** The view's diagram settings (`state.filters.diagram`). */
export type DiagramOpts = TopologyDiagramDisplay

/** A card side: top, right, bottom, left. */
export type Side = "T" | "R" | "B" | "L"

export interface Pt {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** A unit vector - the outward normal of a side. */
export type Dir = readonly [number, number]

/** A count per side: nubs a card has to fit, or has room for. */
export type SideCount = Record<Side, number>

/**
 * Where a link end attaches to its node.
 * - `side`: `off` px along the side from its start (the left end of T/B,
 *   the top end of L/R). `port` names the interface; `id` its handle id.
 * - `point`: a photo marker centre as fractions of the image, leaving
 *   through the top or bottom edge.
 */
export type Anchor =
  | { k: "side"; side: Side; off: number; port?: string; id?: string }
  | { k: "point"; fx: number; fy: number; exit: "T" | "B"; port: string }

/** A link end resolved to flow coordinates: the point the line starts
 * from and the direction it leaves in. */
export interface End {
  x: number
  y: number
  dir: Dir
}

/** One line of text placed on a card, card-relative. */
export interface PlacedText {
  /** Already cut to fit, with an ellipsis. */
  text: string
  size: number
  weight: Weight
  /** The anchor x: the centre for `middle`. */
  x: number
  /** The baseline. */
  y: number
  /** The top of the line box; the card DOM stacks rows by it. */
  top: number
  /** The line box height. */
  lh: number
  anchor: "start" | "middle" | "end"
  /** Measured width of `text`. */
  w: number
}

/** A link's drawn path, from the shared geometry. */
export interface Route {
  kind: LineType
  /** Terminals plus interior points, as draw.io stores them: elbow
   * corners, or the control points of a curved (bendy) line. */
  pts: Pt[]
  /** SVG path data. */
  d: string
  /** Arc length of the drawn path. */
  length: number
  /** The point `t` (0..1) of the way along the drawn path, and the
   * direction of travel there in degrees (0 = right, 90 = down). */
  at: (t: number) => { x: number; y: number; angle: number }
}

/** Labels a link carries: middle chip lines and per-end port / address. */
export interface LinkLabels {
  mid?: string[]
  a?: { port?: string; ip?: string }
  b?: { port?: string; ip?: string }
}

/**
 * A Diagram link edge's data. `a`/`b` are oriented after the hub→leaf
 * flip. They hold one anchor per cable end: exactly one in Simple, and in
 * Detailed one per cabled member interface (a LAG's members each leave
 * their own nub), in the bundle's order.
 */
export type LinkData = {
  sem: EdgeSem
  raw?: TopoEdge["data"]
  cables?: BundleMember[]
  lag?: EdgeLag
  /** The sorted device pair, `"<uuidA>|<uuidB>"` - the per-link override
   * key in a saved view. */
  pairKey: string
  line: LineType
  a: Anchor[]
  b: Anchor[]
  /** Cyclical: the side the arc bulges to and its height. */
  arc?: { flip: 1 | -1; h: number }
  /** Elbow: the node-avoiding channel from the layout. */
  wp?: Pt[]
  labels: LinkLabels
  /** Where the middle label sits along the route, 0..1. */
  midT?: number
  /** No free spot for the middle label: shown on hover only. */
  crowded?: boolean
}

/** The per-link override key: the two device ids, sorted, joined by "|". */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}
