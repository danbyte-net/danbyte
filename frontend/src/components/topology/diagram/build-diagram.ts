import type { Edge, Node } from "@xyflow/react"

import type { TopologyGraph, TopologyLinkOverride } from "@/lib/api"
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
import { layoutNodes } from "../layout"
import { resolveLevels } from "../level-organiser"
import { graphLevels } from "../levels-param"
import { sizeOf } from "../node-registry"
import {
  anchorLinks,
  anchorPoint,
  chooseSides,
  reorderNubs,
  sideLength,
} from "./anchors"
import type { AnchorLink, Anchors } from "./anchors"
import { arcFor, arcSide } from "./arcs"
import type { ArcAxis, ArcSide } from "./arcs"
import { cardContent } from "./card-fields"
import { cardLayout, JUNCTION, NUB } from "./card-layout"
import type { CardBox, CardLayoutInput } from "./card-layout"
import { detectFanouts, fanChip } from "./fanout"
import type { Fan } from "./fanout"
import { CLEAR, LANE, obstacles, SHARED_STUB } from "./lanes"
import type { Obstacles } from "./lanes"
import {
  DEFAULT_LABELS,
  fanLabelSets,
  hasLabels,
  linkLabelSet,
  orientPair,
} from "./link-labels"
import type { LabelToken, LinkLabelSet } from "./link-labels"
import { planEdges, portStub } from "./plan"
import { pairKey } from "./types"
import type {
  CablePair,
  DiagramCardData,
  DiagramEdgeData,
  DiagramMode,
  Dir,
  End,
  LineType,
  LinkLabels,
  Pt,
  Rect,
  Side,
} from "./types"

// The Diagram tab's pipeline: payload graph → React Flow cards and links.
//
//   1. classify and fold the edges, orient them hub → leaf;
//   2. size each card from its text (Simple's compact box);
//   3. lay out (dagre, or the saved arrangement);
//   4. Detailed: count each card's nubs per side, grow the cards to fit,
//      lay out again with the real boxes, and anchor every cable end;
//   5. plan every line (plan.ts): elbows in their own lanes clear of the
//      cards, cyclical arcs round the cards between their ends, port names
//      along their cables, middle chips off the cards, end addresses.
//
// Cyclical links are settled before anchoring: which draw as arcs (the
// link's own line always does; the view's default only between level
// cards whose straight line would cross one) and to which side, since an
// arc's ends leave through the side it bulges to.
//
// A breakout cable (fanout.ts) is drawn as one trunk from its shared port
// to a junction node, then one leg to each far port.
//
// Diagram nodes are positioned by their CENTRE (React Flow `origin`
// [0.5, 0.5]), so a card that grows to fit its nubs - or shrinks back in
// Simple mode - stays where it was put, and one saved arrangement serves
// both modes.

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
  matched?: Set<string> | null
  focusNodeId?: string
  /** The tenant's names for the monitoring states: a card keeps room for
   * the pill as it will read. */
  checkLabels?: Partial<Record<"down" | "degraded", string>>
  measure?: Measure
}

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
  /** Other nodes' boxes (group cards, trace ports). */
  fixed: Map<string, { w: number; h: number }>
  /** The links anchored to card sides. */
  links: AnchorLink[]
  /** Every edge as built, before anchoring. */
  edges: Edge<DiagramEdgeData>[]
  /** Breakout cables: where their junctions go. */
  fans: FanModel[]
  /** Detailed: the gap two facing sides should leave for a port name at
   * each end of a cable. */
  roomy: number
  measure: Measure
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
   * mode: their lanes and far port names. */
  legRoom: Record<DiagramMode, number>
  /** The trunk's own port name, per mode: what the junction keeps room
   * for before the legs' room. */
  trunkRoom: Record<DiagramMode, number>
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
function bundleLabel(n: number, lag: EdgeLag | null): string[] {
  if (n < 2) return []
  const count = `${n}x`
  return [lag?.a && lag.b ? `${lag.a.name} ⇄ ${lag.b.name} · ${count}` : count]
}

type Pair = NonNullable<BundleMember["pairs"]>[number]

/** One `{a, b}` port per cable pair, oriented to the edge's ends. */
function cablesOf(
  pairs: readonly Pair[],
  flipped: boolean
): { a?: string; b?: string }[] {
  return pairs.map((p) => {
    const a = p.a_port ?? p.a
    const b = p.b_port ?? p.b
    return flipped ? { a: b, b: a } : { a, b }
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
 * each has its own nub (Detailed), one set for the one line of Simple. */
function withLinkLabels(
  e: Edge<DiagramEdgeData>,
  flipped: boolean,
  mode: DiagramMode,
  tokens: readonly LabelToken[]
): Edge<DiagramEdgeData> {
  const d = e.data
  if (e.type !== "link" || !d || d.simple) return e
  if (d.sem !== "cable" && d.sem !== "lagbundle" && d.sem !== "bundle") return e
  const pairs = linkPairs(d, flipped)
  const set = pairs.length
    ? linkLabelSet(
        mode === "detailed" ? pairs.map((p) => [p]) : [pairs],
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
            ports: mine.map((l) => l.port),
            pairs: mine.flatMap((l) => l.pairs ?? []),
          }
        })
      : f.legs.map((l) => ({
          node: l.node,
          ports: [l.port],
          pairs: l.pairs ?? [],
        }))
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
        fan: { role: "leg", junction: f.id },
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
      cables: [{ a: f.trunk.port }],
      ...(mode === "simple" ? { simple: true } : {}),
      junction: { b: [0, 0] },
    },
    ...legEdges.map(
      (e, i): AnchorLink => ({
        id: e.id,
        source: e.source,
        target: e.target,
        cables: [{ b: legs[i].ports.join(", ") }],
        ...(mode === "simple" ? { simple: true } : {}),
        junction: { a: [0, 0] },
      })
    ),
  ]
  const chipW = chip.length
    ? measure(chip[0], LABEL.MID_SIZE, 600) + 2 * LABEL.PAD_X
    : 0
  const portW = measure(f.trunk.port, LABEL.END_SIZE, 400)
  const legW = Math.max(
    0,
    ...f.legs.map((l) => measure(l.port, LABEL.END_SIZE, 400))
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
        detailed: Math.max(24, portStub(portW) + (chipW ? chipW + 8 : 0)),
      },
      // Legs turn off both ways, so half of them stack up on one side.
      legRoom: {
        simple: SHARED_STUB + LANE * Math.ceil(far.length / 2) + 16,
        detailed:
          SHARED_STUB + LANE * Math.ceil(f.legs.length / 2) + portStub(legW),
      },
      trunkRoom: { simple: 24, detailed: portStub(portW) },
    },
  }
}

const rectAt = (c: Pt, s: { w: number; h: number }): Rect => ({
  x: c.x - s.w / 2,
  y: c.y - s.h / 2,
  w: s.w,
  h: s.h,
})

/** Where each breakout's junction goes: straight out from its trunk's
 * port (`trunkEnds`, else the side facing the far cards' midpoint), a
 * third of the way to the far cards but far enough for the trunk's port
 * name and chip, and clear of every card. */
function placeJunctions(
  model: DiagramModel,
  rects: ReadonlyMap<string, Rect>,
  solid: Obstacles,
  ends?: ReadonlyMap<string, End>
): Map<string, { c: Pt; dir: Dir }> {
  const out = new Map<string, { c: Pt; dir: Dir }>()
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
    // A third of the way, far enough for the trunk's name and chip, and
    // short of the room the legs need. Short of room, the chip gives way
    // first, then the legs' lanes; the trunk's name last.
    const want = f.reach[model.mode]
    const room = proj - f.legRoom[model.mode]
    const least = Math.min(f.trunkRoom[model.mode], Math.max(12, proj / 2))
    let d = Math.max(Math.min(Math.max(proj / 3, want), room), least)
    if (proj <= 0) d = want
    const at = () => ({ x: start.x + nx * d, y: start.y + ny * d })
    for (let k = 0; k < 40; k++) {
      const p = at()
      const inCard = solid
        .near({ x: p.x - 1, y: p.y - 1, w: 2, h: 2 })
        .some(
          ({ r }) =>
            p.x > r.x - CLEAR &&
            p.x < r.x + r.w + CLEAR &&
            p.y > r.y - CLEAR &&
            p.y < r.y + r.h + CLEAR
        )
      if (!inCard) break
      d += 12
    }
    out.set(f.id, { c: at(), dir: start.dir })
  }
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
    return {
      ...l,
      ...(force ? { force } : {}),
      junction: {
        ...(l.junction.a ? { a: ja?.dir ?? ([1, 0] as Dir) } : {}),
        ...(l.junction.b
          ? {
              b: jb ? ([-jb.dir[0], -jb.dir[1]] as Dir) : ([-1, 0] as Dir),
            }
          : {}),
      },
    }
  })
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

/**
 * The card's nubs and box after anchoring, reusing the previous objects
 * when nothing changed - so a drag only re-renders the cards it touched.
 */
function nextShown(
  prev: DiagramCardData["diagram"] | undefined,
  box: CardBox,
  nubs: DiagramCardData["diagram"]["nubs"],
  mode: DiagramMode
): DiagramCardData["diagram"] {
  if (
    prev &&
    prev.mode === mode &&
    prev.box.w === box.w &&
    prev.box.h === box.h &&
    JSON.stringify(prev.nubs) === JSON.stringify(nubs)
  )
    return prev
  const keep = prev && prev.box.w === box.w && prev.box.h === box.h
  return { box: keep ? prev.box : box, nubs, mode }
}

interface Anchored {
  anchors: Anchors
  boxes: Map<string, CardBox>
  /** Every node's box, junctions included. */
  rects: Map<string, Rect>
  junctions: Map<string, { c: Pt; dir: Dir }>
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
      }
    )
  if (model.mode === "simple") {
    let anchors = pass("simple")
    if (model.fans.length) {
      junctions = placeJunctions(
        model,
        rects,
        solid,
        trunkEnds(model, anchors, rects)
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
  if (model.fans.length)
    junctions = placeJunctions(
      model,
      rects,
      solid,
      trunkEnds(model, first, rects)
    )
  anchors = pass("detailed", first.sides)
  if (model.fans.length)
    junctions = placeJunctions(
      model,
      rects,
      solid,
      trunkEnds(model, anchors, rects)
    )
  return { anchors, boxes, rects: withJ(junctions), junctions, arcs }
}

/** The edges with their anchors filled in, and each arc's side. */
function withAnchors(
  model: DiagramModel,
  anchors: Anchors,
  arcs: Anchored["arcs"]
): Edge<DiagramEdgeData>[] {
  return model.edges.map((e) => {
    const d = e.data!
    const ends = anchors.links.get(e.id)
    if (e.type !== "link" || !ends) return e
    const arc = arcs.get(e.id)
    return {
      ...e,
      data: {
        ...d,
        a: ends.a,
        b: ends.b,
        ...(model.mode === "simple" ? { simple: true } : {}),
        ...(arc ? { arc: { flip: arc.s, h: 0 } } : {}),
      },
    }
  })
}

/**
 * The edges anchored and planned: Detailed nubs re-ordered so elbow
 * routes nest (twice - a side's order moves the far sides' routes), then
 * every line routed, laned and labelled. Mutates `a.anchors` (the nub
 * order).
 */
function plannedEdges(model: DiagramModel, a: Anchored): Edge[] {
  const solid = (id: string) => model.base.has(id) || model.fixed.has(id)
  const input = (edges: Edge<DiagramEdgeData>[]) => ({
    edges,
    rects: a.rects,
    solid,
    mode: model.mode,
    measure: model.measure,
  })
  let edges = withAnchors(model, a.anchors, a.arcs)
  const elbows = edges.filter(
    (e) => e.type === "link" && e.data?.line === "elbow"
  ).length
  // A second pass settles the order a side's reorder moved on the far
  // sides; a big map makes do with one.
  if (model.mode === "detailed" && elbows)
    for (let round = 0; round < (elbows > 400 ? 1 : 2); round++) {
      const { turns } = planEdges(input(edges), { turnsOnly: true })
      if (!reorderNubs(a.anchors, turns)) break
      edges = withAnchors(model, a.anchors, a.arcs)
    }
  const { plans } = planEdges(input(edges))
  return edges.map((e) => {
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
}

/** Node → the box the layout reserves: a card's current box, else the
 * registered size. */
function sizer(boxes: ReadonlyMap<string, { w: number; h: number }>) {
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
  const direction = opts.direction ?? "LR"
  const grouped = graph.nodes.some((n) => n.type === "group")
  // A grouped map is always the Simple picture: one line per group pair.
  const mode: DiagramMode = grouped ? "simple" : opts.mode

  const cards = new Map<string, CardLayoutInput>()
  const base = new Map<string, CardBox>()
  const fixed = new Map<string, { w: number; h: number }>()
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
    if (type === "card") {
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
  const fans = grouped ? [] : detectFanouts(graph.edges, (id) => cards.has(id))
  const consumed = new Set(fans.flatMap((f) => f.edges))
  const parts = fans.map((f) => fanParts(f, key, mode, opts, measure))

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
  const edges = [
    ...oriented.map((e0) => {
      const flip = flipped.has(e0.id)
      const e = withLinkLabels(flip ? orientData(e0) : e0, flip, mode, tokens)
      return e.type === "link" && twins(e.source, e.target)
        ? { ...e, data: { ...e.data!, peer: true } }
        : e
    }),
    ...parts.flatMap((p) => p.edges),
  ]
  const links = [
    ...oriented
      .map((e) => anchorLink(e, flipped.has(e.id)))
      .filter((l): l is AnchorLink => !!l),
    ...parts.flatMap((p) => p.links),
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
  ]
  // Detailed: ranks far enough apart for a port name (and the addresses
  // beside it) at both ends of a cable, and a few lanes between them.
  let widest = 0
  const degree = new Map<string, number>()
  if (mode === "detailed") {
    const ports = tokens.includes("port")
    for (const l of links)
      for (const c of l.cables?.length ? l.cables : [{}]) {
        if (ports)
          for (const p of [c.a, c.b])
            if (p) widest = Math.max(widest, measure(p, LABEL.END_SIZE, 400))
        for (const n of [l.source, l.target])
          degree.set(n, (degree.get(n) ?? 0) + 1)
      }
    for (const e of edges)
      for (const end of e.data?.labels.ends ?? [])
        for (const ip of [...(end.a ?? []), ...(end.b ?? [])])
          widest = Math.max(widest, measure(ip, LABEL.END_SIZE, 400))
  }
  const lanes = Math.min(8, Math.max(2, ...degree.values()))
  const rankGap = widest ? 2 * portStub(widest) + LANE * lanes : 0
  const all = new Map<string, { w: number; h: number }>([...fixed, ...base])
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
    const res = layoutNodes(
      rfNodes,
      wiring,
      // No leaf grids: a straight line from the hub would cross every
      // card stacked in front of the one it serves.
      {
        sizeOf: sizer(boxes),
        compact: mode === "simple",
        leafGrids: false,
        ...(rankGap ? { rankGap } : {}),
      },
      pins,
      direction,
      levels,
      mainOffsets
    )
    const centres = new Map<string, Pt>()
    for (const n of res.nodes) {
      const b = boxes.get(n.id)
      if (b)
        centres.set(n.id, {
          x: n.position.x + b.w / 2,
          y: n.position.y + b.h / 2,
        })
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
    links,
    edges,
    fans: parts.map((p) => p.model),
    roomy: widest ? 2 * portStub(widest) : 0,
    measure,
  }

  let laid = layout(all)
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
      const sized = new Map<string, { w: number; h: number }>([
        ...fixed,
        ...anchored.boxes,
      ])
      laid = layout(sized)
      anchored = anchorAll(model, laid.centres, anchored.anchors.sides)
    }
  }

  const planned = plannedEdges(model, anchored)
  const { anchors, boxes, junctions } = anchored
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
      mode
    )
    model.shown.set(n.id, shown)
    return {
      ...common,
      data: { ...n.data, dimmed, diagram: shown } as DiagramCardData,
    }
  })
  for (const p of parts) {
    const j = junctions.get(p.node.id)
    nodes.push(j ? { ...p.node, position: j.c } : { ...p.node, hidden: true })
  }

  return { nodes, edges: planned, model }
}

export interface Relinked {
  edges: Edge[]
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
  const edges = plannedEdges(model, anchored)
  const { anchors, boxes } = anchored

  const cards = new Map<string, DiagramCardData["diagram"]>()
  const shown = new Map(model.shown)
  for (const [id, box] of boxes) {
    if (!centres.has(id)) continue
    const prev = model.shown.get(id)
    const next = nextShown(prev, box, anchors.nubs.get(id) ?? [], model.mode)
    if (next !== prev) {
      cards.set(id, next)
      shown.set(id, next)
    }
  }
  const junctions = new Map<string, Pt>()
  for (const [id, j] of anchored.junctions) junctions.set(id, j.c)
  const next: DiagramModel = { ...model, shown }
  return { edges, cards, junctions, model: next }
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
