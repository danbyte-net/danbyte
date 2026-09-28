import { documentBounds } from "../geometry"
import { cardTextHeight, LINK_DEFAULTS, NEUTRAL_CARD } from "../theme"
import type {
  DiagramBand,
  DiagramDocument,
  DiagramEnd,
  DiagramLink,
  DiagramNode,
  DiagramNote,
  DiagramNub,
  Side,
} from "../types"

// A small leaf/spine fabric as a builder would hand it to the writers:
// spines, leaves, a firewall and edge router in a WAN side band, a server
// and a role-less device in the access row, a patch panel photo in a zone.
// It carries every document feature - pills of both kinds, card lines,
// Detailed nubs with rotated port names, Simple end labels, all four line
// kinds, a bundle, an LLDP ghost, a BGP session, row, column and zone bands,
// notes - and a device name that needs escaping.

const NUB_ALONG = 10
const NUB_OUT = 6

/** A nub centred at `c` along the given side of a card. */
function nub(n: DiagramNode, side: Side, c: number, label: string): DiagramNub {
  const h = side === "top" || side === "bottom"
  const w = h ? NUB_ALONG : NUB_OUT
  const d = h ? NUB_OUT : NUB_ALONG
  const x = h ? c - w / 2 : side === "left" ? n.x - NUB_OUT : n.x + n.w
  const y = h ? (side === "top" ? n.y - NUB_OUT : n.y + n.h) : c - d / 2
  return { x, y, w, h: d, side, label }
}

/** The link end at a node's `i`th nub: the nub's outer edge centre. */
function atNub(n: DiagramNode, i: number): DiagramEnd {
  const b = n.nubs![i]
  const x =
    b.side === "left" ? b.x : b.side === "right" ? b.x + b.w : b.x + b.w / 2
  const y =
    b.side === "top" ? b.y : b.side === "bottom" ? b.y + b.h : b.y + b.h / 2
  return { node: n.id, x, y, side: b.side, nub: i }
}

/** Simple mode: the midpoint of a side, where every line on it converges. */
function atSide(n: DiagramNode, side: Side): DiagramEnd {
  const x = side === "left" ? n.x : side === "right" ? n.x + n.w : n.x + n.w / 2
  const y = side === "top" ? n.y : side === "bottom" ? n.y + n.h : n.y + n.h / 2
  return { node: n.id, x, y, side }
}

const SPINE = { fill: "#6366f1", ink: "#fff" }
const LEAF = { fill: "#0ea5e9", ink: "#fff" }

function card(
  id: string,
  title: string,
  x: number,
  y: number,
  w: number,
  lines: string[],
  look: { fill: string; ink: string },
  extra: Partial<DiagramNode> = {}
): DiagramNode {
  return {
    id,
    kind: "card",
    x,
    y,
    w,
    h: cardTextHeight(lines.length),
    fill: look.fill,
    ink: look.ink,
    title,
    lines,
    link: `https://danbyte.example/devices/${id.slice(4)}`,
    ...extra,
  }
}

const spine1 = card(
  "dev:spine-01",
  "spine-01",
  200,
  30,
  160,
  ["10.0.0.1", "10.255.0.1", "FDO2231X0AB"],
  SPINE
)
const spine2 = card(
  "dev:spine-02",
  "spine-02",
  510,
  30,
  180,
  ["10.0.0.2", "10.255.0.2", "FDO2231X0AC"],
  SPINE,
  {
    pill: { kind: "status", text: "Planned", fill: "#f59e0b", ink: "#0a0a0a" },
  }
)
const leaf1 = card(
  "dev:leaf-01",
  "leaf-01",
  60,
  200,
  150,
  ["10.0.1.1", "10.255.1.1"],
  LEAF
)
const leaf2 = card(
  "dev:leaf-02",
  "leaf-02",
  300,
  200,
  150,
  ["10.0.1.2", "10.255.1.2"],
  LEAF,
  {
    pill: { kind: "monitor", text: "Down", fill: "#fb2c36", ink: "#ffffff" },
  }
)
const leaf3 = card(
  "dev:leaf-03",
  "leaf-03",
  540,
  200,
  150,
  ["10.0.1.3", "10.255.1.3"],
  LEAF
)
const leaf4 = card(
  "dev:leaf-04",
  "leaf-04-with-a-name-far-too-long-for-its-card",
  740,
  200,
  150,
  ["10.0.1.4"],
  LEAF,
  {
    pill: {
      kind: "status",
      text: "Decommissioning soon",
      fill: "#71717b",
      ink: "#ffffff",
    },
  }
)
const fw1 = card("dev:fw-01", "fw-01", 970, 60, 160, ["203.0.113.1"], {
  fill: "#ef4444",
  ink: "#fff",
})
const edge = card("dev:wan-edge", "wan-edge", 990, 380, 160, ["198.51.100.2"], {
  fill: "#facc15",
  ink: "#0a0a0a",
})
const srv = card(
  "dev:srv-01",
  'a<b&"c',
  300,
  420,
  150,
  ["10.0.2.10", "S/N >x'"],
  { fill: "#10b981", ink: "#fff" }
)
const unknown = card(
  "dev:unknown-01",
  "unknown-01",
  560,
  420,
  150,
  [],
  NEUTRAL_CARD
)
unknown.link = undefined
// Its name is too long to centre beside the pill: the pill takes a row.
leaf4.h = cardTextHeight(1, true)

spine1.nubs = [
  nub(spine1, "bottom", 250, "Ethernet1/1"),
  nub(spine1, "bottom", 310, "Ethernet1/2"),
]
spine2.nubs = [
  nub(spine2, "bottom", 575, "Ethernet1/1"),
  nub(spine2, "bottom", 630, "Ethernet1/2"),
  nub(spine2, "bottom", 646, "Ethernet1/3"),
]
leaf1.nubs = [
  nub(leaf1, "top", 135, "Ethernet49/1"),
  nub(leaf1, "bottom", 135, "Ethernet50/1"),
  nub(leaf1, "bottom", 95, "Ethernet48"),
]
leaf2.nubs = [
  nub(leaf2, "top", 375, "Ethernet49/1"),
  nub(leaf2, "top", 420, "Ethernet49/2"),
  nub(leaf2, "top", 436, "Ethernet49/3"),
]
leaf3.nubs = [
  nub(leaf3, "top", 615, "Ethernet49/1"),
  nub(leaf3, "bottom", 615, "Ethernet50/1"),
]

// A 1U patch panel photo at half scale, name caption underneath.
const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
const patch: DiagramNode = {
  id: "dev:patch-a",
  kind: "photo",
  x: 60,
  y: 560,
  w: 240,
  // image, gap, name row, one line
  h: 22 + 4 + 16 + 14,
  fill: "#71717b",
  ink: "#ffffff",
  title: "patch-a",
  lines: ["U12"],
  photo: {
    href: PIXEL,
    x: 60,
    y: 560,
    w: 240,
    h: 22,
    markers: [
      { port: "1", x: 200, y: 567, w: 8, h: 8 },
      { port: "2", x: 212, y: 567, w: 8, h: 8 },
    ],
  },
}

const cable = LINK_DEFAULTS.cable

const links: DiagramLink[] = [
  {
    id: "cab-1",
    kind: "straight",
    sem: "cable",
    source: atNub(spine1, 0),
    target: atNub(leaf1, 0),
    points: [],
    ...cable,
    labels: {
      a: { text: "Ethernet1/1" },
      b: { text: "Ethernet49/1" },
    },
    link: "https://danbyte.example/cables/1",
  },
  {
    id: "cab-2",
    kind: "elbow",
    sem: "cable",
    source: atNub(spine1, 1),
    target: atNub(leaf2, 0),
    points: [
      { x: 310, y: 150 },
      { x: 375, y: 150 },
    ],
    ...cable,
    labels: {
      a: { text: "Ethernet1/2" },
      b: { text: "Ethernet49/1" },
    },
  },
  {
    id: "cab-3",
    kind: "bendy",
    sem: "cable",
    source: atNub(spine2, 0),
    target: atNub(leaf3, 0),
    points: [
      { x: 575, y: 146 },
      { x: 615, y: 154 },
    ],
    stroke: "#0ea5e9",
    width: 1.25,
    labels: {
      a: { text: "Ethernet1/1" },
      b: { text: "Ethernet49/1" },
    },
  },
  {
    // A LAG: one nub per member, the bundle label on the merged segment.
    id: "lag-po10",
    kind: "straight",
    sem: "bundle",
    source: atNub(spine2, 1),
    target: atNub(leaf2, 1),
    points: [],
    ...LINK_DEFAULTS.bundle,
    labels: { mid: ["2x Po10", "10.1.0.8/31"] },
  },
  {
    id: "lag-po10-2",
    kind: "straight",
    sem: "bundle",
    source: atNub(spine2, 2),
    target: atNub(leaf2, 2),
    points: [],
    ...LINK_DEFAULTS.bundle,
    labels: {},
  },
  {
    // Same row: arcs under leaf-02 instead of crossing it.
    id: "cab-4",
    kind: "cyclical",
    sem: "cable",
    source: atNub(leaf1, 1),
    target: atNub(leaf3, 1),
    points: [
      { x: 207, y: 300 },
      { x: 543, y: 300 },
    ],
    ...cable,
    dash: "10 4",
    labels: {
      mid: ["10.1.9.0/31"],
      a: { text: "Ethernet50/1" },
      b: { text: "Ethernet50/1" },
    },
  },
  {
    id: "cab-5",
    kind: "straight",
    sem: "cable",
    source: atSide(leaf2, "bottom"),
    target: atSide(srv, "top"),
    points: [],
    ...cable,
    labels: {
      mid: ["10.0.2.0/24"],
      a: { text: "10.0.2.1" },
      b: { text: "10.0.2.10" },
    },
  },
  {
    id: "cab-6",
    kind: "elbow",
    sem: "cable",
    source: atSide(fw1, "bottom"),
    target: atSide(edge, "top"),
    points: [
      { x: 1050, y: 241 },
      { x: 1070, y: 241 },
    ],
    ...cable,
    labels: {
      mid: ["203.0.113.0/30"],
      a: { text: "ge-0/0/0" },
      b: { text: "ge-0/0/1" },
    },
  },
  {
    id: "cab-7",
    kind: "straight",
    sem: "cable",
    source: { node: patch.id, x: 204, y: 567, side: "top" },
    target: atNub(leaf1, 2),
    points: [],
    ...cable,
    labels: { b: { text: "Ethernet48" } },
  },
  {
    id: "ghost-1",
    kind: "straight",
    sem: "ghost",
    source: atSide(leaf3, "bottom"),
    target: atSide(unknown, "top"),
    points: [],
    ...LINK_DEFAULTS.ghost,
    labels: { mid: ["LLDP"] },
  },
  {
    id: "bgp-1",
    kind: "straight",
    sem: "bgp",
    source: atSide(spine2, "right"),
    target: atSide(fw1, "left"),
    points: [],
    ...LINK_DEFAULTS.bgp,
    labels: { mid: ["AS65001 – AS64500"] },
  },
]

const bands: DiagramBand[] = [
  {
    id: "band-spine",
    kind: "row",
    orient: "h",
    label: "Spine",
    x: 0,
    y: 0,
    w: 920,
    h: 130,
    fill: null,
  },
  {
    id: "band-leaf",
    kind: "row",
    orient: "h",
    label: "Leaf",
    x: 0,
    y: 170,
    w: 920,
    h: 140,
    fill: "#0ea5e9",
  },
  {
    id: "band-access",
    kind: "row",
    orient: "h",
    label: "Access",
    x: 0,
    y: 350,
    w: 920,
    h: 140,
  },
  {
    id: "band-wan",
    kind: "column",
    orient: "v",
    label: "WAN",
    x: 950,
    y: 0,
    w: 220,
    h: 490,
    fill: "#f59e0b",
  },
  {
    id: "zone-lab",
    kind: "zone",
    orient: "h",
    label: "Lab & <test>",
    x: 40,
    y: 520,
    w: 300,
    h: 110,
    fill: "#ec4899",
  },
]

// Centred on their points: an icon with its caption, an outlined text
// note, a small icon.
const notes: DiagramNote[] = [
  {
    id: "note-internet",
    x: 1060,
    y: 550,
    icon: "cloud",
    text: "Internet · DC02",
  },
  { id: "note-rack", x: 400, y: 540, text: "Rack A12\nrow 3", outline: true },
  {
    id: "note-site",
    x: 400,
    y: 610,
    icon: "building",
    text: "Oslo DC1",
    size: "s",
  },
]

const nodes = [
  spine1,
  spine2,
  leaf1,
  leaf2,
  leaf3,
  leaf4,
  fw1,
  edge,
  srv,
  unknown,
  patch,
]

const body = { bands, nodes, links, notes }

export const fabric: DiagramDocument = {
  meta: {
    title: "DC1 fabric",
    tenant: "Acme",
    generated_at: "2026-09-26T12:00:00Z",
    filters: "Site: DC1 · Status: Active",
    mode: "detailed",
    danbyte_url: "https://danbyte.example/topology?view=12",
    legend: [
      { kind: "role", label: "Spine", fill: SPINE.fill },
      { kind: "role", label: "Leaf", fill: LEAF.fill },
      { kind: "role", label: "Firewall", fill: "#ef4444" },
      { kind: "role", label: "Server", fill: "#10b981" },
      {
        kind: "pill",
        label: "Down",
        caption: "Monitoring",
        fill: "#fb2c36",
        ink: "#ffffff",
      },
      { kind: "line", label: "Cable", ...cable },
      { kind: "line", label: "LAG", ...LINK_DEFAULTS.bundle },
      { kind: "line", label: "Via patch panel", ...cable, dash: "10 4" },
      { kind: "line", label: "LLDP", ...LINK_DEFAULTS.ghost },
      { kind: "line", label: "BGP", ...LINK_DEFAULTS.bgp },
    ],
  },
  bounds: documentBounds(body),
  ...body,
}
