import type {
  CheckStatus,
  TopoEdge,
  TopoNode,
  TopologyDiagramDisplay,
  TopologyLineType,
} from "@/lib/api"
import type { PortPlace } from "@/lib/diagram/geometry"
import type { Weight } from "@/lib/diagram/measure"
import type { EdgeSem } from "../edge-style"
import type { BundleMember } from "../edge-semantics"
import type { EdgeLag } from "../lag-bundles"
import type { Nub } from "./anchors"
import type { CardBox } from "./card-layout"

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
 * - `junction`: a breakout's split point (the centre of its junction
 *   node), leaving along `dir` - the trunk's direction for the legs, back
 *   towards the trunk's card for the trunk.
 */
export type Anchor =
  | { k: "side"; side: Side; off: number; port?: string; id?: string }
  | { k: "point"; fx: number; fy: number; exit: "T" | "B"; port: string }
  | { k: "junction"; dir: Dir }

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

/** A payload cable pair, with the cable end (A/B) each side is terminated
 * on - `a_end`/`b_end`, oriented like the rest of the pair. */
export type CablePair = NonNullable<
  NonNullable<TopoEdge["data"]>["pairs"]
>[number] & {
  a_end?: "A" | "B" | null
  b_end?: "A" | "B" | null
}

/** One cable's end addresses (`link-labels.ts`): the full address each end
 * has in the link subnets the two ends share, IPv4 first. */
export interface EndAddresses {
  a?: string[]
  b?: string[]
}

/** Labels a link carries (the view's Labels setting): middle chip lines -
 * a bundle's count, then the shared subnets - and each cable's end
 * addresses. */
export interface LinkLabels {
  mid?: string[]
  /** Per cable, in `a`/`b` anchor order. */
  ends?: EndAddresses[]
  /** Port names are switched off: no names along the cables. */
  noPorts?: boolean
}

/** One cable's planned drawing (`plan.ts`): its route and where its end
 * labels went. */
export interface CablePlan {
  /** Terminals included: an elbow's corners, a curve's control points, a
   * straight line's ends. */
  pts: Pt[]
  /** The port name on the line at each end; null = no room, left off. */
  a?: PortPlace | null
  b?: PortPlace | null
  /** Each end's addresses (`labels.ends`) on the line after its port
   * name, one place per address; null = no room, left off. */
  ips?: { a?: PortPlace[] | null; b?: PortPlace[] | null }
}

/** Which part of a breakout cable an edge draws: the trunk from the
 * shared port to the junction, or one leg on to a far port. */
export interface FanPart {
  role: "trunk" | "leg"
  /** The junction node the part ends (trunk) or starts (leg) at. */
  junction: string
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
  /** Cyclical: how the arc was asked for. `always`: the link's own line
   * (an arc wherever it runs); else the view's default (an arc only where
   * a line would cross a card, bendy elsewhere). `flip`: the side a saved
   * override pins it to. */
  arcAsk?: { always: boolean; flip?: 1 | -1 }
  /** Drawn as an arc: the side it bulges to (-1 above or left of the
   * cards, 1 below or right) and the height of its apex line past the
   * outer of its two ends, px (0 until planned). */
  arc?: { flip: 1 | -1; h: number }
  labels: LinkLabels
  /** Where the middle label sits along the route, 0..1… */
  midT?: number
  /** …and how far beside the line, px (0 or absent = on it). */
  midOff?: number
  /** No free spot for the middle label: shown on hover only. */
  crowded?: boolean
  /** The cable a breakout part belongs to: its trunk and legs hover and
   * select together. */
  cableId?: string
  fan?: FanPart
  /** Each cable's planned route and port names, for the boxes in
   * `planAt`. */
  plan?: CablePlan[]
}

/** A Diagram edge's data as the canvas holds it: the link plus what the
 * renderer needs that the pure core does not. */
export type DiagramEdgeData = LinkData & {
  /** Anchors are side midpoints, recomputed from the live boxes while a
   * card is dragged: Simple mode, LLDP ghosts and grouped-map links. */
  simple?: boolean
  /** The top-left of the source and target boxes `plan` was made for. A
   * card dragged away from there draws the unplanned line until the drop
   * plans it again. */
  planAt?: [number, number, number, number]
  /** LLDP ghost: the adjacency, for the materialise dialog. */
  ghost?: TopoEdge["data"]
  /** BGP overlay: the sessions between the pair. */
  bgp?: TopoEdge["data"]
  /** Grouped map: the aggregated group edge. */
  group?: unknown
  /** Hovered or selected: labels show at every zoom. */
  hot?: boolean
  /** Both ends share a role: the layout may keep them on one tier. */
  peer?: boolean
}

/** A Diagram card's data: the payload node plus its laid-out box. */
export type DiagramCardData = TopoNode["data"] & {
  /** Search miss or outside the spotlight. */
  dimmed?: boolean
  /** The device's monitoring state, merged in outside the build so a
   * refresh never re-lays the map out. */
  monitor?: CheckStatus | null
  diagram: {
    box: CardBox
    /** Detailed mode: one per cabled interface, in order along each side. */
    nubs: Nub[]
    mode: DiagramMode
  }
}

/** A Diagram link as its panel sees it: the saved view's override key
 * (the sorted device pair) and, when it draws as an arc, the side it
 * bulges to. */
export interface DiagramLinkRef {
  pairKey: string
  arc?: 1 | -1
}

/** The per-link override key: the two device ids, sorted, joined by "|". */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}
