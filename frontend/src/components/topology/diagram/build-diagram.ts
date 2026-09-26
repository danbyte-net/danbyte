import type { Edge, Node } from "@xyflow/react"

import type { TopologyGraph, TopologyLinkOverride } from "@/lib/api"
import { measureText } from "@/lib/diagram/measure"
import type { Measure } from "@/lib/diagram/measure"
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
import { edgeWaypoints, layoutNodes } from "../layout"
import { resolveLevels } from "../level-organiser"
import { graphLevels } from "../levels-param"
import { sizeOf } from "../node-registry"
import { anchorLinks } from "./anchors"
import type { AnchorLink, Anchors } from "./anchors"
import { cardContent } from "./card-fields"
import { cardLayout } from "./card-layout"
import type { CardBox, CardLayoutInput } from "./card-layout"
import { pairKey } from "./types"
import type {
  DiagramCardData,
  DiagramEdgeData,
  DiagramMode,
  LineType,
  Pt,
  Rect,
} from "./types"

// The Diagram tab's pipeline: payload graph → React Flow cards and links.
//
//   1. classify and fold the edges, orient them hub → leaf;
//   2. size each card from its text (Simple's compact box);
//   3. lay out (dagre, or the saved arrangement);
//   4. Detailed: count each card's nubs per side, grow the cards to fit,
//      lay out again with the real boxes, and anchor every cable end;
//   5. hand the elbow lines their node-avoiding channel.
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
  measure: Measure
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
      const r = c.raw
      const n = r?.pairs?.length ?? 1
      return {
        ...ends,
        type: "link",
        animated: r?.marked,
        data: {
          ...base("cable", lineOf()),
          raw: r,
          ...(n > 1 ? { labels: { mid: [`${n}x`] } } : {}),
        },
        ...flowEdgeStyle(
          edgeLook("cable", {
            stroke: edgeStroke(r, opts.colorMode),
            count: n,
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
          labels: { mid: bundleLabel(c.cables.length, c.lag) },
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
          labels: { mid: bundleLabel(c.cables.length, lag) },
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
              mid: bundleLabel(d.cables?.length ?? 1, lag),
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

const rectAt = (c: Pt, s: { w: number; h: number }): Rect => ({
  x: c.x - s.w / 2,
  y: c.y - s.h / 2,
  w: s.w,
  h: s.h,
})

interface Laid {
  centres: Map<string, Pt>
  waypoints: Map<string, [number, number][]>
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

/** Anchor every link at the cards' centres. Detailed grows each card to
 * its nubs; `sides` pins the sides an earlier pass chose. */
function anchorAll(
  model: DiagramModel,
  centres: ReadonlyMap<string, Pt>,
  sides?: Anchors["sides"]
): { anchors: Anchors; boxes: Map<string, CardBox> } {
  const boxOf = (id: string) => model.base.get(id) ?? model.fixed.get(id)
  const rects = new Map<string, Rect>()
  for (const [id, c] of centres) {
    const s = boxOf(id)
    if (s) rects.set(id, rectAt(c, s))
  }
  const boxes = new Map(model.base)
  if (model.mode === "simple")
    return { anchors: anchorLinks(rects, model.links, "simple"), boxes }
  const first = anchorLinks(rects, model.links, "detailed", {
    ...(sides ? { sides } : {}),
  })
  for (const [id, input] of model.cards) {
    const demand = first.demand.get(id)
    if (!demand) continue
    const box = cardLayout(input, demand, model.measure)
    boxes.set(id, box)
    const c = centres.get(id)
    if (c) rects.set(id, rectAt(c, box))
  }
  return {
    anchors: anchorLinks(rects, model.links, "detailed", {
      sides: first.sides,
    }),
    boxes,
  }
}

/** The edges with their anchors and elbow channels filled in. */
function anchoredEdges(
  model: DiagramModel,
  anchors: Anchors,
  topLeft: ReadonlyMap<string, Pt>,
  waypoints: ReadonlyMap<string, [number, number][]>
): Edge[] {
  return model.edges.map((e) => {
    const d = e.data!
    const ends = anchors.links.get(e.id)
    if (e.type !== "link" || !ends) return e
    const wp = d.line === "elbow" ? waypoints.get(e.id) : undefined
    const s = topLeft.get(e.source)
    const t = topLeft.get(e.target)
    return {
      ...e,
      data: {
        ...d,
        a: ends.a,
        b: ends.b,
        ...(model.mode === "simple" ? { simple: true } : {}),
        ...(wp && wp.length >= 2 && s && t
          ? {
              wp: wp.slice(0, 2).map(([x, y]) => ({ x, y })),
              wpAt: [s.x, s.y, t.x, t.y] as [number, number, number, number],
            }
          : {}),
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

  const { edges: oriented, flipped } = orientHubToLeaf(
    classifyEdges(graph, {
      fold: grouped
        ? "none"
        : mode === "simple"
          ? "pair"
          : opts.bundleLags !== false
            ? "lag"
            : "none",
    }).map((c) => diagramEdge(c, key, opts))
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
  const edges = oriented.map((e0) => {
    const e = flipped.has(e0.id) ? orientData(e0) : e0
    return e.type === "link" && twins(e.source, e.target)
      ? { ...e, data: { ...e.data!, peer: true } }
      : e
  })
  const links = edges
    .map((e) => anchorLink(e, flipped.has(e.id)))
    .filter((l): l is AnchorLink => !!l)

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
  // ranking by sessions put a spine a tier below its twin.
  const wiring = edges.filter((e) => e.type !== "overlay")
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
      const placed = rfNodes.map((n) => {
        const [x, y] = pins[n.id]
        return { ...n, position: { x, y } }
      })
      return {
        centres,
        waypoints: edgeWaypoints(placed, wiring, sizer(boxes), direction),
      }
    }
    const res = layoutNodes(
      rfNodes,
      wiring,
      // No leaf grids: a straight line from the hub would cross every
      // card stacked in front of the one it serves.
      { sizeOf: sizer(boxes), compact: mode === "simple", leafGrids: false },
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
    return { centres, waypoints: res.waypoints }
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
    measure,
  }

  let laid = layout(all)
  let { anchors, boxes } = anchorAll(model, laid.centres)
  if (mode === "detailed") {
    // The cards grew to fit their nubs: lay out again with the real
    // boxes, keeping the sides the nubs were counted for.
    const sized = new Map<string, { w: number; h: number }>([
      ...fixed,
      ...boxes,
    ])
    laid = layout(sized)
    ;({ anchors, boxes } = anchorAll(model, laid.centres, anchors.sides))
  }

  const topLeft = new Map<string, Pt>()
  const nodes = rfNodes.map((n) => {
    const c = laid.centres.get(n.id) ?? { x: 0, y: 0 }
    const box = boxes.get(n.id) ?? fixed.get(n.id)!
    topLeft.set(n.id, { x: c.x - box.w / 2, y: c.y - box.h / 2 })
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

  return {
    nodes,
    edges: anchoredEdges(model, anchors, topLeft, laid.waypoints),
    model,
  }
}

export interface Relinked {
  edges: Edge[]
  /** Cards whose box or nubs changed, by id. */
  cards: Map<string, DiagramCardData["diagram"]>
  model: DiagramModel
}

/**
 * Re-anchor every link for the nodes where they now are (after a drag):
 * sides re-chosen, Detailed nubs re-counted and cards re-sized around
 * their centres, elbow channels re-routed. No layout runs; `live` nodes are
 * positioned by their centres, as `buildDiagram` made them.
 */
export function relinkDiagram(model: DiagramModel, live: Node[]): Relinked {
  const centres = new Map<string, Pt>()
  for (const n of live)
    if (model.base.has(n.id) || model.fixed.has(n.id))
      centres.set(n.id, { x: n.position.x, y: n.position.y })
  const { anchors, boxes } = anchorAll(model, centres)

  const topLeft = new Map<string, Pt>()
  const sizes = new Map<string, { w: number; h: number }>()
  for (const [id, c] of centres) {
    const b = boxes.get(id) ?? model.fixed.get(id)!
    sizes.set(id, b)
    topLeft.set(id, { x: c.x - b.w / 2, y: c.y - b.h / 2 })
  }
  const elbows = model.edges.filter(
    (e) => e.type === "link" && e.data!.line === "elbow"
  )
  const waypoints = elbows.length
    ? edgeWaypoints(
        live
          .filter((n) => topLeft.has(n.id))
          .map((n) => ({ ...n, position: topLeft.get(n.id)! })),
        elbows,
        sizer(sizes),
        model.direction
      )
    : new Map<string, [number, number][]>()

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
  const next: DiagramModel = { ...model, shown }
  return {
    edges: anchoredEdges(next, anchors, topLeft, waypoints),
    cards,
    model: next,
  }
}
