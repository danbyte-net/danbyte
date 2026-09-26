import type { Edge } from "@xyflow/react"

import { portSide } from "@/lib/diagram/geometry"
import type { Measure } from "@/lib/diagram/measure"
import { LABEL } from "@/lib/diagram/theme"
import { linkEnds, nubKey } from "./anchors"
import type { EndTurns } from "./anchors"
import { LabelScene, placeChips, placePortLabels } from "./label-placement"
import type { ChipAsk, ChipPlace, PortLabelAsk } from "./label-placement"
import {
  assignLanes,
  elbowBase,
  endTurn,
  obstacles,
  pathClear,
  sharedPins,
  SHARED_STUB,
} from "./lanes"
import type { ElbowCable, ElbowRoute, PlanEnd } from "./lanes"
import {
  BENDY,
  bendyControls,
  bendyReach,
  ELBOW_RADIUS,
  FAN_BEND,
  fanControls,
  routeThrough,
  STUB,
} from "./link-geometry"
import type {
  Anchor,
  CablePlan,
  DiagramEdgeData,
  DiagramMode,
  End,
  LineType,
  Pt,
  Rect,
  Route,
} from "./types"

// A Diagram's links planned together, once the cards are placed and every
// end is anchored: each cable's route (elbows in their own lanes, clear of
// the cards they do not connect; bendy curves reined in where they would
// sweep through a card), then where each port name and middle chip goes.
// The canvas, the SVG and the draw.io file all draw from this plan, so
// they agree. Pure.

export interface PlanInput {
  /** Anchored link edges; others are passed over. */
  edges: readonly Edge<DiagramEdgeData>[]
  /** Every node's box, junctions included. */
  rects: ReadonlyMap<string, Rect>
  /** The nodes lines keep clear of (cards, not junctions). */
  solid: (id: string) => boolean
  mode: DiagramMode
  measure: Measure
}

export interface EdgePlan {
  cables: CablePlan[]
  /** The middle label this edge draws, when it is not its own: a
   * breakout trunk's chip moved onto a leg (and none on the trunk). */
  mid?: string[]
  midT?: number
  midOff?: number
  crowded?: boolean
}

export interface PlanOutput {
  plans: Map<string, EdgePlan>
  /** Detailed: how each elbow nub's route leaves its side - what
   * `reorderNubs` orders a side by. */
  turns: EndTurns
}

/** The straight run a port name needs before its cable may bend. */
export function portStub(w: number): number {
  return Math.max(STUB, LABEL.PORT_DIST + w + ELBOW_RADIUS + 4)
}

interface Item {
  edge: Edge<DiagramEdgeData>
  i: number
  key: string
  line: LineType
  a: PlanEnd
  b: PlanEnd
  /** Port names drawn along the line at each end (Detailed). */
  ta?: string
  tb?: string
  wa: number
  wb: number
  /** The end leaves a Detailed nub. */
  nubA: boolean
  nubB: boolean
  /** Which way along its card's edge a nub lies from the edge's middle
   * (a unit vector, or none at the middle). */
  outA?: Pt
  outB?: Pt
  fanLeg: boolean
}

/** The way along a card's side from its middle to a nub on it. */
function outward(anchor: Anchor | undefined, r: Rect): Pt | undefined {
  if (anchor?.k !== "side") return undefined
  const len = anchor.side === "T" || anchor.side === "B" ? r.w : r.h
  const d = anchor.off - len / 2
  if (Math.abs(d) < 1) return undefined
  const s = Math.sign(d)
  return anchor.side === "T" || anchor.side === "B"
    ? { x: s, y: 0 }
    : { x: 0, y: s }
}

const dirKey = (e: End) => `${Math.round(e.dir[0])},${Math.round(e.dir[1])}`

function items(input: PlanInput): Item[] {
  const out: Item[] = []
  const detailed = input.mode === "detailed"
  for (const e of input.edges) {
    const d = e.data
    if (e.type !== "link" || !d) continue
    const s = input.rects.get(e.source)
    const t = input.rects.get(e.target)
    if (!s || !t) continue
    // The anchors as placed, not re-chosen: a Simple side kept clear of
    // a card in the way stays kept.
    const ends = linkEnds(d, s, t, false)
    ends.forEach(([a, b], i) => {
      const aa = d.a[i] as Anchor | undefined
      const ba = d.b[i] as Anchor | undefined
      const nubA = detailed && !d.simple && aa?.k === "side"
      const nubB = detailed && !d.simple && ba?.k === "side"
      const ta = nubA ? aa.port : undefined
      const tb = nubB ? ba.port : undefined
      const wa = ta ? input.measure(ta, LABEL.END_SIZE, 400) : 0
      const wb = tb ? input.measure(tb, LABEL.END_SIZE, 400) : 0
      const shared = (end: End, node: string, anchor: typeof aa) =>
        anchor?.k === "junction"
          ? `${node}\u0000j\u0000${dirKey(end)}`
          : d.simple
            ? `${node}\u0000${dirKey(end)}`
            : undefined
      const sa = shared(a, e.source, aa)
      const sb = shared(b, e.target, ba)
      out.push({
        edge: e,
        i,
        key: `${e.id}#${i}`,
        line: d.fan?.role === "trunk" ? "straight" : d.line,
        a: {
          ...a,
          node: e.source,
          stub: ta ? portStub(wa) : sa ? SHARED_STUB : STUB,
          ...(sa ? { shared: sa } : {}),
        },
        b: {
          ...b,
          node: e.target,
          stub: tb ? portStub(wb) : sb ? SHARED_STUB : STUB,
          ...(sb ? { shared: sb } : {}),
        },
        ...(ta ? { ta } : {}),
        ...(tb ? { tb } : {}),
        wa,
        wb,
        nubA,
        nubB,
        ...(nubA ? { outA: outward(aa, s) } : {}),
        ...(nubB ? { outB: outward(ba, t) } : {}),
        fanLeg: d.fan?.role === "leg",
      })
    })
  }
  return out
}

const reversed = (pts: readonly Pt[]) => [...pts].reverse()

/** A bendy cable's control points: out along each end's normal, at least
 * far enough that a port name runs along the curve's straight start, and
 * pulled in until the control polygon keeps clear of the cards it does
 * not connect. A breakout leg curves like the cable page's fan-out. */
function bendyPts(it: Item, obs: ReturnType<typeof obstacles>): Pt[] {
  const A = { x: it.a.x, y: it.a.y }
  const B = { x: it.b.x, y: it.b.y }
  const own = [it.a.node, it.b.node]
  if (it.fanLeg) {
    // Bend nearer the junction when the far port's name needs the room.
    const along = (B.x - A.x) * it.a.dir[0] + (B.y - A.y) * it.a.dir[1]
    const need = it.tb ? portStub(it.wb) / 0.9 : 0
    const bend =
      along > 0 ? Math.max(0.2, Math.min(FAN_BEND, 1 - need / along)) : FAN_BEND
    const fan = fanControls(it.a, it.b, bend)
    if (fan) return [A, ...fan, B]
  }
  const k = bendyReach(A, B)
  let ka = Math.max(k, it.ta ? portStub(it.wa) : 0)
  let kb = Math.max(k, it.tb ? portStub(it.wb) : 0)
  // Ends facing each other: control points past the middle of the gap
  // make the curve overshoot and wave back.
  const facing = it.a.dir[0] * it.b.dir[0] + it.a.dir[1] * it.b.dir[1] < -0.99
  const gap = (B.x - A.x) * it.a.dir[0] + (B.y - A.y) * it.a.dir[1]
  if (facing && gap > 0) {
    ka = Math.min(ka, Math.max(BENDY.MIN, gap / 2))
    kb = Math.min(kb, Math.max(BENDY.MIN, gap / 2))
  }
  for (const f of [1, 0.75, 0.5, 0.35]) {
    const pts = [
      A,
      ...bendyControls(
        it.a,
        it.b,
        Math.max(BENDY.MIN, ka * f),
        Math.max(BENDY.MIN, kb * f)
      ),
      B,
    ]
    if (pathClear(obs, pts, own)) return pts
  }
  return [A, ...bendyControls(it.a, it.b, BENDY.MIN, BENDY.MIN), B]
}

/** The unit direction from `p` to `q`, or null for no length. */
function unit(p: Pt, q: Pt): Pt | null {
  const dx = q.x - p.x
  const dy = q.y - p.y
  const l = Math.hypot(dx, dy)
  return l < 1e-9 ? null : { x: dx / l, y: dy / l }
}

/** A port-name request for one end of a planned cable. */
function portAsk(
  it: Item,
  end: "a" | "b",
  pts: readonly Pt[],
  route: Route
): PortLabelAsk | null {
  const text = end === "a" ? it.ta : it.tb
  if (!text) return null
  const p = end === "a" ? pts : reversed(pts)
  const u = unit(p[0], p[1])
  if (!u) return null
  const run = Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y)
  // The straight room from the port: an elbow's first run up to its
  // rounded corner; most of a curve's reach; a straight line's length.
  const room =
    it.line === "elbow" && p.length > 2
      ? run - ELBOW_RADIUS - 1
      : it.line === "bendy" || it.line === "cyclical"
        ? run * 0.9
        : route.length - 4
  const next = p.length > 2 ? unit(p[1], p[2]) : null
  // A run with no bend: the side facing away from the middle of the
  // card's edge, so the names on one edge fan out one to a gap.
  const out = end === "a" ? it.outA : it.outB
  const away =
    !next && out ? (Math.sign(-u.y * out.x + u.x * out.y) as 1 | -1 | 0) : 0
  return {
    key: `${it.key}${end}`,
    cable: it.key,
    text,
    w: end === "a" ? it.wa : it.wb,
    start: p[0],
    angle: (Math.atan2(u.y, u.x) * 180) / Math.PI,
    room,
    side: away || portSide(u, next),
  }
}

/** The route as a polyline, curves sampled - what labels keep clear of. */
function polyline(line: LineType, pts: Pt[], route: Route): Pt[] {
  if ((line !== "bendy" && line !== "cyclical") || pts.length < 3) return pts
  const out: Pt[] = []
  for (let i = 0; i <= 24; i++) {
    const p = route.at(i / 24)
    out.push({ x: p.x, y: p.y })
  }
  return out
}

/**
 * Plan every link: routes, port names and middle chips. With `turnsOnly`
 * it stops once the elbows are routed alone and reports how their nubs'
 * routes leave (for `reorderNubs`), without lanes or labels.
 */
export function planEdges(
  input: PlanInput,
  opts: { turnsOnly?: boolean } = {}
): PlanOutput {
  const all = items(input)
  const obs = obstacles([...input.rects].filter(([id]) => input.solid(id)))
  const turns = new Map<
    string,
    { turn: -1 | 0 | 1; depth: number; extent: number }
  >()

  // Elbows: each alone, then into lanes.
  const elbows = all.filter((it) => it.line === "elbow")
  const cables: ElbowCable[] = elbows.map((it) => ({
    key: it.key,
    a: it.a,
    b: it.b,
  }))
  const pins = sharedPins(cables)
  const routes: ElbowRoute[] = cables.map((c) =>
    elbowBase(c, obs, pins.get(`${c.key}:a`), pins.get(`${c.key}:b`))
  )
  elbows.forEach((it, j) => {
    const pts = routes[j].pts
    if (it.nubA)
      turns.set(
        nubKey({ link: it.edge.id, cable: it.i, end: "a" }),
        endTurn(pts, it.a)
      )
    if (it.nubB)
      turns.set(
        nubKey({ link: it.edge.id, cable: it.i, end: "b" }),
        endTurn(reversed(pts), it.b)
      )
  })
  if (opts.turnsOnly) return { plans: new Map(), turns }
  assignLanes(routes, cables, obs)

  const ptsOf = new Map<string, Pt[]>()
  elbows.forEach((it, j) => ptsOf.set(it.key, routes[j].pts))
  for (const it of all) {
    if (ptsOf.has(it.key)) continue
    const A = { x: it.a.x, y: it.a.y }
    const B = { x: it.b.x, y: it.b.y }
    ptsOf.set(
      it.key,
      it.line === "bendy" || it.line === "cyclical" ? bendyPts(it, obs) : [A, B]
    )
  }
  const routeOf = new Map<string, Route>()
  for (const it of all)
    routeOf.set(it.key, routeThrough(it.line, ptsOf.get(it.key)!, it.a.dir))

  // Labels: port names first (they belong to one spot), then the chips.
  const scene = new LabelScene(
    all.map((it): [string, Pt[]] => [
      it.key,
      polyline(it.line, ptsOf.get(it.key)!, routeOf.get(it.key)!),
    ]),
    [...input.rects].filter(([id]) => input.solid(id)).map(([, r]) => r)
  )
  const asks: PortLabelAsk[] = []
  for (const it of all)
    for (const end of ["a", "b"] as const) {
      const ask = portAsk(it, end, ptsOf.get(it.key)!, routeOf.get(it.key)!)
      if (ask) asks.push(ask)
    }
  const ports = placePortLabels(asks, scene)

  const byEdge = new Map<string, Item[]>()
  for (const it of all) {
    const list = byEdge.get(it.edge.id)
    if (list) list.push(it)
    else byEdge.set(it.edge.id, [it])
  }
  const chips: ChipAsk[] = []
  const chipOf = (id: string, mid: string[], route: Route): ChipAsk => ({
    own: new Set(byEdge.get(id)!.map((it) => it.key)),
    key: id,
    w:
      Math.max(...mid.map((m) => input.measure(m, LABEL.MID_SIZE, 600))) +
      2 * LABEL.PAD_X,
    h: mid.length * LABEL.MID_LH + 3,
    at: (t) => route.at(t),
  })
  const midOf = (id: string) =>
    (byEdge.get(id)![0].edge.data!.labels.mid ?? []).filter(Boolean)
  for (const [id, list] of byEdge) {
    const mid = midOf(id)
    if (!mid.length) continue
    chips.push(
      chipOf(id, mid, routeOf.get(list[Math.floor(list.length / 2)].key)!)
    )
  }
  const placed = new Map<string, ChipPlace & { on: string }>()
  for (const [id, c] of placeChips(chips, scene))
    placed.set(id, { ...c, on: id })
  // A breakout's trunk too short for its chip: the chip goes on its
  // longest leg that has room - it names the one cable either way.
  for (const [id, c] of placed) {
    const d = byEdge.get(id)![0].edge.data!
    if (!c.crowded || d.fan?.role !== "trunk") continue
    const legs = [...byEdge.values()]
      .map((list) => list[0])
      .filter(
        (it) =>
          it.edge.data?.fan?.role === "leg" &&
          it.edge.data.fan.junction === d.fan!.junction &&
          !midOf(it.edge.id).length
      )
      .sort(
        (x, y) =>
          routeOf.get(y.key)!.length - routeOf.get(x.key)!.length ||
          (x.key < y.key ? -1 : 1)
      )
    for (const leg of legs) {
      const got = placeChips(
        [chipOf(leg.edge.id, midOf(id), routeOf.get(leg.key)!)],
        scene
      ).get(leg.edge.id)
      if (got && !got.crowded) {
        placed.set(id, { ...got, on: leg.edge.id })
        break
      }
    }
  }
  // Each chip by the edge that draws it, with the edge it belongs to.
  const chipFor = new Map<
    string,
    { at: ChipPlace; mid: string[]; from: string }
  >()
  for (const [id, c] of placed)
    chipFor.set(c.on, { at: c, mid: midOf(id), from: id })

  const plans = new Map<string, EdgePlan>()
  for (const [id, list] of byEdge) {
    const own = placed.get(id)
    const chip = chipFor.get(id)
    plans.set(id, {
      cables: list.map((it) => ({
        pts: ptsOf.get(it.key)!,
        ...(it.ta ? { a: ports.get(`${it.key}a`) ?? null } : {}),
        ...(it.tb ? { b: ports.get(`${it.key}b`) ?? null } : {}),
      })),
      // The chip moved off this edge: it carries none.
      ...(own && own.on !== id ? { mid: [] } : {}),
      ...(chip
        ? {
            ...(chip.from !== id ? { mid: chip.mid } : {}),
            midT: chip.at.t,
            ...(chip.at.off ? { midOff: chip.at.off } : {}),
            ...(chip.at.crowded ? { crowded: true } : {}),
          }
        : {}),
    })
  }
  return { plans, turns }
}
