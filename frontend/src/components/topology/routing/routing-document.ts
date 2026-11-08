import type {
  RoutingCardField,
  RoutingEdge,
  RoutingLayer,
  RoutingTopology,
} from "@/lib/api"
import type { LegendItem } from "@/components/map-legend"
import { documentBounds } from "@/lib/diagram/geometry"
import { measureText } from "@/lib/diagram/measure"
import type { Measure } from "@/lib/diagram/measure"
import type {
  DiagramDocument,
  DiagramLink,
  DiagramNode,
} from "@/lib/diagram/types"
import { cardLayout } from "../diagram/card-layout"
import type { CardLayoutInput } from "../diagram/card-layout"
import { linkRoute } from "../diagram/link-geometry"
import {
  cardNode,
  danbyteUrl,
  endSide,
  fitBox,
  regionBands,
  routeLink,
} from "../diagram/to-document"
import type { DocumentOptions } from "../diagram/to-document"
import type { Dir, Pt, Rect } from "../diagram/types"
import { groupBox } from "../group-size"
import type { PosMap, Zone } from "../view-positions"
import {
  laneEnds,
  placeRoutingLabels,
  routingLabels,
  summaryLabel,
} from "./routing-labels"
import {
  CIRCUIT_COLOR,
  CIRCUIT_DASH,
  IBGP_COLOR,
  ISIS_COLOR,
  ISIS_DASH,
  OSPF_COLOR,
  OSPF_DASH,
  ROUTING_LAYERS,
  STATIC_COLOR,
  layerOf,
  routerCardInput,
  routingEdgeLook,
} from "./routing-model"
import type { RoutingMode } from "./routing-model"

// The Routing tab as an export document - the same model the Diagram's
// SVG, PNG, PDF and draw.io writers draw - built from the tab's data and
// where its cards stand, never from the screen. The cards are the
// Diagram's cards (cardLayout: the name whole), the AS boxes its zones,
// each line in its layer's look - from card edge to card edge, as on the
// canvas - with its label where the canvas puts it (routing-labels.ts)
// and, for a
// route reflector or a static route, an arrowhead at its far end. In
// draw.io each routing layer is a layer of its own (eBGP, iBGP, OSPF,
// IS-IS, Static, Circuits, Cables), to switch on and off there too.

/** A routing layer's draw.io layer name. */
export const LAYER_NAMES: Record<RoutingLayer, string> = Object.fromEntries(
  ROUTING_LAYERS.map((l) => [l.key, l.label])
) as Record<RoutingLayer, string>

/** A cable drawn faint on screen, pre-mixed for paper (no opacity). */
export const PRINT_CABLE = "#cbd5e1"

const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

export interface RoutingDocumentInput {
  /** What is shown: the layers on, nothing hidden. */
  map: RoutingTopology
  /** Every card's centre. */
  centres: PosMap
  zones: readonly Zone[]
  mode: RoutingMode
  fields: readonly RoutingCardField[]
  /** Each line's lane (routing-edge.tsx), by edge id. */
  lanes?: ReadonlyMap<string, number>
}

/** The link back for a line: its first session, adjacency's instance or
 * route, its circuit or cable. */
function linePath(e: RoutingTopology["edges"][number]): string | null {
  if (e.type === "ebgp" || e.type === "ibgp")
    return e.data.sessions[0] ? `/bgp-sessions/${e.data.sessions[0].id}` : null
  if (e.type === "ospf" || e.type === "isis")
    // No page of its own: the router at its source.
    return e.source.startsWith("dev:")
      ? `/devices/${e.source.slice(4)}`
      : `/virtual-machines/${e.source.slice(3)}`
  if (e.type === "static")
    return e.data.routes[0] ? `/static-routes/${e.data.routes[0].id}` : null
  if (e.type === "circuit")
    return e.data.circuit ? `/circuits/${e.data.circuit.id}` : null
  return e.data.cables[0] ? `/cables/${e.data.cables[0].id}` : null
}

/** The way out of card `r` at `p` on its border: the side it is nearest. */
function exitDir(r: Rect, p: Pt): Dir {
  const sides: [number, Dir][] = [
    [Math.abs(p.x - r.x), [-1, 0]],
    [Math.abs(p.x - r.x - r.w), [1, 0]],
    [Math.abs(p.y - r.y), [0, -1]],
    [Math.abs(p.y - r.y - r.h), [0, 1]],
  ]
  return sides.reduce((m, x) => (x[0] < m[0] ? x : m))[1]
}

export function routingDocument(
  input: RoutingDocumentInput,
  opts: Omit<DocumentOptions, "mode" | "notes" | "monitor" | "checkLabels">
): DiagramDocument {
  const measure: Measure = opts.measure ?? measureText
  const area = opts.area ?? null
  const rects = new Map<string, Rect>()
  /** Every card, drawn or not: labels are placed as on the canvas. */
  const all = new Map<string, Rect>()
  const nodes: DiagramNode[] = []

  for (const n of input.map.nodes) {
    if (!Object.hasOwn(input.centres, n.id)) continue
    const at = input.centres[n.id]
    const c = { x: at[0], y: at[1] }
    if (n.type === "router") {
      const cardIn = routerCardInput(n.data, input.mode, input.fields)
      const box = cardLayout(cardIn, null, measure)
      const r = { x: c.x - box.w / 2, y: c.y - box.h / 2, w: box.w, h: box.h }
      all.set(n.id, r)
      if (area && !overlaps(area, r)) continue
      rects.set(n.id, r)
      const path = n.data.device_id
        ? `/devices/${n.data.device_id}`
        : `/virtual-machines/${n.data.vm_id}`
      nodes.push(
        cardNode(n.id, c, box, cardIn, {
          link: danbyteUrl(opts.origin, path),
          measure,
        })
      )
    } else {
      // A provider network: its name, then its provider, as on the Diagram.
      const cardIn: CardLayoutInput = {
        name: n.data.name,
        lines: [{ key: "provider", text: n.data.provider.name }],
      }
      const size = groupBox(n.data, measure)
      const r = {
        x: c.x - size.width / 2,
        y: c.y - size.height / 2,
        w: size.width,
        h: size.height,
      }
      all.set(n.id, r)
      if (area && !overlaps(area, r)) continue
      rects.set(n.id, r)
      nodes.push(
        cardNode(n.id, c, fitBox(cardIn, { w: r.w, h: r.h }, measure), cardIn, {
          measure,
          link: danbyteUrl(
            opts.origin,
            `/provider-networks/${n.data.provider_network_id}`
          ),
        })
      )
    }
  }

  const lanes = input.lanes ?? new Map<string, number>()
  const said = routingLabels(input.map)
  const spots = placeRoutingLabels(
    input.map.edges,
    said.own,
    all,
    lanes,
    measure
  )
  const links: DiagramLink[] = []
  // Layer by layer, cables at the back: draw.io stacks its layers in the
  // order they come.
  const rank = (e: RoutingEdge) =>
    -ROUTING_LAYERS.findIndex((l) => l.key === layerOf(e))
  const edges = [...input.map.edges].sort((x, y) => rank(x) - rank(y))
  for (const e of edges) {
    const s = rects.get(e.source)
    const t = rects.get(e.target)
    if (!s || !t) continue
    const ends = laneEnds(s, t, lanes.get(e.id) ?? 0)
    const a = { ...ends.a, dir: exitDir(s, ends.a) }
    const b = { ...ends.b, dir: exitDir(t, ends.b) }
    const look = routingEdgeLook(e)
    const layer = layerOf(e)
    const path = linePath(e)
    const mid = said.own.get(e.id) ?? []
    const spot = spots.get(e.id)
    links.push(
      routeLink(
        e.id,
        e.source,
        e.target,
        linkRoute("straight", a, b),
        [
          { node: e.source, x: a.x, y: a.y, side: endSide(a) },
          { node: e.target, x: b.x, y: b.y, side: endSide(b) },
        ],
        {
          sem: layer === "ebgp" || layer === "ibgp" ? "bgp" : "cable",
          stroke: look.faint ? PRINT_CABLE : look.stroke,
          width: look.width,
          ...(look.dash ? { dash: look.dash } : {}),
          ...(look.arrow ? { arrow: "end" as const } : {}),
          // A label with no room is left off, as on the canvas.
          labels:
            mid.length && spot
              ? {
                  mid,
                  ...(spot.t !== 0.5 ? { midAt: spot.t } : {}),
                  ...(spot.off ? { midOff: spot.off } : {}),
                }
              : {},
          ...(path ? { link: danbyteUrl(opts.origin, path) } : {}),
        }
      )
    )
    links[links.length - 1].layer = LAYER_NAMES[layer]
  }

  const bands = regionBands(
    input.zones.map((z) => ({ ...z, kind: "zone" as const })),
    area
  )
  const body = { bands, nodes, links, notes: [] }
  return {
    meta: { ...opts.meta, mode: input.mode },
    bounds: documentBounds(body, measure),
    ...body,
  }
}

/** The legend's lines for the layers drawn - the canvas legend's rows and
 * the exports' alike. */
export function routingLegendRows(
  map: Pick<RoutingTopology, "edges" | "nodes"> &
    Partial<Pick<RoutingTopology, "as_groups">>
): LegendItem[] {
  const rows: LegendItem[] = []
  const has = (t: string) => map.edges.some((e) => e.type === t)
  if (has("ebgp")) rows.push({ kind: "line", label: "eBGP", width: 3 })
  if (has("ibgp"))
    rows.push({
      kind: "line",
      label: "iBGP · RR → client",
      color: IBGP_COLOR,
      width: 1.25,
    })
  if (has("ospf"))
    rows.push({
      kind: "line",
      label: "OSPF",
      color: OSPF_COLOR,
      width: 2,
      dash: OSPF_DASH,
    })
  if (has("isis"))
    rows.push({
      kind: "line",
      label: "IS-IS",
      color: ISIS_COLOR,
      width: 2,
      dash: ISIS_DASH,
    })
  if (has("static"))
    rows.push({
      kind: "line",
      label: "Static → next hop",
      color: STATIC_COLOR,
      width: 1,
    })
  if (has("circuit"))
    rows.push({
      kind: "line",
      label: "Circuit",
      color: CIRCUIT_COLOR,
      width: 2,
      dash: CIRCUIT_DASH,
    })
  if (has("cable"))
    rows.push({ kind: "line", label: "Cable", color: PRINT_CABLE, width: 1 })
  // Each eBGP line's colour is its AS pair's: keyed pair by pair.
  const pairs = new Map<string, string>()
  for (const e of map.edges) {
    if (e.type !== "ebgp") continue
    const [a, b] = [e.data.a_asn, e.data.b_asn].sort(
      (x, y) => (x ?? 0) - (y ?? 0)
    )
    const label = `AS${a ?? "?"} ⇄ AS${b ?? "?"}`
    if (!pairs.has(label)) pairs.set(label, routingEdgeLook(e).stroke)
  }
  for (const [label, color] of [...pairs].slice(0, MAX_PAIRS))
    rows.push({ kind: "tone", label, color })
  // What the lines of an AS box all say, said once here instead.
  const looks = new Map(map.edges.map((e) => [e.id, routingEdgeLook(e)]))
  for (const sum of routingLabels(map).summaries) {
    const look = looks.get(sum.edges[0])!
    rows.push({
      kind: "line",
      label: summaryLabel(sum),
      color: look.stroke,
      width: look.width,
      ...(look.dash ? { dash: look.dash } : {}),
    })
  }
  return rows
}

/** The most AS pairs a legend keys; the rest read off their lines. */
const MAX_PAIRS = 12
