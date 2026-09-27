import type { Edge } from "@xyflow/react"

import { portSide } from "@/lib/diagram/geometry"
import type { PortPlace } from "@/lib/diagram/geometry"
import type { Measure } from "@/lib/diagram/measure"
import { LABEL } from "@/lib/diagram/theme"
import { linkEnds, nubKey } from "./anchors"
import type { EndTurns } from "./anchors"
import { solveArcs } from "./arcs"
import type { ArcAsk, ArcAxis, ArcSide } from "./arcs"
import {
  LabelScene,
  placeChips,
  placeEndLabels,
  placePortLabels,
} from "./label-placement"
import type {
  ChipAsk,
  ChipPlace,
  EndLabelAsk,
  PortLabelAsk,
} from "./label-placement"
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
// sweep through a card; cyclical arcs raised round the cards between their
// ends), then where each port name, middle chip and end address goes.
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
  /** Drawn as arcs: the side and the highest apex of its cables. */
  arc?: { flip: ArcSide; h: number }
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
  /** Address lines at each end (`labels.ends`), and their widest. */
  ia?: string[]
  ib?: string[]
  wia: number
  wib: number
  /** The card side a nub's port name leaves square to, for re-seating a
   * side's names together. */
  ga?: string
  gb?: string
  /** Drawn as an arc along this axis, bulging this way. */
  arc?: { axis: ArcAxis; s: ArcSide }
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
      const ports = !d.labels.noPorts
      const ta = nubA && ports ? aa.port : undefined
      const tb = nubB && ports ? ba.port : undefined
      const wa = ta ? input.measure(ta, LABEL.END_SIZE, 400) : 0
      const wb = tb ? input.measure(tb, LABEL.END_SIZE, 400) : 0
      // Addresses only at a card: a breakout's junction end has none.
      const addr = d.labels.ends?.[i]
      const ia = aa?.k === "side" && addr?.a?.length ? addr.a : undefined
      const ib = ba?.k === "side" && addr?.b?.length ? addr.b : undefined
      const widest = (lines?: string[]) =>
        lines
          ? Math.max(...lines.map((l) => input.measure(l, LABEL.END_SIZE, 400)))
          : 0
      const wia = widest(ia)
      const wib = widest(ib)
      // A nub's straight run holds its port name and, beside it, its
      // addresses.
      const runA = Math.max(wa, nubA ? wia : 0)
      const runB = Math.max(wb, nubB ? wib : 0)
      const arc: Item["arc"] =
        d.arc && aa?.k === "side" && ba?.k === "side"
          ? {
              axis: aa.side === "T" || aa.side === "B" ? "x" : "y",
              s: d.arc.flip,
            }
          : undefined
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
        // A cyclical link the view's default leaves unarched is bendy.
        line:
          d.fan?.role === "trunk"
            ? "straight"
            : d.line === "cyclical" && !arc
              ? "bendy"
              : d.line,
        a: {
          ...a,
          node: e.source,
          stub: runA ? portStub(runA) : sa ? SHARED_STUB : STUB,
          ...(sa ? { shared: sa } : {}),
        },
        b: {
          ...b,
          node: e.target,
          stub: runB ? portStub(runB) : sb ? SHARED_STUB : STUB,
          ...(sb ? { shared: sb } : {}),
        },
        ...(ta ? { ta } : {}),
        ...(tb ? { tb } : {}),
        wa,
        wb,
        ...(ia ? { ia } : {}),
        ...(ib ? { ib } : {}),
        wia,
        wib,
        ...(ta && aa?.k === "side"
          ? { ga: `${e.source}\u0000${aa.side}` }
          : {}),
        ...(tb && ba?.k === "side"
          ? { gb: `${e.target}\u0000${ba.side}` }
          : {}),
        ...(arc ? { arc } : {}),
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
    const named = !!(it.tb || it.ib)
    const need = named ? 2 * it.b.stub : 0
    const bend =
      along > 0 ? Math.max(0.2, Math.min(FAN_BEND, 1 - need / along)) : FAN_BEND
    const fan = fanControls(it.a, it.b, bend)
    if (fan) {
      // Legs converging on one card run in side by side. A point on the
      // line from the last control point to the port (`x` px out) makes
      // the curved rule end in a truly straight run, half-way back to that
      // control point: at least a stub, so each name keeps its own gap.
      const [, p2] = fan
      const last = Math.hypot(B.x - p2.x, B.y - p2.y)
      const x = Math.max(1, 2 * it.b.stub - last)
      if (named && x < last - 1) {
        const s = { x: B.x + it.b.dir[0] * x, y: B.y + it.b.dir[1] * x }
        return [A, ...fan, s, B]
      }
      return [A, ...fan, B]
    }
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

/** How a planned cable leaves one of its ends: the points from that end,
 * the first run's direction, the direction after its first bend, and the
 * side of the line a label there goes on by default. */
function leaving(
  it: Item,
  end: "a" | "b",
  pts: readonly Pt[]
): { p: readonly Pt[]; u: Pt; next: Pt | null; side: 1 | -1 } | null {
  const p = end === "a" ? pts : reversed(pts)
  const u = unit(p[0], p[1])
  if (!u) return null
  const next = p.length > 2 ? unit(p[1], p[2]) : null
  // A run with no bend: the side facing away from the middle of the
  // card's edge, so the names on one edge fan out one to a gap.
  const out = end === "a" ? it.outA : it.outB
  const away =
    !next && out ? (Math.sign(-u.y * out.x + u.x * out.y) as 1 | -1 | 0) : 0
  return { p, u, next, side: away || portSide(u, next) }
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
  const run0 = leaving(it, end, pts)
  if (!run0) return null
  const { p, u, side } = run0
  const run = Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y)
  // A curve whose next control point lies on its first run's line runs
  // straight to halfway there (draw.io's curved rule).
  const onLine =
    p.length > 2 &&
    Math.abs(u.x * (p[2].y - p[1].y) - u.y * (p[2].x - p[1].x)) < 1e-6 &&
    u.x * (p[2].x - p[1].x) + u.y * (p[2].y - p[1].y) > 0
  // The straight room from the port: an elbow's first run up to its
  // rounded corner; most of a curve's reach; a straight line's length.
  const room =
    it.line === "elbow" && p.length > 2
      ? run - ELBOW_RADIUS - 1
      : it.line === "bendy" || it.line === "cyclical"
        ? onLine
          ? run + Math.hypot(p[2].x - p[1].x, p[2].y - p[1].y) / 2 - 1
          : run * 0.9
        : route.length - 4
  // Runs square to their card side re-seat together (`reseat`).
  const dir = end === "a" ? it.a.dir : it.b.dir
  const group = end === "a" ? it.ga : it.gb
  const square = Math.abs(u.x * dir[0] + u.y * dir[1]) > 0.999
  return {
    key: `${it.key}${end}`,
    cable: it.key,
    text,
    w: end === "a" ? it.wa : it.wb,
    start: p[0],
    angle: (Math.atan2(u.y, u.x) * 180) / Math.PI,
    room,
    side,
    ...(group && square ? { group } : {}),
  }
}

/** An end-address request for one end of a planned cable: in Detailed on
 * the other side of the line from its port name, from just past the nub;
 * in Simple `LABEL.END_DIST` out from the point the side's lines share. */
function addressAsk(
  it: Item,
  end: "a" | "b",
  pts: readonly Pt[],
  route: Route,
  port: PortPlace | null | undefined
): EndLabelAsk | null {
  const lines = end === "a" ? it.ia : it.ib
  const len = route.length
  if (!lines || len < 1) return null
  const run0 = leaving(it, end, pts)
  if (!run0) return null
  const w = end === "a" ? it.wia : it.wib
  const nub = end === "a" ? it.nubA : it.nubB
  const from = nub ? LABEL.PORT_DIST : LABEL.END_DIST
  let side = run0.side
  if (port) {
    // The side the name took: its centre, seen across the run.
    const start = run0.p[0]
    const across =
      -run0.u.y * (port.x - start.x) + run0.u.x * (port.y - start.y)
    side = across > 0 ? -1 : 1
  }
  const fromEnd = end === "b"
  return {
    key: `${it.key}${end}`,
    w,
    lines: lines.length,
    walk: (d) => {
      const at = route.at(fromEnd ? 1 - d / len : d / len)
      return {
        x: at.x,
        y: at.y,
        angle: fromEnd ? at.angle + 180 : at.angle,
      }
    },
    from,
    until: Math.min(len / 2, from + w + (nub ? 48 : 96)),
    side,
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
  // Arcs together, so the longer ones go round the shorter.
  const arcs = solveArcs(
    all.flatMap((it): ArcAsk[] =>
      it.arc
        ? [
            {
              key: it.key,
              a: { x: it.a.x, y: it.a.y },
              b: { x: it.b.x, y: it.b.y },
              axis: it.arc.axis,
              s: it.arc.s,
              own: [it.a.node, it.b.node],
            },
          ]
        : []
    ),
    obs
  )
  for (const it of all) {
    if (ptsOf.has(it.key)) continue
    const A = { x: it.a.x, y: it.a.y }
    const B = { x: it.b.x, y: it.b.y }
    const arc = arcs.get(it.key)
    ptsOf.set(
      it.key,
      arc
        ? arc.pts
        : it.line === "bendy" || it.line === "cyclical"
          ? bendyPts(it, obs)
          : [A, B]
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
  // End addresses last: best effort round the names and chips.
  const addrAsks: EndLabelAsk[] = []
  for (const it of all)
    for (const end of ["a", "b"] as const) {
      const ask = addressAsk(
        it,
        end,
        ptsOf.get(it.key)!,
        routeOf.get(it.key)!,
        ports.get(`${it.key}${end}`)
      )
      if (ask) addrAsks.push(ask)
    }
  const addrs = placeEndLabels(addrAsks, scene)

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
    const arced = list.flatMap((it) => {
      const r = arcs.get(it.key)
      return r && it.arc ? [{ s: it.arc.s, h: r.h }] : []
    })
    plans.set(id, {
      cables: list.map((it) => ({
        pts: ptsOf.get(it.key)!,
        ...(it.ta ? { a: ports.get(`${it.key}a`) ?? null } : {}),
        ...(it.tb ? { b: ports.get(`${it.key}b`) ?? null } : {}),
        ...(it.ia || it.ib
          ? {
              ips: {
                ...(it.ia ? { a: addrs.get(`${it.key}a`) ?? null } : {}),
                ...(it.ib ? { b: addrs.get(`${it.key}b`) ?? null } : {}),
              },
            }
          : {}),
      })),
      ...(arced.length
        ? {
            arc: {
              flip: arced[0].s,
              h: Math.max(...arced.map((x) => x.h)),
            },
          }
        : {}),
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
