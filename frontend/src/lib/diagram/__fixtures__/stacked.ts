import { documentBounds } from "../geometry"
import { cardTextHeight, LINK_DEFAULTS } from "../theme"
import type {
  DiagramBand,
  DiagramDocument,
  DiagramLink,
  DiagramNode,
  Side,
} from "../types"

// A band holding two layers, as a builder hands it to the writers: a Core
// row over a "Data Center fabric" row whose Access and Server layers stand
// on sub-rows of their own, each with its role's badge at the left and a
// rule between them.

const H = cardTextHeight(1)
const ACCESS = { fill: "#0ea5e9", ink: "#ffffff" }
const SERVER = { fill: "#10b981", ink: "#ffffff" }
const CORE = { fill: "#6366f1", ink: "#ffffff" }

function card(
  id: string,
  x: number,
  y: number,
  line: string,
  look: { fill: string; ink: string }
): DiagramNode {
  return {
    id: `dev:${id}`,
    kind: "card",
    x,
    y,
    w: 150,
    h: H,
    fill: look.fill,
    ink: look.ink,
    title: id,
    lines: [line],
    link: `https://danbyte.example/devices/${id}`,
  }
}

const ACCESS_Y = 170 + 32 + 24
const SERVER_Y = ACCESS_Y + H + 72

const core = card("core-01", 335, 56, "10.0.0.1", CORE)
const acc1 = card("access-01", 180, ACCESS_Y, "10.0.1.1", ACCESS)
const acc2 = card("access-02", 490, ACCESS_Y, "10.0.1.2", ACCESS)
const srv1 = card("srv-01", 180, SERVER_Y, "10.0.2.1", SERVER)
const srv2 = card("srv-02", 490, SERVER_Y, "10.0.2.2", SERVER)

const mid = (n: DiagramNode, side: Side) => ({
  node: n.id,
  x: side === "left" ? n.x : side === "right" ? n.x + n.w : n.x + n.w / 2,
  y: side === "top" ? n.y : side === "bottom" ? n.y + n.h : n.y + n.h / 2,
  side,
})

const cable = LINK_DEFAULTS.cable

const links: DiagramLink[] = [
  ...[acc1, acc2].map<DiagramLink>((a, i) => ({
    id: `up-${i + 1}`,
    kind: "straight",
    sem: "cable",
    source: mid(core, "bottom"),
    target: mid(a, "top"),
    points: [],
    ...cable,
    labels: {},
  })),
  ...[
    [acc1, srv1],
    [acc2, srv2],
  ].map<DiagramLink>(([a, s], i) => ({
    id: `down-${i + 1}`,
    kind: "straight",
    sem: "cable",
    source: mid(a, "bottom"),
    target: mid(s, "top"),
    points: [],
    ...cable,
    labels: { mid: [`10.0.${i + 3}.0/31`] },
  })),
]

const bands: DiagramBand[] = [
  {
    id: "band-core",
    kind: "row",
    orient: "h",
    label: "Core",
    x: 0,
    y: 0,
    w: 820,
    h: 32 + 24 + H + 32,
    fill: null,
  },
  {
    id: "band-fabric",
    kind: "row",
    orient: "h",
    label: "Data Center fabric",
    x: 0,
    y: 170,
    w: 820,
    h: SERVER_Y + H + 32 - 170,
    fill: "#8b5cf6",
    layers: [
      { label: "Access", fill: "#0ea5e9", y: ACCESS_Y, h: H },
      { label: "Server", fill: "#10b981", y: SERVER_Y, h: H },
    ],
  },
]

const body = {
  bands,
  nodes: [core, acc1, acc2, srv1, srv2],
  links,
  notes: [],
}

export const stacked: DiagramDocument = {
  meta: {
    title: "DC1 fabric layers",
    generated_at: "2026-09-28T09:00:00Z",
    mode: "simple",
  },
  bounds: documentBounds(body),
  ...body,
}
