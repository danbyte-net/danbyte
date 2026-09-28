import type { Edge, Node } from "@xyflow/react"

import type { TopologyGraph, TopologyLinkOverride } from "@/lib/api"
import { readableText } from "@/lib/color"
import { endTextWidth } from "@/lib/diagram/geometry"
import { measureText } from "@/lib/diagram/measure"
import type { Measure } from "@/lib/diagram/measure"
import { LABEL } from "@/lib/diagram/theme"
import { classifyEdges, orientHubToLeaf } from "../edge-semantics"
import type { BundleMember, EdgeClass } from "../edge-semantics"
import {
  bundleStroke,
  edgeLook,
  edgeStroke,
  flowEdgeStyle,
} from "../edge-style"
import type { EdgeColorMode, EdgeSem } from "../edge-style"
import { sharedLag } from "../lag-bundles"
import type { EdgeLag } from "../lag-bundles"
import { GROUP_H, GROUP_W } from "../group-size"
import { layoutNodes } from "../layout"
import type { SizeOf } from "../layout"
import { graphLevels, resolveLevels } from "../levels-param"
import {
  anchorLinks,
  anchorPoint,
  chooseSides,
  reorderNubs,
  SIDE_DIR,
  sideLength,
} from "./anchors"
import type { AnchorLink, Anchors } from "./anchors"
import { arcFor, arcSide } from "./arcs"
import { chipBand, fitRows, rowsSig, titleStrip } from "./bands"
import type { BandRow, LabelRoom } from "./bands"
import type { ArcAxis, ArcSide } from "./arcs"
import { cardContent } from "./card-fields"
import {
  CARD,
  cardLayout,
  JUNCTION,
  NO_NUBS,
  normalizeHex,
  NUB,
} from "./card-layout"
import type { CardBox, CardLayoutInput } from "./card-layout"
import {
  detectFanouts,
  detectMeshes,
  fanChip,
  portsLabel,
  sortPorts,
} from "./fanout"
import type { Fan, Mesh } from "./fanout"
import { CLEAR, LANE, obstacles, RouteCache, SHARED_STUB } from "./lanes"
import type { Obstacles } from "./lanes"
import {
  DEFAULT_LABELS,
  fanLabelSets,
  hasLabels,
  linkLabelSet,
  orientPair,
} from "./link-labels"
import type { LabelToken, LinkLabelSet } from "./link-labels"
import { ELBOW_RADIUS, leaves, routeThrough } from "./link-geometry"
import {
  captionCap,
  PHOTO,
  photoFace,
  photoLod,
  photoShown,
} from "./photo-anchors"
import type { PhotoFace, PhotoShown } from "./photo-anchors"
import { packLoose } from "./pack"
import { settleGrown } from "./placement"
import { endRun, planEdges, portStub } from "./plan"
import type { TitleStrip } from "./plan"
import { pairKey } from "./types"
import type {
  Anchor,
  CablePair,
  DiagramCardData,
  DiagramEdgeData,
  DiagramMode,
  Dir,
  End,
  LineType,
  LinkLabels,
  PortRef,
  Pt,
  Rect,
  Side,
} from "./types"

// The Diagram tab's pipeline: payload graph → React Flow cards and links.
//
//   1. classify and fold the edges, orient them hub → leaf;
//   2. size each card from its text (Simple's compact box);
//   3. lay out (dagre, or the saved arrangement) - devices with no cable
//      at all packed in a grid under the rest (pack.ts);
//   4. Detailed: count each card's nubs per side, grow the cards to fit,
//      lay out again with the real boxes, and anchor every cable end;
//   5. plan every line (plan.ts): elbows in their own lanes clear of the
//      cards, cyclical arcs round the cards between their ends, port names
//      along their cables, middle chips off the cards, end addresses.
//
// Cyclical links are settled before anchoring: which draw as arcs (the
// link's own line always does; the view's default only where its straight
// line would cross a card and an arc gets clear of it) and to which side,
// since an arc's ends leave through the side it bulges to.
//
// A breakout cable (fanout.ts) is drawn as one trunk from its shared port
// to a junction node, then one leg to each far port; one with several
// ports at both ends as a trunk between two junctions, each end's ports
// meeting at their own.
//
// Diagram nodes are positioned by their CENTRE (React Flow `origin`
// [0.5, 0.5]), so a card that grows to fit its nubs - or shrinks back in
// Simple mode - stays where it was put, and one saved arrangement serves
// both modes.
//
// A device the page marked for its photo (`withFaces`) is drawn as its
// front photo when the payload has one (photo-anchors.ts): a fixed box to
// scale, every cable on its port in either mode - the photo is the
// detail - and an obstacle like any card. One taking its cables at its
// edge is anchored like a card on its image instead: Simple lines meet
// at a side's midpoint, Detailed ones leave nubs along it.

/** Diagram nodes: `position` is the node's centre. */
export const CENTRE: [number, number] = [0.5, 0.5]

export interface DiagramOptions {
  mode: DiagramMode
  /** The view's line type; `links` overrides it per device pair. */
  line: LineType
  links?: Record<string, TopologyLinkOverride>
  colorMode: EdgeColorMode
  direction?: "LR" | "TB"
  roleOrder?: string[]
  roleBonds?: string[]
  roleDistance?: Record<string, number>
  /** Detailed: fold an aggregate's member cables into one link (their
   * nubs stay one per member). Simple folds every cable of a pair. */
  bundleLags?: boolean
  /** The Labels setting: which of subnets, end addresses and port names
   * the links carry (all three when absent). */
  labels?: readonly LabelToken[]
  /** Saved arrangement: node id → centre. */
  positions?: Record<string, [number, number]>
  /** The layer bands' rows as saved (bands.ts): with a saved arrangement
   * they are re-fitted round the cards as this mode and face size them
   * (`fitRows`), and the lines keep out of their title strips. */
  rows?: readonly BandRow[]
  matched?: Set<string> | null
  focusNodeId?: string
  /** The tenant's names for the monitoring states: a card keeps room for
   * the pill as it will read. */
  checkLabels?: Partial<Record<"down" | "degraded", string>>
  measure?: Measure
  /** The box of a node the Diagram does not size itself: the canvas
   * passes its node registry's. Without one (the worker has no
   * components) such a node is a site or location card - the only other
   * kind the topology API sends - sized as `group-size.ts` says. */
  sizeOf?: SizeOf
}

/** A node the Diagram does not size itself, without the node registry. */
const plainSize: SizeOf = () => ({ width: GROUP_W, height: GROUP_H })

/** What a drag needs to re-anchor the links without a new layout. */
export interface DiagramModel {
  mode: DiagramMode
  direction: "LR" | "TB"
  /** Each card's text, to re-size it for a new nub demand. */
  cards: Map<string, CardLayoutInput>
  /** Each card's Simple box - what sides are chosen from. */
  base: Map<string, CardBox>
  /** Each card's current box and nubs. */
  shown: Map<string, DiagramCardData["diagram"]>
  /** Nodes drawn as photos: their face, the name for the caption and the
   * pills it keeps room for. Their box is in `base`; they are not in
   * `cards` (a photo never grows). */
  photos?: Map<string, PhotoModel>
  /** Other nodes' boxes (group cards, trace ports). */
  fixed: Map<string, { w: number; h: number }>
  /** The links anchored to card sides. */
  links: AnchorLink[]
  /** Every edge as built, before anchoring. */
  edges: Edge<DiagramEdgeData>[]
  /** Breakout cables: where their junctions go. */
  fans: FanModel[]
  /** N:M breakout cables: where their two junctions go. */
  meshes?: MeshModel[]
  /** Detailed: the gap two facing sides should leave for a port name at
   * each end of a cable. */
  roomy: number
  measure: Measure
  /** The layer bands' rows as drawn: the saved ones re-fitted round the
   * cards (`fitRows`). Their title strips keep the lines out. */
  rows?: BandRow[]
  /** The saved rows those were fitted from (`rowsSig`). */
  rowsFrom?: string
  /** Photo ports leave by their nearer image edge: the build found the
   * lines cross less that way than leaving towards their far ends. */
  nearExits?: true
  /** Per row, the x spans of its title strip that lines, cards and labels
   * take, as last planned: where its title chip may not go. */
  titles?: Map<string, [number, number][]>
}

/** A photo node as the anchoring sees it. */
export interface PhotoModel {
  face: PhotoFace
  name: string
  /** Every pill text the card fields can show (`cardContent().pillSlot`). */
  slot: string[]
}

/** A breakout cable as the anchoring sees it. */
export interface FanModel {
  /** The junction node. */
  id: string
  /** The card its trunk leaves. */
  trunk: string
  /** The cards its legs land on. */
  far: string[]
  /** How far out along the trunk the junction sits at least, per mode:
   * room for the trunk's port name and its chip. */
  reach: Record<DiagramMode, number>
  /** What the legs need between the junction and the far cards, per
   * mode: their lanes and far port names, half the legs turning off each
   * way. */
  legRoom: Record<DiagramMode, number>
  /** The card each leg lands on, per mode (Simple folds a card's legs). */
  legs?: Record<DiagramMode, string[]>
  /** The trunk's own port name, per mode: what the junction keeps room
   * for before the legs' room. */
  trunkRoom: Record<DiagramMode, number>
}

/** An N:M breakout cable as the anchoring sees it. */
export interface MeshModel {
  /** The A end's junction node, and the B end's. */
  id: string
  idB: string
  /** The cards each end's ports are on. */
  a: string[]
  b: string[]
  /** How far out from each end's cards its junction sits at least, per
   * mode: room for the legs' lanes and port names. */
  reach: Record<DiagramMode, number>
}

export interface DiagramBuild {
  nodes: Node[]
  edges: Edge[]
  model: DiagramModel
}

/** The device uuid behind a node id (`dev:<uuid>`), for link keys. */
function deviceKey(id: string, deviceId?: string): string {
  return deviceId ?? (id.startsWith("dev:") ? id.slice(4) : id)
}

/** How many distinct cables a bundle's members are: a breakout cable
 * reaches a pair as one member with several pairs, and is still one. */
export function distinctCables(
  cables: readonly { cable_id?: string }[]
): number {
  const ids = new Set<string>()
  let anon = 0
  for (const c of cables)
    if (c.cable_id) ids.add(c.cable_id)
    else anon += 1
  return ids.size + anon
}

/** A bundle's chip: "2x", with the aggregates' names when they share one.
 * One cable is no bundle - its port names already say where it runs. */
function bundleLabel(n: number, lag: EdgeLag | null, count = true): string[] {
  if (n < 2) return []
  const name = lag?.a && lag.b ? `${lag.a.name} ⇄ ${lag.b.name}` : ""
  if (!count) return name ? [name] : []
  return [name ? `${name} · ${n}x` : `${n}x`]
}

type Pair = NonNullable<BundleMember["pairs"]>[number]

/** A pair end's component, when the payload names it. */
const refOf = (id?: string, kind?: string): PortRef | undefined =>
  id ? { id, ...(kind ? { kind } : {}) } : undefined

/** One `{a, b}` port per cable pair (with its component), oriented to the
 * edge's ends. */
function cablesOf(
  pairs: readonly Pair[],
  flipped: boolean
): { a?: string; b?: string; aRef?: PortRef; bRef?: PortRef }[] {
  return pairs.map((p) => {
    const a = p.a_port ?? p.a
    const b = p.b_port ?? p.b
    const ra = refOf(p.a_id, p.a_kind)
    const rb = refOf(p.b_id, p.b_kind)
    const [x, y, rx, ry] = flipped ? [b, a, rb, ra] : [a, b, ra, rb]
    return {
      a: x,
      b: y,
      ...(rx ? { aRef: rx } : {}),
      ...(ry ? { bRef: ry } : {}),
    }
  })
}

const swapLag = (lag: EdgeLag | null | undefined): EdgeLag | null =>
  lag ? { a: lag.b, b: lag.a } : null

/** The base edge for one classified payload edge; anchors come later. */
function diagramEdge(
  c: EdgeClass,
  keyOf: (id: string) => string,
  opts: DiagramOptions
): Edge<DiagramEdgeData> {
  const ends = { id: c.id, source: c.source, target: c.target }
  const pk = pairKey(keyOf(c.source), keyOf(c.target))
  const lineOf = () => opts.links?.[pk]?.line ?? opts.line
  const base = (sem: EdgeSem, line: LineType) => ({
    sem,
    pairKey: pk,
    line,
    a: [],
    b: [],
    labels: {},
    ...(line === "cyclical" ? { arcAsk: arcAsk(opts, pk) } : {}),
  })
  switch (c.sem) {
    case "bgp":
      // A session, not wiring: the centre-to-centre overlay line.
      return {
        ...ends,
        type: "overlay",
        data: { ...base("bgp", "straight"), bgp: c.raw },
        ...flowEdgeStyle(edgeLook("bgp")),
      }
    case "ghost": {
      const ep = c.raw?.pairs?.[0]
      return {
        ...ends,
        type: "link",
        // Hover names the ports; the line itself only says what it is.
        label: ep ? `${ep.a} ↔ ${ep.b} · LLDP` : "LLDP",
        data: {
          ...base("ghost", "straight"),
          ghost: c.raw,
          simple: true,
          labels: { mid: ["LLDP"] },
        },
        ...flowEdgeStyle(edgeLook("ghost")),
      }
    }
    case "groupedge": {
      const n = c.group?.cable_count ?? 1
      return {
        ...ends,
        type: "link",
        data: {
          ...base("groupedge", "straight"),
          group: c.group,
          simple: true,
          labels: { mid: [`${n}x`] },
        },
        ...flowEdgeStyle(edgeLook("groupedge", { count: n })),
      }
    }
    case "membership":
    case "through":
      return {
        ...ends,
        type: "link",
        data: { ...base(c.sem, "straight"), simple: true },
        ...flowEdgeStyle(edgeLook(c.sem)),
      }
    case "cable": {
      // One cable, however many port pairs it carries: never a count.
      const r = c.raw
      return {
        ...ends,
        type: "link",
        animated: r?.marked,
        data: { ...base("cable", lineOf()), raw: r },
        ...flowEdgeStyle(
          edgeLook("cable", {
            stroke: edgeStroke(r, opts.colorMode),
            via: !!r?.via?.length,
            marked: r?.marked,
          })
        ),
      }
    }
    case "lagbundle": {
      const marked = c.cables.some((x) => x.marked)
      return {
        ...ends,
        type: "link",
        animated: marked,
        data: {
          ...base("lagbundle", lineOf()),
          cables: c.cables,
          lag: c.lag,
          labels: { mid: bundleLabel(distinctCables(c.cables), c.lag) },
        },
        ...flowEdgeStyle(
          edgeLook("lagbundle", {
            stroke: bundleStroke(c.cables, opts.colorMode),
            marked,
          })
        ),
      }
    }
    case "bundle": {
      const lag = sharedLag(c.cables)
      return {
        ...ends,
        type: "link",
        data: {
          ...base("bundle", lineOf()),
          cables: c.cables,
          ...(lag ? { lag } : {}),
          labels: { mid: bundleLabel(distinctCables(c.cables), lag) },
        },
        ...flowEdgeStyle(
          edgeLook("bundle", {
            stroke: bundleStroke(c.cables, opts.colorMode),
          })
        ),
      }
    }
  }
}

/** How a cyclical link asked for its arc: by its own override (always),
 * or as the view's default; and a saved side. */
function arcAsk(
  opts: DiagramOptions,
  pk: string
): NonNullable<DiagramEdgeData["arcAsk"]> {
  const own = opts.links?.[pk]
  return {
    always: own?.line === "cyclical",
    ...(own?.flip === 1 || own?.flip === -1 ? { flip: own.flip } : {}),
  }
}

/** The payload pairs behind a link, in the order its cables anchor
 * (`anchorLink`), oriented to the drawn edge. */
function linkPairs(d: DiagramEdgeData, flipped: boolean): CablePair[] {
  const pairs: CablePair[] =
    d.sem === "cable"
      ? (d.raw?.pairs ?? [])
      : (d.cables ?? []).flatMap((c) => c.pairs ?? [])
  return pairs.map((p) => orientPair(p, flipped))
}

/** A link's labels with a label set folded in: subnets after the chip it
 * has, the end addresses, and whether port names show. */
function foldLabels(
  labels: LinkLabels,
  set: LinkLabelSet | null,
  tokens: readonly LabelToken[]
): LinkLabels {
  const mid = [...(labels.mid ?? []), ...(set?.mid ?? [])]
  const ends = set?.ends.some((e) => e.a || e.b) ? set.ends : undefined
  return {
    ...labels,
    ...(mid.length ? { mid } : {}),
    ...(ends ? { ends } : {}),
    ...(tokens.includes("port") ? {} : { noPorts: true }),
  }
}

/** A cable, bundle or aggregate link with its Labels: per cable where
 * each has its own nub (Detailed) or its own port on a photo
 * (`perCable`), one set for the one line of Simple. */
function withLinkLabels(
  e0: Edge<DiagramEdgeData>,
  flipped: boolean,
  mode: DiagramMode,
  tokens: readonly LabelToken[],
  perCable = false
): Edge<DiagramEdgeData> {
  let e = e0
  if (e.type !== "link" || !e.data || e.data.simple) return e
  const sem = e.data.sem
  if (sem !== "cable" && sem !== "lagbundle" && sem !== "bundle") return e
  // Each cable its own line (to a photo's ports): no line stands for the
  // others, so none carries their count - an aggregate keeps its name.
  if (perCable && sem !== "cable") {
    const { mid: _count, ...rest } = e.data.labels
    const name = bundleLabel(2, e.data.lag ?? null, false)
    e = {
      ...e,
      data: { ...e.data, labels: name.length ? { ...rest, mid: name } : rest },
    }
  }
  const d = e.data!
  const pairs = linkPairs(d, flipped)
  const set = pairs.length
    ? linkLabelSet(
        mode === "detailed" || perCable ? pairs.map((p) => [p]) : [pairs],
        tokens
      )
    : null
  if (!(set && hasLabels(set)) && tokens.includes("port")) return e
  return { ...e, data: { ...d, labels: foldLabels(d.labels, set, tokens) } }
}

/** Flip an oriented edge's per-end data: its aggregate names. */
function orientData(e: Edge<DiagramEdgeData>): Edge<DiagramEdgeData> {
  const d = e.data!
  if (!d.lag) return e
  const lag = swapLag(d.lag)
  return {
    ...e,
    data: {
      ...d,
      lag: lag ?? undefined,
      ...(d.sem === "lagbundle" || d.sem === "bundle"
        ? {
            labels: {
              ...d.labels,
              mid: bundleLabel(distinctCables(d.cables ?? []), lag),
            },
          }
        : {}),
    },
  }
}

/** The link each drawn edge anchors as: its cable ends, per port. */
function anchorLink(
  e: Edge<DiagramEdgeData>,
  flipped: boolean
): AnchorLink | null {
  const d = e.data!
  if (e.type !== "link") return null
  const base = { id: e.id, source: e.source, target: e.target }
  if (d.simple) return { ...base, simple: true }
  if (d.sem === "cable")
    return { ...base, cables: cablesOf(d.raw?.pairs ?? [], flipped) }
  // An aggregate or a pair bundle: one end per member cable pair.
  return {
    ...base,
    cables: cablesOf(
      (d.cables ?? []).flatMap((c) => c.pairs ?? []),
      flipped
    ),
  }
}

// ── Breakouts ────────────────────────────────────────────────────────────

/** A breakout's junction node, trunk and legs, and how they anchor. In
 * Simple the legs to one far card fold into one. `layout` stands in for
 * the fan in the layout: a plain link from the trunk's card to each far
 * card. */
function fanParts(
  f: Fan,
  keyOf: (id: string) => string,
  mode: DiagramMode,
  opts: DiagramOptions,
  measure: Measure
): {
  node: Node
  edges: Edge<DiagramEdgeData>[]
  links: AnchorLink[]
  layout: Edge[]
  model: FanModel
} {
  const raw = f.raw
  const stroke = edgeStroke(raw, opts.colorMode)
  const look = flowEdgeStyle(
    edgeLook("cable", {
      stroke,
      via: !!raw.via?.length,
      marked: raw.marked,
    })
  )
  const far = [...new Set(f.legs.map((l) => l.node))]
  const lineTo = (node: string): LineType =>
    opts.links?.[pairKey(keyOf(f.trunk.node), keyOf(node))]?.line ?? opts.line
  const chip = fanChip(raw)
  const tokens = opts.labels ?? DEFAULT_LABELS
  const legs =
    mode === "simple"
      ? far.map((node) => {
          const mine = f.legs.filter((l) => l.node === node)
          return {
            node,
            ports: sortPorts(mine.map((l) => l.port)),
            pairs: mine.flatMap((l) => l.pairs ?? []),
          }
        })
      : f.legs.map((l) => ({
          node: l.node,
          ports: [l.port],
          pairs: l.pairs ?? [],
        }))
  // Each leg's far component (its first port's), for a photo's marker.
  const legIds = legs.map(
    (l) => f.legs.find((x) => x.node === l.node && x.port === l.ports[0])?.id
  )
  // Subnets per leg, the shared port's addresses on the trunk.
  const sets = fanLabelSets(
    raw.pairs ?? [],
    legs.map((l) => l.pairs),
    tokens
  )
  const common = (pk: string, line: LineType) => ({
    sem: "cable" as const,
    raw,
    pairKey: pk,
    line,
    a: [],
    b: [],
    cableId: f.cable,
  })
  const trunk: Edge<DiagramEdgeData> = {
    id: `${f.id}:t`,
    source: f.trunk.node,
    target: f.id,
    type: "link",
    animated: raw.marked,
    data: {
      ...common(pairKey(keyOf(f.trunk.node), keyOf(far[0])), "straight"),
      fan: { role: "trunk", junction: f.id },
      labels: foldLabels(chip.length ? { mid: chip } : {}, sets.trunk, tokens),
    },
    ...look,
  }
  const legEdges = legs.map(
    (l, i): Edge<DiagramEdgeData> => ({
      id: `${f.id}:l${i}`,
      source: f.id,
      target: l.node,
      type: "link",
      animated: raw.marked,
      data: {
        ...common(pairKey(keyOf(f.trunk.node), keyOf(l.node)), lineTo(l.node)),
        fan: {
          role: "leg",
          junction: f.id,
          ...(l.ports.length > 1 ? { ports: l.ports } : {}),
        },
        labels: foldLabels({}, sets.legs[i], tokens),
      },
      ...look,
    })
  )
  const links: AnchorLink[] = [
    {
      id: trunk.id,
      source: trunk.source,
      target: trunk.target,
      cables: [
        {
          a: f.trunk.port,
          ...(f.trunk.id ? { aRef: { id: f.trunk.id } } : {}),
        },
      ],
      ...(mode === "simple" ? { simple: true } : {}),
      junction: { b: [0, 0] },
    },
    ...legEdges.map(
      (e, i): AnchorLink => ({
        id: e.id,
        source: e.source,
        target: e.target,
        cables: [
          {
            b: portsLabel(legs[i].ports),
            ...(legIds[i] ? { bRef: { id: legIds[i] } } : {}),
          },
        ],
        ...(mode === "simple" ? { simple: true } : {}),
        junction: { a: [0, 0] },
      })
    ),
  ]
  const chipW = chip.length
    ? measure(chip[0], LABEL.MID_SIZE, 600) + 2 * LABEL.PAD_X
    : 0
  // The runs the trunk's and the legs' end labels take out of their nubs.
  const width = (t: string) => endTextWidth(t, measure)
  const ports = tokens.includes("port")
  const trunkRun = endRun([
    ...(ports ? [width(f.trunk.port)] : []),
    ...(sets.trunk.ends[0]?.a ?? []).map(width),
  ])
  const legRun = Math.max(
    0,
    ...f.legs.map((l, i) =>
      endRun([
        ...(ports ? [width(l.port)] : []),
        ...(mode === "detailed" ? (sets.legs[i]?.ends[0]?.b ?? []) : []).map(
          width
        ),
      ])
    )
  )
  return {
    node: {
      id: f.id,
      type: "junction",
      position: { x: 0, y: 0 },
      origin: CENTRE,
      width: JUNCTION.w,
      height: JUNCTION.h,
      draggable: false,
      selectable: false,
      focusable: false,
      data: { cable: f.cable, stroke, raw },
    },
    edges: [trunk, ...legEdges],
    links,
    layout: far.map((node, i) => ({
      id: `${f.id}:p${i}`,
      source: f.trunk.node,
      target: node,
    })),
    model: {
      id: f.id,
      trunk: f.trunk.node,
      far,
      reach: {
        simple: Math.max(24, chipW + 16),
        detailed: Math.max(24, portStub(trunkRun) + (chipW ? chipW + 8 : 0)),
      },
      // Legs turn off both ways, so half of them stack up on one side.
      legRoom: {
        simple: SHARED_STUB + LANE * Math.ceil(far.length / 2) + 16,
        detailed:
          SHARED_STUB + LANE * Math.ceil(f.legs.length / 2) + portStub(legRun),
      },
      trunkRoom: { simple: 24, detailed: portStub(trunkRun) },
      legs: { simple: far, detailed: f.legs.map((l) => l.node) },
    },
  }
}

/** An N:M breakout's two junction nodes, the trunk between them and a
 * leg from each junction to each of its end's ports (in Simple, one per
 * card). Legs carry their port names; the trunk the cable's chip. */
function meshParts(
  m: Mesh,
  keyOf: (id: string) => string,
  mode: DiagramMode,
  opts: DiagramOptions,
  measure: Measure
): {
  nodes: Node[]
  edges: Edge<DiagramEdgeData>[]
  links: AnchorLink[]
  layout: Edge[]
  model: MeshModel
} {
  const raw = m.raw
  const stroke = edgeStroke(raw, opts.colorMode)
  const look = flowEdgeStyle(
    edgeLook("cable", {
      stroke,
      via: !!raw.via?.length,
      marked: raw.marked,
    })
  )
  const tokens = opts.labels ?? DEFAULT_LABELS
  const idB = `${m.id}:b`
  const trunkId = `${m.id}:t`
  const cardsA = [...new Set(m.a.map((t) => t.node))]
  const cardsB = [...new Set(m.b.map((t) => t.node))]
  const pk = pairKey(keyOf(cardsA[0]), keyOf(cardsB[0]))
  const chip = fanChip(raw)
  const common = (key: string, line: LineType) => ({
    sem: "cable" as const,
    raw,
    pairKey: key,
    line,
    a: [],
    b: [],
    cableId: m.cable,
  })
  // In Simple each card's ports fold into one leg, named by its first.
  const legsOf = (terms: readonly Mesh["a"][number][]) =>
    mode === "simple"
      ? [...new Set(terms.map((t) => t.node))].map((node) => {
          const ports = sortPorts(
            terms.filter((t) => t.node === node).map((t) => t.port)
          )
          return { node, port: portsLabel(ports), ports }
        })
      : terms.map((t) => ({ node: t.node, port: t.port, ports: [t.port] }))
  const node = (id: string): Node => ({
    id,
    type: "junction",
    position: { x: 0, y: 0 },
    origin: CENTRE,
    width: JUNCTION.w,
    height: JUNCTION.h,
    draggable: false,
    selectable: false,
    focusable: false,
    data: { cable: m.cable, stroke, raw, trunk: trunkId },
  })
  const noPorts = tokens.includes("port") ? {} : { noPorts: true }
  const edges: Edge<DiagramEdgeData>[] = [
    {
      id: trunkId,
      source: m.id,
      target: idB,
      type: "link",
      animated: raw.marked,
      data: {
        ...common(pk, "straight"),
        fan: { role: "trunk", junction: m.id },
        labels: chip.length ? { mid: chip } : {},
      },
      ...look,
    },
  ]
  const links: AnchorLink[] = [
    {
      id: trunkId,
      source: m.id,
      target: idB,
      cables: [{}],
      ...(mode === "simple" ? { simple: true } : {}),
      junction: { a: [0, 0], b: [0, 0] },
    },
  ]
  for (const [end, junction, terms, others] of [
    ["a", m.id, m.a, cardsB],
    ["b", idB, m.b, cardsA],
  ] as const)
    legsOf(terms).forEach((l, i) => {
      const key = pairKey(keyOf(l.node), keyOf(others[0]))
      const id = `${m.id}:${end}${i}`
      edges.push({
        id,
        source: junction,
        target: l.node,
        type: "link",
        animated: raw.marked,
        data: {
          ...common(key, opts.links?.[key]?.line ?? opts.line),
          fan: {
            role: "leg",
            junction,
            ...(l.ports.length > 1 ? { ports: l.ports } : {}),
          },
          labels: noPorts,
        },
        ...look,
      })
      links.push({
        id,
        source: junction,
        target: l.node,
        cables: [{ b: l.port }],
        ...(mode === "simple" ? { simple: true } : {}),
        junction: { a: [0, 0] },
      })
    })
  return {
    nodes: [node(m.id), node(idB)],
    edges,
    links,
    layout: cardsA.flatMap((a, i) =>
      cardsB.map((b, j) => ({ id: `${m.id}:p${i}.${j}`, source: a, target: b }))
    ),
    model: {
      id: m.id,
      idB,
      a: cardsA,
      b: cardsB,
      reach: {
        simple: SHARED_STUB + LANE + 16,
        detailed:
          SHARED_STUB +
          ELBOW_RADIUS +
          LANE * Math.ceil(Math.max(m.a.length, m.b.length) / 2) +
          portStub(
            tokens.includes("port")
              ? endRun([
                  Math.max(
                    ...[...m.a, ...m.b].map((t) =>
                      endTextWidth(t.port, measure)
                    )
                  ),
                ])
              : 0
          ),
      },
    },
  }
}

/** Where each N:M breakout's junctions go: between its two ends' cards, a
 * third of the way out from each towards the other, clear of every card.
 * Each end's legs leave its junction towards that end's cards. */
function placeMeshes(
  model: DiagramModel,
  rects: ReadonlyMap<string, Rect>,
  solid: Obstacles
): Map<string, { c: Pt; dir: Dir }> {
  const out = new Map<string, { c: Pt; dir: Dir }>()
  const bbox = (ids: readonly string[]): Rect | null => {
    const rs = ids.map((id) => rects.get(id)).filter((r): r is Rect => !!r)
    if (!rs.length) return null
    const x = Math.min(...rs.map((r) => r.x))
    const y = Math.min(...rs.map((r) => r.y))
    return {
      x,
      y,
      w: Math.max(...rs.map((r) => r.x + r.w)) - x,
      h: Math.max(...rs.map((r) => r.y + r.h)) - y,
    }
  }
  for (const m of model.meshes ?? []) {
    const ba = bbox(m.a)
    const bb = bbox(m.b)
    if (!ba || !bb) continue
    const [sa, sb] = chooseSides(ba, bb)
    const dir = SIDE_DIR[sa]
    // From the nubs' tips in Detailed.
    const tip = model.mode === "detailed" ? NUB.OUT : 0
    const mid = (r: Rect, side: Side) =>
      anchorPoint(r, { k: "side", side, off: sideLength(r, side) / 2 }, tip)
    // Level with each other, half-way across: the trunk runs straight.
    const [ma, mb] = [mid(ba, sa), mid(bb, sb)]
    const across = dir[0] ? (ma.y + mb.y) / 2 : (ma.x + mb.x) / 2
    const pa = dir[0] ? { x: ma.x, y: across } : { x: across, y: ma.y }
    const pb = dir[0] ? { x: mb.x, y: across } : { x: across, y: mb.y }
    const gap = (pb.x - pa.x) * dir[0] + (pb.y - pa.y) * dir[1]
    // Far enough out for the legs, a third of the way when there is room,
    // never past the middle.
    const want = m.reach[model.mode]
    const d =
      gap > 0
        ? Math.min(Math.max(gap / 3, want), Math.max(12, gap / 2 - 6))
        : 24
    const clear = (p: Pt) =>
      !solid
        .near({ x: p.x - 1, y: p.y - 1, w: 2, h: 2 })
        .some(
          ({ r }) =>
            p.x > r.x - CLEAR &&
            p.x < r.x + r.w + CLEAR &&
            p.y > r.y - CLEAR &&
            p.y < r.y + r.h + CLEAR
        )
    const at = (from: Pt, s: number) => {
      let k = d
      let p = { x: from.x + s * dir[0] * k, y: from.y + s * dir[1] * k }
      for (let i = 0; i < 40 && !clear(p); i++) {
        k += 12
        p = { x: from.x + s * dir[0] * k, y: from.y + s * dir[1] * k }
      }
      return p
    }
    out.set(m.id, { c: at(pa, 1), dir: [-dir[0], -dir[1]] as Dir })
    out.set(m.idB, { c: at(pb, -1), dir })
  }
  return out
}

const rectAt = (c: Pt, s: { w: number; h: number }): Rect => ({
  x: c.x - s.w / 2,
  y: c.y - s.h / 2,
  w: s.w,
  h: s.h,
})

/** Where a breakout's junction sits and which way its legs leave it;
 * `bent`: its trunk goes round to it (placeJunctions). */
interface Junction {
  c: Pt
  dir: Dir
  bent?: true
}

const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/** The middle of a box's side. */
function sideMiddle(box: Rect, side: Side): Pt {
  switch (side) {
    case "T":
      return { x: box.x + box.w / 2, y: box.y }
    case "B":
      return { x: box.x + box.w / 2, y: box.y + box.h }
    case "L":
      return { x: box.x, y: box.y + box.h / 2 }
    case "R":
      return { x: box.x + box.w, y: box.y + box.h / 2 }
  }
}

/** How far along its (axis-aligned) direction a ray from `from` first
 * meets a card other than `own`, grown by `CLEAR`, within `reach`; null
 * when it meets none. */
function firstHit(
  solid: Obstacles,
  from: End,
  reach: number,
  own: string
): number | null {
  const [nx, ny] = from.dir
  const to = { x: from.x + nx * reach, y: from.y + ny * reach }
  const area = {
    x: Math.min(from.x, to.x) - 1,
    y: Math.min(from.y, to.y) - 1,
    w: Math.abs(to.x - from.x) + 2,
    h: Math.abs(to.y - from.y) + 2,
  }
  let best: number | null = null
  for (const { id, r } of solid.near(area)) {
    if (id === own) continue
    const x0 = r.x - CLEAR
    const x1 = r.x + r.w + CLEAR
    const y0 = r.y - CLEAR
    const y1 = r.y + r.h + CLEAR
    let t: number | null = null
    if (nx > 0.5 && from.y > y0 && from.y < y1) t = x0 - from.x
    else if (nx < -0.5 && from.y > y0 && from.y < y1) t = from.x - x1
    else if (ny > 0.5 && from.x > x0 && from.x < x1) t = y0 - from.y
    else if (ny < -0.5 && from.x > x0 && from.x < x1) t = from.y - y1
    if (t !== null && t > 0 && t <= reach && (best === null || t < best))
      best = t
  }
  return best
}

/** Where each breakout's junction goes: straight out from its trunk's
 * port (`trunkEnds`, else the side facing the far cards' midpoint), a
 * third of the way to the far cards but far enough for the trunk's port
 * name and chip, and clear of every card. An N:M breakout's two go
 * between its ends (`placeMeshes`). */
function placeJunctions(
  model: DiagramModel,
  rects: ReadonlyMap<string, Rect>,
  solid: Obstacles,
  ends?: ReadonlyMap<string, End>,
  sides?: ReadonlyMap<string, Side>
): Map<string, Junction> {
  const out = new Map<string, Junction>()
  const inCard = (p: Pt) =>
    solid
      .near({ x: p.x - 1, y: p.y - 1, w: 2, h: 2 })
      .some(
        ({ r }) =>
          p.x > r.x - CLEAR &&
          p.x < r.x + r.w + CLEAR &&
          p.y > r.y - CLEAR &&
          p.y < r.y + r.h + CLEAR
      )
  // A band's title strip the point is in: a junction there would hide
  // under the title and start its legs along the strip.
  const strips = (model.rows ?? []).map(titleStrip)
  const stripAt = (p: Pt) =>
    strips.find(
      (r) =>
        p.x > r.x &&
        p.x < r.x + r.w &&
        p.y > r.y - LANE &&
        p.y < r.y + r.h + LANE
    )
  for (const f of model.fans) {
    const tb = rects.get(f.trunk)
    const farR = f.far.map((id) => rects.get(id)).filter((r): r is Rect => !!r)
    if (!tb || !farR.length) continue
    const x0 = Math.min(...farR.map((r) => r.x))
    const y0 = Math.min(...farR.map((r) => r.y))
    const box = {
      x: x0,
      y: y0,
      w: Math.max(...farR.map((r) => r.x + r.w)) - x0,
      h: Math.max(...farR.map((r) => r.y + r.h)) - y0,
    }
    let start = ends?.get(f.id)
    if (!start) {
      const [side] = chooseSides(tb, box)
      start = anchorPoint(
        tb,
        { k: "side", side, off: sideLength(tb, side) / 2 },
        model.mode === "detailed" ? NUB.OUT : 0
      )
    }
    const [nx, ny] = start.dir
    const proj =
      nx > 0.5
        ? box.x - start.x
        : nx < -0.5
          ? start.x - (box.x + box.w)
          : ny > 0.5
            ? box.y - start.y
            : start.y - (box.y + box.h)
    if (proj <= 0 && !overlaps(tb, box)) {
      // The trunk's port faces away from the far cards (a photo's port):
      // straight out from it, the legs would run the whole way back side
      // by side. The trunk goes round instead, to a junction short of the
      // far cards' near side, and the legs fan out from there.
      // On the side the legs' ports leave by, else the one facing back.
      const side = sides?.get(f.id) ?? chooseSides(tb, box)[1]
      const n = SIDE_DIR[side]
      const m = sideMiddle(box, side)
      let e = Math.max(f.legRoom[model.mode], 2 * LANE)
      const past = () => ({ x: m.x + n[0] * e, y: m.y + n[1] * e })
      for (let k = 0; k < 40 && inCard(past()); k++) e += 12
      out.set(f.id, { c: past(), dir: [-n[0], -n[1]], bent: true })
      continue
    }
    // A third of the way, far enough for the trunk's name and chip, and
    // short of the room the legs need. Short of room, the chip gives way
    // first, then the legs' lanes; the trunk's name last.
    const want = f.reach[model.mode]
    // `legRoom` stacks half the legs on each side of the trunk; when more
    // of their cards lie one way, those legs need a lane each there.
    const legNodes = f.legs?.[model.mode] ?? []
    let pos = 0
    let neg = 0
    for (const id of legNodes) {
      const r = rects.get(id)
      if (!r) continue
      const v = (r.x + r.w / 2 - start.x) * -ny + (r.y + r.h / 2 - start.y) * nx
      if (v > 1) pos++
      else if (v < -1) neg++
    }
    const extra =
      Math.max(0, Math.max(pos, neg) - Math.ceil(legNodes.length / 2)) * LANE
    const room = proj - f.legRoom[model.mode] - extra
    const least = Math.min(f.trunkRoom[model.mode], Math.max(12, proj / 2))
    let d = Math.max(Math.min(Math.max(proj / 3, want), room), least)
    if (proj <= 0) d = want
    // Short of a card the trunk would run into on the way (a photo's
    // port facing away from the far cards, with a neighbour below it):
    // the junction stops in front of it rather than beyond it.
    const block = firstHit(solid, start, d + CLEAR + 12, f.trunk)
    if (block !== null && block - CLEAR - 3 >= 12)
      d = Math.min(d, block - CLEAR - 3)
    const at = () => ({ x: start.x + nx * d, y: start.y + ny * d })
    for (let k = 0; k < 40 && inCard(at()); k++) d += 12
    // Down (or up) through a title strip: short of it where the trunk has
    // room, else past it.
    const strip = Math.abs(ny) > 0.5 ? stripAt(at()) : undefined
    if (strip) {
      const near = ny > 0 ? strip.y - LANE : strip.y + strip.h + LANE
      const far = ny > 0 ? strip.y + strip.h + LANE : strip.y - LANE
      const back = (near - start.y) * ny
      const past = (far - start.y) * ny
      const d0 = d
      d = back >= 12 ? back : past
      if (inCard(at())) d = d0
    }
    out.set(f.id, { c: at(), dir: start.dir })
  }
  for (const [id, j] of placeMeshes(model, rects, solid)) out.set(id, j)
  return out
}

/** The side a leg lands on when its card lies ahead along the trunk: the
 * one facing back at the junction. */
const FACING: Partial<Record<string, Side>> = {
  "1,0": "L",
  "-1,0": "R",
  "0,1": "T",
  "0,-1": "B",
}

/** The model's links with each junction end's direction filled in: legs
 * leave along the trunk, the trunk arrives back from its card. A leg to a
 * card ahead along the trunk lands on the side facing back at it, as on
 * the cable page. */
function withJunctionDirs(
  links: readonly AnchorLink[],
  junctions: ReadonlyMap<string, { c: Pt; dir: Dir }>,
  rects: ReadonlyMap<string, Rect>
): AnchorLink[] {
  return links.map((l) => {
    if (!l.junction) return l
    const jb = l.junction.b ? junctions.get(l.target) : undefined
    const ja = l.junction.a ? junctions.get(l.source) : undefined
    let force: AnchorLink["force"] = l.force
    const far = ja ? rects.get(l.target) : undefined
    if (ja && far) {
      const [dx, dy] = ja.dir
      const near =
        dx > 0.5
          ? far.x - ja.c.x
          : dx < -0.5
            ? ja.c.x - (far.x + far.w)
            : dy > 0.5
              ? far.y - ja.c.y
              : ja.c.y - (far.y + far.h)
      const side = FACING[`${Math.round(dx)},${Math.round(dy)}`]
      if (side && near >= 2 * LANE) force = { ...force, b: side }
    }
    // A trunk between two junctions (N:M) leaves its A junction the
    // other way from that junction's legs.
    const both = !!(l.junction.a && l.junction.b)
    const da: Dir | undefined = ja && both ? [-ja.dir[0], -ja.dir[1]] : ja?.dir
    return {
      ...l,
      ...(force ? { force } : {}),
      junction: {
        ...(l.junction.a ? { a: da ?? ([1, 0] as Dir) } : {}),
        ...(l.junction.b
          ? {
              b: jb ? ([-jb.dir[0], -jb.dir[1]] as Dir) : ([-1, 0] as Dir),
            }
          : {}),
      },
    }
  })
}

/** The side of its far cards a breakout's legs all land on, when every
 * one lands on a photo port leaving that way: where a junction whose
 * trunk goes round (placeJunctions) waits for them. */
function legSides(model: DiagramModel, anchors: Anchors): Map<string, Side> {
  const out = new Map<string, Side>()
  for (const f of model.fans) {
    let side: Side | null | undefined
    for (let i = 0; ; i++) {
      const leg = anchors.links.get(`${f.id}:l${i}`)
      if (!leg) break
      for (const b of leg.b) {
        const s = b.k === "point" ? b.exit : null
        side = side === undefined || side === s ? s : null
      }
    }
    if (side) out.set(f.id, side)
  }
  return out
}

/** Each trunk's end at its card, as anchored. */
function trunkEnds(
  model: DiagramModel,
  anchors: Anchors,
  rects: ReadonlyMap<string, Rect>
): Map<string, End> {
  const out = new Map<string, End>()
  for (const f of model.fans) {
    const a = anchors.links.get(`${f.id}:t`)?.a[0]
    const r = rects.get(f.trunk)
    if (!a || !r) continue
    out.set(f.id, anchorPoint(r, a, model.mode === "detailed" ? NUB.OUT : 0))
  }
  return out
}

interface Laid {
  centres: Map<string, Pt>
}

type Size = { w: number; h: number }

/**
 * The card's nubs and box after anchoring, reusing the previous objects
 * when nothing changed - so a drag only re-renders the cards it touched.
 */
function nextShown(
  prev: DiagramCardData["diagram"] | undefined,
  box: CardBox,
  nubs: DiagramCardData["diagram"]["nubs"],
  mode: DiagramMode,
  photo?: PhotoShown
): DiagramCardData["diagram"] {
  if (
    prev &&
    prev.mode === mode &&
    prev.box.w === box.w &&
    prev.box.h === box.h &&
    JSON.stringify(prev.nubs) === JSON.stringify(nubs) &&
    JSON.stringify(prev.photo) === JSON.stringify(photo)
  )
    return prev
  const keep = prev && prev.box.w === box.w && prev.box.h === box.h
  return { box: keep ? prev.box : box, nubs, mode, ...(photo ? { photo } : {}) }
}

/** A photo node's box as the layout and the anchors see it: fixed, the
 * image and its caption. Its text is drawn from `PhotoShown`. */
function photoBox(p: PhotoModel, color?: string | null): CardBox {
  const fill = normalizeHex(color)
  const top = p.face.imgH + PHOTO.CAPTION_GAP
  return {
    w: p.face.w,
    h: p.face.h,
    fill,
    ink: fill ? readableText(fill) : null,
    title: {
      text: p.name,
      size: CARD.TITLE_SIZE,
      weight: CARD.TITLE_WEIGHT,
      x: 0,
      y: top + CARD.TITLE_LH,
      top,
      lh: CARD.TITLE_LH,
      anchor: "start",
      w: 0,
    },
    lines: [],
    pill: null,
    stacked: false,
    nubs: { ...NO_NUBS },
  }
}

/** Each photo node as drawn for where its lines landed. */
function photosShown(
  model: DiagramModel,
  anchors: Anchors
): Map<string, PhotoShown> {
  const out = new Map<string, PhotoShown>()
  const photos = model.photos
  if (!photos?.size) return out
  const ends = new Map<string, Anchor[]>()
  const note = (node: string, list: readonly Anchor[]) => {
    if (!photos.has(node)) return
    const mine = ends.get(node) ?? []
    for (const a of list) if (a.k !== "junction") mine.push(a)
    ends.set(node, mine)
  }
  for (const l of model.links) {
    const a = anchors.links.get(l.id)
    if (!a) continue
    note(l.source, a.a)
    note(l.target, a.b)
  }
  const lod = photoLod(photos.size)
  for (const [id, p] of photos)
    out.set(
      id,
      photoShown(p.face, ends.get(id) ?? [], p.name, p.slot, model.measure, lod)
    )
  return out
}

/** The photo faces the anchoring lands cable ends on: those taking
 * their cables on their ports. */
function facesOf(model: DiagramModel): Map<string, PhotoFace> | undefined {
  const out = new Map<string, PhotoFace>()
  for (const [id, p] of model.photos ?? [])
    if (!p.face.edge) out.set(id, p.face)
  return out.size ? out : undefined
}

/** The photos taking their cables at their edge: anchored on the image,
 * their caption's room under it. */
function capsOf(model: DiagramModel): Map<string, number> | undefined {
  const out = new Map<string, number>()
  for (const [id, p] of model.photos ?? [])
    if (p.face.edge) out.set(id, captionCap(p.face))
  return out.size ? out : undefined
}

interface Anchored {
  anchors: Anchors
  boxes: Map<string, CardBox>
  /** Every node's box, junctions included. */
  rects: Map<string, Rect>
  junctions: Map<string, Junction>
  /** The cyclical links drawn as arcs: their axis and side. */
  arcs: Map<string, { axis: ArcAxis; s: ArcSide }>
}

/** Which cyclical links draw as arcs, and which way, for the cards where
 * they are (`arcFor`). A breakout's legs stay bendy. */
function arcsOf(
  model: DiagramModel,
  rects: ReadonlyMap<string, Rect>,
  solid: Obstacles
): Map<string, { axis: ArcAxis; s: ArcSide }> {
  const out = new Map<string, { axis: ArcAxis; s: ArcSide }>()
  for (const e of model.edges) {
    const d = e.data
    if (e.type !== "link" || !d?.arcAsk || d.line !== "cyclical") continue
    if (d.fan || d.simple || e.source === e.target) continue
    const a = rects.get(e.source)
    const b = rects.get(e.target)
    if (!a || !b) continue
    const arc = arcFor(a, b, {
      always: d.arcAsk.always,
      ...(d.arcAsk.flip ? { flip: d.arcAsk.flip } : {}),
      obs: solid,
      own: [e.source, e.target],
    })
    if (arc) out.set(e.id, arc)
  }
  return out
}

/** Sides pinned by an earlier pass, with each cyclical link's arc sides
 * put in - or, for one that no longer arcs, its arc's pin (one side at
 * both ends) dropped so it chooses again. */
function repin(
  sides: Anchors["sides"] | undefined,
  model: DiagramModel,
  arcs: ReadonlyMap<string, { axis: ArcAxis; s: ArcSide }>
): Anchors["sides"] | undefined {
  if (!sides) return sides
  const out = new Map(sides)
  for (const e of model.edges) {
    if (!e.data?.arcAsk) continue
    const arc = arcs.get(e.id)
    const pin = out.get(e.id)
    if (arc) {
      const side = arcSide(arc.axis, arc.s)
      out.set(e.id, [side, side])
    } else if (pin && pin[0] === pin[1] && e.source !== e.target)
      out.delete(e.id)
  }
  return out
}

/** Anchor every link at the cards' centres. Detailed grows each card to
 * its nubs; `sides` pins the sides an earlier pass chose. Junctions are
 * placed off their trunk's port. */
function anchorAll(
  model: DiagramModel,
  centres: ReadonlyMap<string, Pt>,
  sides?: Anchors["sides"]
): Anchored {
  const boxOf = (id: string) => model.base.get(id) ?? model.fixed.get(id)
  const rects = new Map<string, Rect>()
  for (const [id, c] of centres) {
    const s = boxOf(id)
    if (s) rects.set(id, rectAt(c, s))
  }
  const boxes = new Map(model.base)
  const withJ = (j: Map<string, { c: Pt }>) => {
    const all = new Map(rects)
    for (const [id, { c }] of j) all.set(id, rectAt(c, JUNCTION))
    return all
  }
  let solid = obstacles(rects)
  let junctions = placeJunctions(model, rects, solid)
  const photos = facesOf(model)
  const caps = capsOf(model)
  // An arc leaves both its cards through the side it bulges to.
  const arcs = arcsOf(model, rects, solid)
  const links = arcs.size
    ? model.links.map((l) => {
        const arc = arcs.get(l.id)
        if (!arc) return l
        const side = arcSide(arc.axis, arc.s)
        return { ...l, force: { a: side, b: side } }
      })
    : model.links
  const pass = (mode: DiagramMode, pinned?: Anchors["sides"]) =>
    anchorLinks(
      withJ(junctions),
      withJunctionDirs(links, junctions, rects),
      mode,
      {
        ...(pinned ? { sides: repin(pinned, model, arcs) } : {}),
        blockers: solid,
        ...(mode === "detailed" && model.roomy ? { roomy: model.roomy } : {}),
        ...(photos ? { photos } : {}),
        ...(caps ? { caps } : {}),
        ...(model.nearExits ? { nearExits: true } : {}),
      }
    )
  if (model.mode === "simple") {
    let anchors = pass("simple")
    if (model.fans.length) {
      junctions = placeJunctions(
        model,
        rects,
        solid,
        trunkEnds(model, anchors, rects),
        legSides(model, anchors)
      )
      anchors = pass("simple")
    }
    return { anchors, boxes, rects: withJ(junctions), junctions, arcs }
  }
  const first = pass("detailed", sides)
  for (const [id, input] of model.cards) {
    const demand = first.demand.get(id)
    if (!demand) continue
    const box = cardLayout(input, demand, model.measure)
    boxes.set(id, box)
    const c = centres.get(id)
    if (c) rects.set(id, rectAt(c, box))
  }
  solid = obstacles(rects)
  let anchors = first
  const junctioned = model.fans.length || model.meshes?.length
  if (junctioned)
    junctions = placeJunctions(
      model,
      rects,
      solid,
      trunkEnds(model, first, rects),
      legSides(model, first)
    )
  anchors = pass("detailed", first.sides)
  if (junctioned)
    junctions = placeJunctions(
      model,
      rects,
      solid,
      trunkEnds(model, anchors, rects),
      legSides(model, anchors)
    )
  return { anchors, boxes, rects: withJ(junctions), junctions, arcs }
}

/** The edges with their anchors filled in, and each arc's side. */
function withAnchors(
  model: DiagramModel,
  a: Anchored
): Edge<DiagramEdgeData>[] {
  return model.edges.map((e) => {
    const d = e.data!
    const ends = a.anchors.links.get(e.id)
    if (e.type !== "link" || !ends) return e
    const arc = a.arcs.get(e.id)
    const bent =
      d.fan?.role === "trunk" && !!a.junctions.get(d.fan.junction)?.bent
    return {
      ...e,
      data: {
        ...d,
        a: ends.a,
        b: ends.b,
        ...(model.mode === "simple" ? { simple: true } : {}),
        ...(arc ? { arc: { flip: arc.s, h: 0 } } : {}),
        ...(bent ? { fan: { ...d.fan!, bent: true as const } } : {}),
      },
    }
  })
}

/** Each map's elbow routes, kept across its plans (a drag re-plans only
 * the cables it moved), by the links the model was built with. */
const routeCaches = new WeakMap<readonly AnchorLink[], RouteCache>()

function routeCache(model: DiagramModel): RouteCache {
  let cache = routeCaches.get(model.links)
  if (!cache) routeCaches.set(model.links, (cache = new RouteCache()))
  return cache
}

/**
 * The edges anchored and planned: Detailed nubs re-ordered so elbow
 * routes nest (twice - a side's order moves the far sides' routes), then
 * every line routed, laned and labelled. Mutates `a.anchors` (the nub
 * order).
 */
function plannedEdges(
  model: DiagramModel,
  a: Anchored
): { edges: Edge[]; titles?: Map<string, [number, number][]> } {
  const solid = (id: string) => model.base.has(id) || model.fixed.has(id)
  const strips = (model.rows ?? []).map(
    (r): TitleStrip => ({ id: r.id, r: titleStrip(r), chip: chipBand(r) })
  )
  const input = (edges: Edge<DiagramEdgeData>[]) => ({
    edges,
    rects: a.rects,
    solid,
    mode: model.mode,
    measure: model.measure,
    routes: routeCache(model),
    ...(strips.length ? { strips } : {}),
  })
  let edges = withAnchors(model, a)
  const elbows = edges.filter(
    (e) => e.type === "link" && e.data?.line === "elbow"
  ).length
  // A second pass settles the order a side's reorder moved on the far
  // sides; a big map makes do with one.
  if (model.mode === "detailed" && elbows)
    for (let round = 0; round < (elbows > 400 ? 1 : 2); round++) {
      const { turns } = planEdges(input(edges), { turnsOnly: true })
      if (!reorderNubs(a.anchors, turns)) break
      edges = withAnchors(model, a)
    }
  const { plans, busy } = planEdges(input(edges))
  const planned = edges.map((e) => {
    const plan = plans.get(e.id)
    const s = a.rects.get(e.source)
    const t = a.rects.get(e.target)
    if (!plan || !s || !t) return e
    const d = e.data!
    return {
      ...e,
      data: {
        ...d,
        plan: plan.cables,
        planAt: [s.x, s.y, t.x, t.y] as [number, number, number, number],
        ...(plan.mid ? { labels: { ...d.labels, mid: plan.mid } } : {}),
        ...(plan.midT !== undefined ? { midT: plan.midT } : {}),
        ...(plan.midOff ? { midOff: plan.midOff } : {}),
        ...(plan.crowded ? { crowded: true } : {}),
        ...(plan.arc ? { arc: plan.arc } : {}),
      },
    }
  })
  return { edges: planned, ...(busy ? { titles: busy } : {}) }
}

/** The most links a photo map may have to be planned a second time with
 * its ports leaving by their nearer edges. */
const NEAR_EXIT_CHECK = 600

/** How many times the planned lines cross each other: every pair of
 * runs, curves sampled. */
function crossings(edges: readonly Edge[]): number {
  const runs: [Pt, Pt][] = []
  for (const e of edges) {
    const d = e.data as DiagramEdgeData | undefined
    if (e.type !== "link" || !d?.plan) continue
    for (const c of d.plan) {
      const line = c.line ?? d.line
      let pts = c.pts
      if ((line === "bendy" || line === "cyclical") && pts.length > 2) {
        const route = routeThrough(line, pts, leaves(pts))
        pts = Array.from({ length: 17 }, (_, i) => route.at(i / 16))
      }
      for (let i = 1; i < pts.length; i++) runs.push([pts[i - 1], pts[i]])
    }
  }
  const cross = (p: Pt, q: Pt, r: Pt, s: Pt) => {
    const d = (a: Pt, b: Pt, c: Pt) =>
      (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
    const d1 = d(r, s, p)
    const d2 = d(r, s, q)
    const d3 = d(p, q, r)
    const d4 = d(p, q, s)
    return d1 * d2 < 0 && d3 * d4 < 0
  }
  let n = 0
  for (let i = 0; i < runs.length; i++)
    for (let j = i + 1; j < runs.length; j++)
      if (cross(runs[i][0], runs[i][1], runs[j][0], runs[j][1])) n++
  return n
}

/** Node → the box the layout reserves: a card's current box, else the
 * registered size. */
function sizer(
  boxes: ReadonlyMap<string, { w: number; h: number }>,
  sizeOf: SizeOf
) {
  return (n: Node) => {
    const b = boxes.get(n.id)
    return b ? { width: b.w, height: b.h } : sizeOf(n)
  }
}

/** Detailed cards that grew for their nubs by more than this re-run the
 * layout; smaller growth keeps the first one. */
const REGROW = 4

/** Graph payload → Diagram cards and links, laid out. */
export function buildDiagram(
  graph: TopologyGraph,
  opts: DiagramOptions
): DiagramBuild {
  const measure = opts.measure ?? measureText
  const sizeOf = opts.sizeOf ?? plainSize
  const direction = opts.direction ?? "LR"
  const grouped = graph.nodes.some((n) => n.type === "group")
  // A grouped map is always the Simple picture: one line per group pair.
  const mode: DiagramMode = grouped ? "simple" : opts.mode

  const cards = new Map<string, CardLayoutInput>()
  const base = new Map<string, CardBox>()
  const fixed = new Map<string, { w: number; h: number }>()
  const photos = new Map<string, PhotoModel>()
  const keyOf = new Map<string, string>()
  const rfNodes: Node[] = graph.nodes.map((n) => {
    keyOf.set(n.id, deviceKey(n.id, n.data.device_id))
    const type =
      n.type === "group" ? "sitegroup" : n.type === "device" ? "card" : n.type
    const node: Node = {
      id: n.id,
      type,
      position: { x: 0, y: 0 },
      data: { ...n.data },
    }
    const face = type === "card" ? photoFace(n.data) : null
    if (face) {
      // Drawn as its photo: a fixed box, not a card that grows.
      const content = cardContent(n.data, { checkLabels: opts.checkLabels })
      const p: PhotoModel = {
        face,
        name: content.name,
        slot: content.pillSlot,
      }
      photos.set(n.id, p)
      base.set(n.id, photoBox(p, n.data.role?.color))
    } else if (type === "card") {
      const content = cardContent(n.data, { checkLabels: opts.checkLabels })
      const input: CardLayoutInput = {
        name: content.name,
        color: n.data.role?.color,
        lines: content.lines,
        pillSlot: content.pillSlot,
      }
      cards.set(n.id, input)
      base.set(n.id, cardLayout(input, null, measure))
    } else {
      const s = sizeOf(node)
      fixed.set(n.id, { w: s.width, h: s.height })
    }
    return node
  })
  const key = (id: string) => keyOf.get(id) ?? deviceKey(id)

  // Breakout cables come out of the payload whole, as trunk and legs.
  const device = (id: string) => cards.has(id) || photos.has(id)
  const fans = grouped ? [] : detectFanouts(graph.edges, device)
  const meshes = grouped
    ? []
    : detectMeshes(graph.edges, device, new Set(fans.map((f) => f.cable)))
  const consumed = new Set([
    ...fans.flatMap((f) => f.edges),
    ...meshes.flatMap((m) => m.edges),
  ])
  const parts = fans.map((f) => fanParts(f, key, mode, opts, measure))
  const meshed = meshes.map((m) => meshParts(m, key, mode, opts, measure))

  const { edges: oriented, flipped } = orientHubToLeaf(
    classifyEdges(
      consumed.size
        ? { ...graph, edges: graph.edges.filter((e) => !consumed.has(e.id)) }
        : graph,
      {
        fold: grouped
          ? "none"
          : mode === "simple"
            ? "pair"
            : opts.bundleLags !== false
              ? "lag"
              : "none",
      }
    ).map((c) => diagramEdge(c, key, opts))
  )
  // Twins - two devices of one role with a neighbour in common, like a
  // leaf pair on the same spines - are joined by a peer link (vPC, HA). It
  // does not rank its ends, so the twins share a tier; any other link
  // between devices of one role still ranks them.
  const roleOf = new Map(graph.nodes.map((n) => [n.id, n.data.role?.name]))
  const nbrs = new Map<string, Set<string>>()
  for (const e of oriented) {
    if (e.type !== "link") continue
    ;(nbrs.get(e.source) ?? nbrs.set(e.source, new Set()).get(e.source)!).add(
      e.target
    )
    ;(nbrs.get(e.target) ?? nbrs.set(e.target, new Set()).get(e.target)!).add(
      e.source
    )
  }
  const twins = (a: string, b: string) => {
    const role = roleOf.get(a)
    if (!role || role !== roleOf.get(b)) return false
    const na = nbrs.get(a)
    const nb = nbrs.get(b)
    if (!na || !nb) return false
    for (const x of na) if (x !== b && nb.has(x)) return true
    return false
  }
  const tokens = opts.labels ?? DEFAULT_LABELS
  // A line to a photo's ports lands on its port: one per cable, labels
  // too. A photo taking its cables at its edge folds them like a card.
  const onPorts = (id: string) => {
    const p = photos.get(id)
    return !!p && !p.face.edge
  }
  const onPhoto = (e: { source: string; target: string }) =>
    onPorts(e.source) || onPorts(e.target)
  const edges = [
    ...oriented.map((e0) => {
      const flip = flipped.has(e0.id)
      const e = withLinkLabels(
        flip ? orientData(e0) : e0,
        flip,
        mode,
        tokens,
        onPhoto(e0)
      )
      return e.type === "link" && twins(e.source, e.target)
        ? { ...e, data: { ...e.data!, peer: true } }
        : e
    }),
    ...parts.flatMap((p) => p.edges),
    ...meshed.flatMap((p) => p.edges),
  ]
  const links = [
    ...oriented
      .map((e) => anchorLink(e, flipped.has(e.id)))
      .filter((l): l is AnchorLink => !!l),
    ...parts.flatMap((p) => p.links),
    ...meshed.flatMap((p) => p.links),
  ]

  let levels: Map<string, number> | undefined
  let mainOffsets: number[] | undefined
  if (!grouped && opts.roleOrder?.length)
    ({ levels, mainOffsets } = graphLevels(
      graph.nodes,
      resolveLevels(opts.roleOrder, opts.roleBonds ?? []),
      direction,
      opts.roleDistance
    ))

  // The cards follow the wiring: a BGP session is an overlay on it, and
  // ranking by sessions put a spine a tier below its twin. A breakout
  // counts as a link from its trunk's card to each far card.
  const wiring = [
    ...edges.filter((e) => e.type !== "overlay" && !e.data?.fan),
    ...parts.flatMap((p) => p.layout),
    ...meshed.flatMap((p) => p.layout),
  ]
  // Ranks far enough apart for the labels on the line at both ends of a
  // cable - a port name, then its addresses - and a few lanes between.
  // A map with no labels to show keeps its compact spacing.
  let run = 0
  const degree = new Map<string, number>()
  {
    const ports = tokens.includes("port")
    const width = (t: string) => endTextWidth(t, measure)
    const byId = new Map(edges.map((e) => [e.id, e]))
    for (const l of links) {
      const d = byId.get(l.id)?.data
      const named = ports && (mode === "detailed" || d?.sem === "cable")
      // Simple draws one line per link (its first cable's names), or one
      // per cable to a photo's ports.
      const all = l.cables?.length ? l.cables : [{}]
      const cables = mode === "detailed" || onPhoto(l) ? all : all.slice(0, 1)
      cables.forEach((c, i) => {
        const ends = d?.labels.ends?.[i]
        for (const end of ["a", "b"] as const) {
          const port = named ? c[end] : undefined
          run = Math.max(
            run,
            endRun([...(port ? [port] : []), ...(ends?.[end] ?? [])].map(width))
          )
        }
        for (const n of [l.source, l.target])
          degree.set(n, (degree.get(n) ?? 0) + 1)
      })
    }
  }
  const lanes = Math.min(8, Math.max(2, ...degree.values()))
  // An N:M breakout's two junctions sit between its ends' ranks at the
  // thirds of the gap, each with its legs' room out to its cards and the
  // trunk as long again between them.
  const meshGap = Math.max(0, ...meshed.map((p) => 3 * p.model.reach[mode]))
  const rankGap = Math.max(run ? 2 * portStub(run) + LANE * lanes : 0, meshGap)
  // A photo's cables leave up and down, each with its port name on its
  // run: side by side (LR) photos keep that room above and below them.
  const photoPad = photos.size
    ? direction === "LR"
      ? Math.max(2 * LANE, run ? portStub(run) + 2 * LANE : 0)
      : LANE
    : 0
  const reserve = (boxes: Map<string, { w: number; h: number }>) => {
    if (!photoPad) return boxes
    const out = new Map(boxes)
    for (const id of photos.keys()) {
      const b = boxes.get(id)
      if (b) out.set(id, { w: b.w, h: b.h + 2 * photoPad })
    }
    return out
  }
  const all = reserve(
    new Map<string, { w: number; h: number }>([...fixed, ...base])
  )
  // Devices with no wiring at all are packed apart, under the wired map -
  // not with Levels on (a role's tier holds its devices) or on a grouped
  // map.
  const wired = new Set(wiring.flatMap((e) => [e.source, e.target]))
  const loose =
    grouped || levels
      ? []
      : rfNodes.filter((n) => n.type === "card" && !wired.has(n.id))
  const layout = (boxes: Map<string, { w: number; h: number }>): Laid => {
    // Saved positions are centres; the layout pins top-left corners.
    const pins = opts.positions
      ? Object.fromEntries(
          Object.entries(opts.positions).flatMap(([id, [x, y]]) => {
            const b = boxes.get(id)
            return b
              ? [[id, [x - b.w / 2, y - b.h / 2] as [number, number]]]
              : []
          })
        )
      : undefined
    // Every card placed by hand: nothing to lay out, only to route.
    if (pins && rfNodes.every((n) => n.id in pins)) {
      const centres = new Map<string, Pt>()
      for (const n of rfNodes) {
        const [x, y] = opts.positions![n.id]
        centres.set(n.id, { x, y })
      }
      return { centres }
    }
    // A device placed by hand stays where it was put.
    const packed = new Set(loose.filter((n) => !pins?.[n.id]).map((n) => n.id))
    const rest = packed.size
      ? rfNodes.filter((n) => !packed.has(n.id))
      : rfNodes
    const centres = new Map<string, Pt>()
    if (rest.length) {
      const res = layoutNodes(
        rest,
        wiring,
        // No leaf grids: a straight line from the hub would cross every
        // card stacked in front of the one it serves.
        {
          sizeOf: sizer(boxes, sizeOf),
          compact: mode === "simple",
          leafGrids: false,
          ...(rankGap ? { rankGap } : {}),
          reuseRanks: true,
          waypoints: false,
        },
        pins,
        direction,
        levels,
        mainOffsets
      )
      for (const n of res.nodes) {
        const b = boxes.get(n.id)
        if (b)
          centres.set(n.id, {
            x: n.position.x + b.w / 2,
            y: n.position.y + b.h / 2,
          })
      }
    }
    if (packed.size) {
      let x0 = Infinity
      let y0 = Infinity
      let x1 = -Infinity
      let y1 = -Infinity
      for (const [id, c] of centres) {
        const b = boxes.get(id)
        if (!b) continue
        x0 = Math.min(x0, c.x - b.w / 2)
        y0 = Math.min(y0, c.y - b.h / 2)
        x1 = Math.max(x1, c.x + b.w / 2)
        y1 = Math.max(y1, c.y + b.h / 2)
      }
      const above = x1 > x0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null
      const items = rfNodes.flatMap((n) => {
        const b = packed.has(n.id) ? boxes.get(n.id) : undefined
        if (!b) return []
        const d = n.data as { name?: string; role?: { name?: string } | null }
        return [
          {
            id: n.id,
            group: d.role?.name ?? "",
            name: d.name ?? n.id,
            w: b.w,
            h: b.h,
          },
        ]
      })
      for (const [id, c] of packLoose(items, above)) centres.set(id, c)
    }
    return { centres }
  }

  const model: DiagramModel = {
    mode,
    direction,
    cards,
    base,
    shown: new Map(),
    fixed,
    ...(photos.size ? { photos } : {}),
    links,
    edges,
    fans: parts.map((p) => p.model),
    ...(meshed.length ? { meshes: meshed.map((p) => p.model) } : {}),
    roomy: run && mode === "detailed" ? 2 * portStub(run) : 0,
    measure,
  }

  if (opts.rows?.length) {
    model.rows = opts.rows.map((r) => ({ ...r }))
    model.rowsFrom = rowsSig(opts.rows)
  }
  // A saved arrangement drawn at another size - arranged with Simple
  // cards, drawn Detailed or as photos: the layer bands are re-fitted
  // round their cards first (`fitRows`: a row's cards stay in it), then
  // whatever a photo still covers moves out of its way (nothing else
  // moves). Neither is saved: the arrangement stays the one arranged.
  const settle = (l: Laid, sizes: ReadonlyMap<string, Size>): Laid => {
    if (!opts.positions) return l
    const rectsOf = (centres: ReadonlyMap<string, Pt>) => {
      const rects: Record<string, Rect> = {}
      for (const [id, c] of centres) {
        const b = sizes.get(id)
        if (b) rects[id] = rectAt(c, b)
      }
      return rects
    }
    let centres = l.centres
    if (opts.rows?.length) {
      const fit = fitRows(opts.rows, rectsOf(centres))
      model.rows = fit.rows
      const moved = Object.entries(fit.moves)
      if (moved.length) {
        centres = new Map(centres)
        for (const [id, [x, y]] of moved) centres.set(id, { x, y })
      }
    }
    if (photos.size) {
      const moved = settleGrown(rectsOf(centres), photos.keys())
      if (moved) {
        centres = new Map(centres)
        for (const [id, [x, y]] of Object.entries(moved))
          centres.set(id, { x, y })
      }
    }
    return centres === l.centres ? l : { centres }
  }

  let laid = settle(layout(all), new Map<string, Size>([...fixed, ...base]))
  let anchored = anchorAll(model, laid.centres)
  if (mode === "detailed") {
    // The cards grew to fit their nubs: lay out again with the real
    // boxes, keeping the sides the nubs were counted for - unless nothing
    // grew enough to matter.
    const grew = [...anchored.boxes].some(([id, b]) => {
      const was = base.get(id)
      return !!was && (b.w - was.w > REGROW || b.h - was.h > REGROW)
    })
    if (grew) {
      const sized = reserve(
        new Map<string, { w: number; h: number }>([...fixed, ...anchored.boxes])
      )
      laid = settle(
        layout(sized),
        new Map<string, Size>([...fixed, ...anchored.boxes])
      )
      anchored = anchorAll(model, laid.centres, anchored.anchors.sides)
    }
  }

  let { edges: planned, titles } = plannedEdges(model, anchored)
  // Photo ports leave towards their far ends, which mostly untangles a
  // photo map - but not always: a map small enough to plan twice is also
  // planned with every port leaving by its nearer edge, and keeps that
  // when its lines cross less.
  if (facesOf(model) && model.links.length <= NEAR_EXIT_CHECK) {
    const near: DiagramModel = { ...model, nearExits: true }
    const again = anchorAll(near, laid.centres)
    const alt = plannedEdges(near, again)
    if (crossings(alt.edges) < crossings(planned)) {
      model.nearExits = true
      anchored = again
      planned = alt.edges
      titles = alt.titles
    }
  }
  if (titles) model.titles = titles
  const { anchors, boxes, junctions } = anchored
  const drawn = photosShown(model, anchors)
  const nodes: Node[] = rfNodes.map((n) => {
    const c = laid.centres.get(n.id) ?? { x: 0, y: 0 }
    const box = boxes.get(n.id) ?? fixed.get(n.id)!
    const common = {
      ...n,
      position: c,
      origin: CENTRE,
      width: box.w,
      height: box.h,
      selected: opts.focusNodeId === n.id,
    }
    const dimmed = opts.matched ? !opts.matched.has(n.id) : false
    if (n.type !== "card") return { ...common, data: { ...n.data, dimmed } }
    const shown = nextShown(
      undefined,
      boxes.get(n.id)!,
      anchors.nubs.get(n.id) ?? [],
      mode,
      drawn.get(n.id)
    )
    model.shown.set(n.id, shown)
    return {
      ...common,
      data: { ...n.data, dimmed, diagram: shown } as DiagramCardData,
    }
  })
  for (const n of [
    ...parts.map((p) => p.node),
    ...meshed.flatMap((p) => p.nodes),
  ]) {
    const j = junctions.get(n.id)
    nodes.push(j ? { ...n, position: j.c } : { ...n, hidden: true })
  }

  return { nodes, edges: planned, model }
}

export interface Relinked {
  edges: Edge[]
  /** Per band row, what its title strip holds (`DiagramModel.titles`). */
  titles?: Map<string, [number, number][]>
  /** Cards whose box or nubs changed, by id. */
  cards: Map<string, DiagramCardData["diagram"]>
  /** Where each breakout's junction now sits (its centre). */
  junctions: Map<string, Pt>
  model: DiagramModel
}

/**
 * Re-anchor every link for the nodes where they now are (after a drag):
 * sides re-chosen, Detailed nubs re-counted and cards re-sized around
 * their centres, junctions re-placed, every line planned again. No layout
 * runs; `live` nodes are positioned by their centres, as `buildDiagram`
 * made them.
 */
export function relinkDiagram(model: DiagramModel, live: Node[]): Relinked {
  const centres = new Map<string, Pt>()
  for (const n of live)
    if (model.base.has(n.id) || model.fixed.has(n.id))
      centres.set(n.id, { x: n.position.x, y: n.position.y })
  const anchored = anchorAll(model, centres)
  const { edges, titles } = plannedEdges(model, anchored)
  const { anchors, boxes } = anchored

  const cards = new Map<string, DiagramCardData["diagram"]>()
  const shown = new Map(model.shown)
  const drawn = photosShown(model, anchors)
  for (const [id, box] of boxes) {
    if (!centres.has(id)) continue
    const prev = model.shown.get(id)
    const next = nextShown(
      prev,
      box,
      anchors.nubs.get(id) ?? [],
      model.mode,
      drawn.get(id)
    )
    if (next !== prev) {
      cards.set(id, next)
      shown.set(id, next)
    }
  }
  const junctions = new Map<string, Pt>()
  for (const [id, j] of anchored.junctions) junctions.set(id, j.c)
  const next: DiagramModel = { ...model, shown, ...(titles ? { titles } : {}) }
  return { edges, cards, junctions, model: next, ...(titles ? { titles } : {}) }
}

/**
 * The cards measured again - Inter has loaded since they were sized -
 * and every link re-anchored where the cards are. No layout runs.
 */
export function remeasureDiagram(model: DiagramModel, live: Node[]): Relinked {
  const base = new Map(model.base)
  for (const [id, input] of model.cards)
    base.set(id, cardLayout(input, null, model.measure))
  return relinkDiagram({ ...model, base, shown: new Map() }, live)
}

/**
 * The room Arrange ▸ Bands keeps for a Detailed map's end labels
 * (bands.ts `LabelRoom`): the straight run out of a nub the longest port
 * name and addresses take - the gap `roomy` asks between two facing
 * sides, halved - the cards cabled to each other (a breakout's trunk card
 * to each of its far cards), and the lanes the cables between two rows
 * turn in. Null when no nub carries a label (Simple, or nothing to show).
 */
export function labelRoom(model: DiagramModel): LabelRoom | null {
  if (model.mode !== "detailed" || !model.roomy) return null
  const links: [string, string][] = []
  // Lanes as the layout keeps them between ranks: a few, more for the
  // busiest card.
  const degree = new Map<string, number>()
  const count = (id: string, n: number) =>
    degree.set(id, (degree.get(id) ?? 0) + n)
  for (const l of model.links) {
    if (l.simple) continue
    const n = Math.max(1, l.cables?.length ?? 0)
    count(l.source, n)
    count(l.target, n)
    if (model.base.has(l.source) && model.base.has(l.target))
      links.push([l.source, l.target])
  }
  for (const f of model.fans) for (const c of f.far) links.push([f.trunk, c])
  for (const m of model.meshes ?? [])
    for (const a of m.a) for (const b of m.b) links.push([a, b])
  const lanes = Math.min(8, Math.max(2, ...degree.values()))
  // A breakout's legs turn off from its junction in lanes of their own.
  const legs = Math.max(
    0,
    ...model.fans.map((f) => f.legRoom.detailed),
    ...(model.meshes ?? []).map((m) => m.reach.detailed)
  )
  return {
    stub: model.roomy / 2,
    links,
    lanes: LANE * lanes,
    ...(legs ? { legs } : {}),
  }
}
