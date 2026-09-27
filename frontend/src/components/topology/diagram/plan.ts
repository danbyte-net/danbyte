import type { Edge } from "@xyflow/react"

import type { Measure } from "@/lib/diagram/measure"
import { LABEL } from "@/lib/diagram/theme"
import { linkEnds, nubKey } from "./anchors"
import type { EndTurns } from "./anchors"
import { solveArcs } from "./arcs"
import type { ArcAsk, ArcAxis, ArcSide } from "./arcs"
import {
  LabelScene,
  inlineLength,
  placeChips,
  placeInline,
} from "./label-placement"
import type { ChipAsk, ChipPlace, InlineAsk } from "./label-placement"
import {
  assignLanes,
  elbowBase,
  endTurn,
  obstacles,
  pathClear,
  sharedPins,
  SHARED_STUB,
} from "./lanes"
import type { ElbowCable, ElbowRoute, PlanEnd, RouteCache } from "./lanes"
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
// ends), then where each port name, middle chip and end address goes -
// end labels on their own cable, which breaks for them.
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
  /** Routes kept from the map's last plans, reused where nothing changed. */
  routes?: RouteCache
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

/** The most of its line an end's labels may ask to run straight for. */
const RUN_MAX = 200

/** How far along its line an end's labels reach (texts `ws` wide, port
 * name first): the lead out of the nub, then the labels one after
 * another. */
export function endRun(ws: readonly number[]): number {
  return ws.length ? LABEL.LEAD + inlineLength(ws) : 0
}

/** The straight run out of a nub its labels need (`endRun`) before the
 * cable may bend. */
export function portStub(run: number): number {
  return Math.max(STUB, Math.min(run, RUN_MAX) + ELBOW_RADIUS + 2)
}

interface Item {
  edge: Edge<DiagramEdgeData>
  i: number
  key: string
  line: LineType
  a: PlanEnd
  b: PlanEnd
  /** Port names on the line at each end: at a Detailed nub, or where a
   * Simple line is one cable. */
  ta?: string
  tb?: string
  wa: number
  wb: number
  /** Address lines at each end (`labels.ends`), and each one's width. */
  ia?: string[]
  ib?: string[]
  wia: number[]
  wib: number[]
  /** A Detailed nub end: the straight run its labels need (`endRun`). */
  runA: number
  runB: number
  /** Drawn as an arc along this axis, bulging this way. */
  arc?: { axis: ArcAxis; s: ArcSide }
  /** The end leaves a Detailed nub. */
  nubA: boolean
  nubB: boolean
  fanLeg: boolean
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
      // Port names at a nub, or on a Simple line that is one cable (a
      // bundle's line is named by its chip).
      const ports = !d.labels.noPorts && (detailed || d.sem === "cable")
      const ta =
        ports && aa?.k === "side" && (nubA || !detailed) ? aa.port : undefined
      const tb =
        ports && ba?.k === "side" && (nubB || !detailed) ? ba.port : undefined
      const width = (text: string) => input.measure(text, LABEL.END_SIZE, 400)
      const wa = ta ? width(ta) : 0
      const wb = tb ? width(tb) : 0
      // Addresses only at a card: a breakout's junction end has none.
      const addr = d.labels.ends?.[i]
      const ia = aa?.k === "side" && addr?.a?.length ? addr.a : undefined
      const ib = ba?.k === "side" && addr?.b?.length ? addr.b : undefined
      const wia = (ia ?? []).map(width)
      const wib = (ib ?? []).map(width)
      // A nub's straight run holds its port name, then its addresses.
      const runA = nubA ? endRun([...(ta ? [wa] : []), ...wia]) : 0
      const runB = nubB ? endRun([...(tb ? [wb] : []), ...wib]) : 0
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
        runA,
        runB,
        ...(arc ? { arc } : {}),
        nubA,
        nubB,
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
    const named = it.runB > 0
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
  let ka = Math.max(k, it.runA ? portStub(it.runA) : 0)
  let kb = Math.max(k, it.runB ? portStub(it.runB) : 0)
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
    if (pathClear(obs, pts, own)) return withLeads(pts, it.runA, it.runB)
  }
  return withLeads(
    [A, ...bendyControls(it.a, it.b, BENDY.MIN, BENDY.MIN), B],
    it.runA,
    it.runB
  )
}

/**
 * A curve's points with one put in on the arm from each labelled end to
 * its first control point, so the curved rule runs straight out of that
 * end for `need` px (a nub's labels sit there): the first piece then
 * runs from the end to half-way between the new point and the control
 * point, all on one line. Moves the curve towards its control polygon,
 * never into what that polygon keeps clear of.
 */
export function withLeads(pts: Pt[], needA: number, needB: number): Pt[] {
  const lead = (p: Pt[], need: number): Pt[] => {
    if (need <= 0 || p.length < 3) return p
    const [A, P1] = p
    const arm = Math.hypot(P1.x - A.x, P1.y - A.y)
    if (arm < 4) return p
    const s = Math.min(arm - 1, Math.max(1, 2 * (need + 2) - arm))
    return [
      A,
      { x: A.x + ((P1.x - A.x) * s) / arm, y: A.y + ((P1.y - A.y) * s) / arm },
      ...p.slice(1),
    ]
  }
  return reversed(lead(reversed(lead(pts, needA)), needB))
}

/** A planned route walked from one of its ends: the point `d` px along
 * it and the direction of travel there, away from that end. */
function walker(route: Route, fromEnd: boolean) {
  const len = route.length
  return (d: number) => {
    const at = route.at(fromEnd ? 1 - d / len : d / len)
    return { x: at.x, y: at.y, angle: fromEnd ? at.angle + 180 : at.angle }
  }
}

/** A route that is one straight line, walked from one of its ends: where
 * it starts and which way it runs (`InlineAsk.line`). */
function lineOf(route: Route, fromEnd: boolean): InlineAsk["line"] {
  if (route.pts.length !== 2) return undefined
  const [p, q] = fromEnd ? [route.pts[1], route.pts[0]] : route.pts
  const len = Math.hypot(q.x - p.x, q.y - p.y)
  if (!(len > 0)) return undefined
  return { at: p, u: { x: (q.x - p.x) / len, y: (q.y - p.y) / len } }
}

/** How far out along its route an end's labels may reach: near their
 * end, and short of the middle when the other end has labels too. */
function reach(
  route: Route,
  from: number,
  ws: readonly number[],
  half: boolean
): number {
  const far = half ? route.length / 2 : route.length - LABEL.LEAD
  return Math.min(far, from + inlineLength(ws) + 96)
}

/** Does the other end of a planned cable carry labels? */
const labelledAt = (it: Item, end: "a" | "b") =>
  end === "a" ? !!(it.ta || it.ia) : !!(it.tb || it.ib)

/** The route as a polyline, curves sampled - what labels keep clear of. */
function polyline(line: LineType, pts: Pt[], route: Route): Pt[] {
  if ((line !== "bendy" && line !== "cyclical") || pts.length < 3) return pts
  const out: Pt[] = []
  for (let i = 0; i <= 32; i++) {
    const p = route.at(i / 32)
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
  const cards = [...input.rects].filter(([id]) => input.solid(id))
  const obs = obstacles(cards)
  input.routes?.begin(cards, obs)
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
  // Other lines leaving a shared point count too: a breakout's straight
  // trunk out of a Simple midpoint, an LLDP ghost - an elbow turns off
  // before it runs along them.
  const pins = sharedPins([
    ...cables,
    ...all
      .filter((it) => it.line !== "elbow" && (it.a.shared || it.b.shared))
      .map((it) => ({ key: `~${it.key}`, a: it.a, b: it.b })),
  ])
  const routes: ElbowRoute[] = cables.map((c) => {
    const [pa, pb] = [pins.get(`${c.key}:a`), pins.get(`${c.key}:b`)]
    return input.routes
      ? input.routes.route(c, obs, pa, pb)
      : elbowBase(c, obs, pa, pb)
  })
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
        ? withLeads(arc.pts, it.runA, it.runB)
        : it.line === "bendy" || it.line === "cyclical"
          ? bendyPts(it, obs)
          : [A, B]
    )
  }
  const routeOf = new Map<string, Route>()
  for (const it of all)
    routeOf.set(it.key, routeThrough(it.line, ptsOf.get(it.key)!, it.a.dir))

  // Labels: port names first (they belong to one spot), then the chips,
  // then the addresses after each port name.
  const scene = new LabelScene(
    all.map((it): [string, Pt[]] => [
      it.key,
      polyline(it.line, ptsOf.get(it.key)!, routeOf.get(it.key)!),
    ]),
    [...input.rects].filter(([id]) => input.solid(id)).map(([, r]) => r)
  )
  const asks: InlineAsk[] = []
  for (const it of all) {
    const route = routeOf.get(it.key)!
    if (route.length < 1) continue
    for (const end of ["a", "b"] as const) {
      const text = end === "a" ? it.ta : it.tb
      if (!text) continue
      const ws = [end === "a" ? it.wa : it.wb]
      const nub = end === "a" ? it.nubA : it.nubB
      const line = lineOf(route, end === "b")
      asks.push({
        key: `${it.key}${end}`,
        cable: it.key,
        ws,
        walk: walker(route, end === "b"),
        ...(line ? { line } : {}),
        from: LABEL.LEAD,
        // A nub's name keeps to its run; a Simple line's finds its own.
        until: nub
          ? labelledAt(it, end === "a" ? "b" : "a")
            ? route.length / 2
            : route.length - LABEL.LEAD
          : reach(
              route,
              LABEL.LEAD,
              ws,
              labelledAt(it, end === "a" ? "b" : "a")
            ),
        ...(nub ? { first: true } : {}),
      })
    }
  }
  const ports = placeInline(asks, scene)

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
  // End addresses last, after their port names: best effort round the
  // names and chips.
  const addrAsks: InlineAsk[] = []
  for (const it of all) {
    const route = routeOf.get(it.key)!
    if (route.length < 1) continue
    for (const end of ["a", "b"] as const) {
      const lines = end === "a" ? it.ia : it.ib
      if (!lines) continue
      const ws = end === "a" ? it.wia : it.wib
      const port = ports.get(`${it.key}${end}`)
      const from = port ? port.reach + LABEL.LEAD : LABEL.LEAD
      const line = lineOf(route, end === "b")
      addrAsks.push({
        key: `${it.key}${end}`,
        cable: it.key,
        ws,
        walk: walker(route, end === "b"),
        ...(line ? { line } : {}),
        from,
        until: reach(route, from, ws, labelledAt(it, end === "a" ? "b" : "a")),
      })
    }
  }
  const addrs = placeInline(addrAsks, scene)

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
        ...(it.ta ? { a: ports.get(`${it.key}a`)?.at[0] ?? null } : {}),
        ...(it.tb ? { b: ports.get(`${it.key}b`)?.at[0] ?? null } : {}),
        ...(it.ia || it.ib
          ? {
              ips: {
                ...(it.ia ? { a: addrs.get(`${it.key}a`)?.at ?? null } : {}),
                ...(it.ib ? { b: addrs.get(`${it.key}b`)?.at ?? null } : {}),
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
