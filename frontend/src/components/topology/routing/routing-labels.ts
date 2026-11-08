import type { RoutingEdge, RoutingTopology } from "@/lib/api"
import { measureText } from "@/lib/diagram/measure"
import type { Measure } from "@/lib/diagram/measure"
import { LABEL } from "@/lib/diagram/theme"
import { naturalCompare } from "@/lib/natural-sort"
import { LabelScene } from "../diagram/label-placement"
import { inflate, turnedBox } from "../diagram/spatial"
import type { Pt, Rect } from "../diagram/types"
import { exitPoint } from "../overlay-edge"
import type { Box } from "../overlay-edge"
import { KIND_NAME, afShort, routingEdgeLabel } from "./routing-model"

// Where the Routing tab's line labels go, on the canvas and in the exports
// alike.
//
// - Said once: lines inside one AS box that would all say the same thing
//   (every leaf's session to the route reflectors "evpn · RR client ·
//   cluster 10.255.0.0", every IS-IS adjacency "L2") lose their own label
//   and the legend says it once for the box. A line that says something
//   else keeps its label.
// - Placed: each label that is left sits on its own line at the first
//   free spot along it - the middle, then a little either side, then
//   nearer the ends - never on a card or another label. A line in a lane
//   beside another (a session and an adjacency between the same two
//   cards) takes its label on its own side. With no free spot the label
//   is left off; the line still shows it on hover and in its panel.

/** What the lines of one AS box all say, said once. */
export interface RoutingLabelSummary {
  /** The AS box's AS. */
  asn: number
  type: RoutingEdge["type"]
  /** One line of text, e.g. "RR clients of spine1, spine2 · evpn ·
   * cluster 10.255.0.0". */
  text: string
  /** The lines it speaks for. */
  edges: string[]
}

export interface RoutingLabels {
  /** Every line's whole label (its hover and panel text). */
  full: Map<string, string[]>
  /** What a line says along it: empty when a summary says it. */
  own: Map<string, string[]>
  summaries: RoutingLabelSummary[]
}

/** Lines of one box that say the same thing: said once from this many. */
export const SUMMARY_MIN = 2

/** The AS box each card sits in - Arrange ▸ By AS's rule: the lowest AS
 * whose group names it. */
function boxOf(g: Pick<RoutingTopology, "as_groups">): Map<string, number> {
  const out = new Map<string, number>()
  for (const grp of [...g.as_groups].sort((a, b) => a.asn - b.asn))
    for (const id of grp.nodes) if (!out.has(id)) out.set(id, grp.asn)
  return out
}

/** A legend row's text for a summary: "AS65100 · iBGP · RR clients of
 * spine1, spine2 · evpn · cluster 10.255.0.0". */
export const summaryLabel = (s: RoutingLabelSummary) =>
  `AS${s.asn} · ${KIND_NAME[s.type]} · ${s.text}`

/** Every line's label, with what the lines of one box share said once. */
export function routingLabels(
  map: Pick<RoutingTopology, "nodes" | "edges"> &
    Partial<Pick<RoutingTopology, "as_groups">>
): RoutingLabels {
  const full = new Map<string, string[]>()
  const own = new Map<string, string[]>()
  const box = boxOf({ as_groups: map.as_groups ?? [] })
  const groups = new Map<string, { asn: number; edges: RoutingEdge[] }>()
  for (const e of map.edges) {
    const label = routingEdgeLabel(e)
    full.set(e.id, label)
    own.set(e.id, label)
    if (!label.length) continue
    const a = box.get(e.source)
    if (a === undefined || box.get(e.target) !== a) continue
    const key = [a, e.type, ...label].join("\u0000")
    const g = groups.get(key) ?? { asn: a, edges: [] }
    g.edges.push(e)
    groups.set(key, g)
  }
  const names = new Map(map.nodes.map((n) => [n.id, n.data.name]))
  const summaries: RoutingLabelSummary[] = []
  for (const { asn, edges } of groups.values()) {
    if (edges.length < SUMMARY_MIN) continue
    for (const e of edges) own.set(e.id, [])
    summaries.push({
      asn,
      type: edges[0].type,
      text: summaryText(edges, (id) => names.get(id) ?? id),
      edges: edges.map((e) => e.id),
    })
  }
  summaries.sort(
    (x, y) =>
      x.asn - y.asn ||
      naturalCompare(KIND_NAME[x.type], KIND_NAME[y.type]) ||
      naturalCompare(x.text, y.text)
  )
  return { full, own, summaries }
}

/** What lines that say the same thing say, once: iBGP to route
 * reflectors names the reflectors. */
function summaryText(
  edges: readonly RoutingEdge[],
  name: (id: string) => string
): string {
  const e = edges[0]
  if (e.type === "ibgp" && e.data.rr) {
    const d = e.data
    const rrs = [
      ...new Set(
        edges.flatMap((x) =>
          x.type === "ibgp" && x.data.rr ? [name(x.data.rr.reflector)] : []
        )
      ),
    ].sort(naturalCompare)
    return [
      `RR clients of ${rrs.join(", ")}`,
      ...d.address_families.map(afShort),
      ...(d.vrf ? [`VRF ${d.vrf}`] : []),
      ...(d.rr?.cluster_id ? [`cluster ${d.rr.cluster_id}`] : []),
    ].join(" · ")
  }
  return routingEdgeLabel(e).join(" · ")
}

/** How far apart side-by-side lines run, px. */
export const LANE_GAP = 12

/** The two ends of a line between boxes `s` and `t`, moved `lane` lanes
 * to its side. */
export function laneEnds(s: Box, t: Box, lane: number) {
  const a = exitPoint(s, t)
  const b = exitPoint(t, s)
  if (!lane) return { a, b }
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy) || 1
  // Perpendicular, the same way whichever end is the source.
  const flip = s.x + s.y <= t.x + t.y ? 1 : -1
  const ox = (-dy / len) * lane * LANE_GAP * flip
  const oy = (dx / len) * lane * LANE_GAP * flip
  return {
    a: { x: a.x + ox, y: a.y + oy },
    b: { x: b.x + ox, y: b.y + oy },
  }
}

/** Where a label sits on its line: `t` of the way from source to target,
 * `off` px to the right hand of travel (0 = on it). */
export interface LabelSpot {
  t: number
  off: number
}

/** A label chip's size: the exports' middle label, which the canvas chip
 * matches. */
export function chipSize(
  lines: readonly string[],
  measure: Measure = measureText
): { w: number; h: number } {
  return {
    w:
      Math.max(...lines.map((l) => measure(l, LABEL.MID_SIZE, 400))) +
      2 * LABEL.PAD_X +
      2,
    h: lines.length * LABEL.MID_LH + 3,
  }
}

/** Where a label may sit along its line, best first. */
const SPOT_T = [0.5, 0.38, 0.62, 0.26, 0.74, 0.16, 0.84]

/** The point `t` along a-b, `off` px to its right hand. */
export function spotPoint(a: Pt, b: Pt, spot: LabelSpot): Pt {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy) || 1
  return {
    x: a.x + dx * spot.t - (dy / len) * spot.off,
    y: a.y + dy * spot.t + (dx / len) * spot.off,
  }
}

/** The two ends of every line drawn, lanes and all (routing-edge.tsx
 * `laneEnds`). */
export function lineEnds(
  edges: readonly Pick<RoutingEdge, "id" | "source" | "target">[],
  rects: ReadonlyMap<string, Rect>,
  lanes: ReadonlyMap<string, number>
): Map<string, { a: Pt; b: Pt }> {
  const out = new Map<string, { a: Pt; b: Pt }>()
  for (const e of edges) {
    const s = rects.get(e.source)
    const t = rects.get(e.target)
    if (s && t) out.set(e.id, laneEnds(s, t, lanes.get(e.id) ?? 0))
  }
  return out
}

/**
 * Place each line's own label (`own`), in edge order: the first spot
 * along its line clear of every card, label and other line; failing that,
 * one where other lines only cross steeply under it; failing that, one
 * over other lines but still clear of every card and label; failing that
 * none (`null`: shown on hover only). Lines with nothing to say are not in the result.
 */
export function placeRoutingLabels(
  edges: readonly Pick<RoutingEdge, "id" | "source" | "target">[],
  own: ReadonlyMap<string, readonly string[]>,
  rects: ReadonlyMap<string, Rect>,
  lanes: ReadonlyMap<string, number>,
  measure: Measure = measureText
): Map<string, LabelSpot | null> {
  const ends = lineEnds(edges, rects, lanes)
  const scene = new LabelScene(
    [...ends].map(([id, { a, b }]) => [id, [a, b]] as [string, Pt[]]),
    rects.values()
  )
  const out = new Map<string, LabelSpot | null>()
  for (const e of edges) {
    const lines = own.get(e.id) ?? []
    const at = ends.get(e.id)
    if (!lines.length || !at) continue
    const { w, h } = chipSize(lines, measure)
    const boxAt = (spot: LabelSpot) => {
      const p = spotPoint(at.a, at.b, spot)
      return turnedBox(inflate({ x: p.x - w / 2, y: p.y - h / 2, w, h }, 2))
    }
    // A line in a lane takes its label on its own side, away from the
    // line beside it.
    const lane = lanes.get(e.id) ?? 0
    const s = rects.get(e.source)!
    const t = rects.get(e.target)!
    const flip = s.x + s.y <= t.x + t.y ? 1 : -1
    const beside = h / 2 + LABEL.BESIDE + 1
    const offs = lane ? [Math.sign(lane * flip) * beside] : [0, beside, -beside]
    // Clear of every other line; else with others only crossing steeply
    // under it; else over any line - never over a card or a label.
    const passes: [(k: string) => boolean, boolean][] = [
      [(k) => k === e.id, false],
      [(k) => k === e.id, true],
      [() => true, false],
    ]
    let found: LabelSpot | null = null
    for (const [mine, crossing] of passes) {
      for (const off of offs) {
        const t0 = SPOT_T.find(
          (tt) => !scene.blocker(boxAt({ t: tt, off }), mine, crossing)
        )
        if (t0 !== undefined) {
          found = { t: t0, off }
          break
        }
      }
      if (found) break
    }
    if (found) scene.take(boxAt(found))
    out.set(e.id, found)
  }
  return out
}
