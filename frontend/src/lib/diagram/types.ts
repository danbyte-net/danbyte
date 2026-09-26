// The diagram export model: one fully resolved, light-theme description of a
// diagram that every writer (SVG, PNG, draw.io, the PDF sheet) serialises.
//
// Builders fill it from the diagram's data and live positions - never from
// the DOM, which holds only what is on screen. Coordinates are absolute
// diagram pixels, colours are solid hex (no CSS variables, no alpha), and
// transient screen state (selection, dimming, search, level of detail) never
// reaches it. Writers only draw: they never decide what is shown.

export type Pt = { x: number; y: number }
export type Rect = { x: number; y: number; w: number; h: number }

/** A card side, spelled like React Flow's `Position` values. */
export type Side = "top" | "right" | "bottom" | "left"

/** How a link is routed. Mirrors `TopologyLineType`. */
export type LineKind = "straight" | "elbow" | "bendy" | "cyclical"

/** What a link stands for: one cable, a folded bundle (LAG or parallel
 * cables), an LLDP neighbour without a cable, or a BGP session. */
export type LinkSem = "cable" | "bundle" | "ghost" | "bgp"

/** The one pill a card may carry: monitoring state (down or degraded) or the
 * lifecycle status. Monitoring wins; the builder picks. */
export interface DiagramPill {
  kind: "monitor" | "status"
  text: string
  fill: string
  ink: string
}

/** A Detailed-mode interface tab on the card edge facing the far end. */
export interface DiagramNub extends Rect {
  side: Side
  /** The interface it stands for. Metadata (draw.io port cells, tooltips):
   * the drawn port name is the link's end label. */
  label?: string
}

/** A cabled port's box on a device photo, in diagram coordinates. */
export interface DiagramMarker extends Rect {
  port: string
}

export interface DiagramPhoto extends Rect {
  /** An image URL, or a `data:` URI once inlined (the PNG and PDF paths
   * need that - an SVG drawn as an image loads nothing external). */
  href: string
  markers: DiagramMarker[]
}

/** A card's resolved text positions (`cardLayout` on the canvas). */
export interface DiagramPlace {
  title: Pt
  lines: Pt[]
  pill?: Rect
}

export interface DiagramNode extends Rect {
  /** Stable and unique in the document, e.g. `dev:<uuid>`. */
  id: string
  /** A card, or a device photo with its name as a caption underneath. */
  kind: "card" | "photo"
  /** Card fill: the role colour, or the neutral card colour. */
  fill: string
  /** Text colour on the fill - `readableText(fill)`. */
  ink: string
  /** The device name. */
  title: string
  /** Card lines, values only, in order (IP, loopback, serial…). */
  lines: string[]
  pill?: DiagramPill
  /** Detailed mode only; absent or empty in Simple. */
  nubs?: DiagramNub[]
  /** `kind: "photo"`: the image box inside the node box. */
  photo?: DiagramPhoto
  /** Where the canvas card layout put the text: baselines (centre x) and
   * the pill box, absolute, with `title`, `lines` and the pill text already
   * cut to fit. Absent = the writer lays the card out by the same rule. */
  place?: DiagramPlace
  /** Absolute link back to the object in Danbyte. */
  link?: string
}

/** One end of a link. `x/y` is where the line attaches: the nub's outer
 * edge in Detailed, the side midpoint in Simple, a marker on a photo. */
export interface DiagramEnd extends Pt {
  node: string
  side?: Side
  /** Index into the node's `nubs` the line leaves from. */
  nub?: number
}

/** A label at one end of a link. */
export interface DiagramEndLabel {
  text: string
  /** Run the text along the line, turned to stay upright (Detailed port
   * names). Absent = horizontal, a little way along the route (Simple). */
  rotate?: boolean
  /** A rotated label's box centre and turn, as the builder placed it clear
   * of other cables and labels (`portPlace`). Absent = placed by the same
   * rule from the route alone. */
  at?: { x: number; y: number; rotate: number }
}

export interface DiagramLink {
  id: string
  kind: LineKind
  sem: LinkSem
  source: DiagramEnd
  target: DiagramEnd
  /** Interior points, terminals excluded, with draw.io semantics: elbow =
   * the polyline's corners; bendy and cyclical = the control points of
   * mxGraph's curved rule (`M S, Q P1 mid(P1,P2), …, Q Pn T`); straight =
   * none (or plain waypoints). */
  points: Pt[]
  stroke: string
  width: number
  /** SVG dash array in px, e.g. `"6 4"`. */
  dash?: string
  labels: {
    /** Stacked at the middle of the route, e.g. `["2x Po1", "10.1.0.0/31"]`. */
    mid?: string[]
    /** Where the middle label sits along the route, 0..1 (0.5 when
     * absent): moved off the middle when a card or label is in the way… */
    midAt?: number
    /** …and how far beside the line, px, to the right hand of travel
     * (absent = on it). */
    midOff?: number
    /** The source end. */
    a?: DiagramEndLabel
    /** The target end. */
    b?: DiagramEndLabel
  }
  link?: string
  /** The cable this line is part of - a breakout's trunk and legs share
   * it. */
  cable?: string
}

/** Where a breakout cable splits: its trunk ends here and each leg leaves
 * from here. A dot in the cable's colour, not a status. */
export interface DiagramJunction extends Pt {
  /** Stable and unique in the document, e.g. `fan:<cable uuid>`. */
  id: string
  r: number
  fill: string
  cable?: string
  link?: string
}

/** A labelled region behind the cards. Rows and columns are the diagram's
 * bands (`orient` h / v); a zone is the older annotation box. */
export interface DiagramBand extends Rect {
  id: string
  kind: "row" | "column" | "zone"
  orient: "h" | "v"
  label: string
  /** One of the zone swatches; absent or null = neutral. */
  fill?: string | null
}

export type NoteIcon = "cloud" | "globe" | "building"

/** A free-text annotation, optionally with a Lucide icon marker. `x/y` is
 * the top-left corner. */
export interface DiagramNote extends Pt {
  id: string
  text?: string
  icon?: NoteIcon
}

/** One legend entry: a role swatch, a pill, or a line style. */
export interface LegendRow {
  kind: "role" | "pill" | "line"
  label: string
  fill?: string
  ink?: string
  stroke?: string
  width?: number
  dash?: string
}

export interface DiagramMeta {
  /** The view's name, or a generic title for an unsaved map. */
  title: string
  tenant?: string
  /** ISO timestamp, injected by the caller (fixed in tests). */
  generated_at: string
  /** A one-line summary of the map's filters. */
  filters?: string
  mode?: "simple" | "detailed"
  legend?: LegendRow[]
  /** Absolute link back to the map or saved view. */
  danbyte_url?: string
}

export interface DiagramDocument {
  meta: DiagramMeta
  /** Tight box around everything drawn (`documentBounds`), before margin. */
  bounds: Rect
  /** Back to front. */
  bands: DiagramBand[]
  nodes: DiagramNode[]
  links: DiagramLink[]
  /** Breakout split points; links end on them by id. */
  junctions?: DiagramJunction[]
  notes: DiagramNote[]
}
