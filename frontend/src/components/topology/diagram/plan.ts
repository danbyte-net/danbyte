import type { Edge } from "@xyflow/react"

import { endTextWidth } from "@/lib/diagram/geometry"
import type { Measure } from "@/lib/diagram/measure"
import { LABEL } from "@/lib/diagram/theme"
import { leadStart, linkEnds, nubKey } from "./anchors"
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
  CLEAR,
  elbowBase,
  endTurn,
  obstacles,
  LANE,
  pathClear,
  sharedPins,
  SHARED_STUB,
} from "./lanes"
import type {
  ElbowCable,
  ElbowRoute,
  Obstacles,
  PlanEnd,
  RouteCache,
} from "./lanes"
import {
  BENDY,
  bendyArms,
  bendyCap,
  bendyLine,
  curvedPolyline,
  FAN_BEND,
  fanControls,
  portStub,
  routeThrough,
  STUB,
  withLeads,
} from "./link-geometry"
import type {
  Anchor,
  CablePlan,
  DiagramEdgeData,
  DiagramMode,
  Dir,
  End,
  LineType,
  Pt,
  Rect,
  Route,
} from "./types"

// A Diagram's links planned together, once the cards are placed and every
// end is anchored: each cable's route (elbows in their own lanes, clear of
// the cards they do not connect; bendy curves as drawn while a card is
// dragged, bent otherwise only where that curve would run through a card,
// and round it as an elbow where no curve gets clear; cyclical arcs raised
// round the cards between their ends), then where each port name, middle
// chip and end address goes -
// end labels on their own cable, which breaks for them. A cable on a photo
// port is planned from where its lead leaves the photo, like a nub's; its
// planned points then start at the port itself. So is one off the bottom
// of a photo taking its cables at its edge: its lead is the run past the
// caption, up to the image.
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
  /** The layer bands' title strips (`r`) and the part of each its title
   * chip takes (`chip`): elbows cross a strip but never run along it, and
   * the plan reports what crosses each chip's part. */
  strips?: readonly TitleStrip[]
}

/** A layer band's title strip, as the planner keeps it clear - or a
 * virtual chassis' name strip (`fixed`: its name stays put, so labels keep
 * off it), down the frame's left side (`axis: "v"`) or across its top:
 * crossed, never run along. */
export interface TitleStrip {
  id: string
  r: Rect
  chip: Rect
  axis?: "v"
  fixed?: true
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
  /** Per title strip, the x spans of its chip's part that cables, cards
   * and labels take (`LabelScene.occupied`): where its title may not go. */
  busy?: Map<string, [number, number][]>
  /** Detailed: how each elbow nub's route leaves its side - what
   * `reorderNubs` orders a side by. */
  turns: EndTurns
}

/** How far along its line an end's labels reach (texts `ws` wide, port
 * name first): the lead out of the nub, then the labels one after
 * another. */
export function endRun(ws: readonly number[]): number {
  return ws.length ? LABEL.LEAD + inlineLength(ws) : 0
}

/** The straight run an end's labels (texts `ws` wide, port name first)
 * need before its line may bend: at a Detailed nub or a photo port
 * (`nub`), and there at least a pixel past a photo's `lead`, so a curve
 * carries on from it. 0 for any other end. */
export function nubRun(
  nub: boolean,
  lead: boolean,
  ws: readonly number[]
): number {
  return nub ? Math.max(lead ? 1 : 0, endRun(ws)) : 0
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
  /** The end leaves a Detailed nub, or a photo port. */
  nubA: boolean
  nubB: boolean
  /** The end is a photo port: where its lead starts. Its line is planned
   * from where the lead leaves the photo, as a nub's is. An end off the
   * bottom of a photo taking its cables at its edge has a lead too. */
  leadA?: Pt
  leadB?: Pt
  /** The end is on a photo's port (not a side). */
  portA: boolean
  portB: boolean
  fanLeg: boolean
  /** A bendy line leaving a point it shares: the part of its reach each
   * end bends within (`sharedShares`). */
  share?: [number, number]
  /** A bendy line no curve gets clear of the cards, or a trunk whose port
   * faces away from its legs: routed as an elbow instead. */
  rerouted?: true
}

const dirKey = (e: End) => `${Math.round(e.dir[0])},${Math.round(e.dir[1])}`

/** The port name an end carries: a nub's, or a photo port's. */
const portOf = (a: Anchor | undefined) =>
  (a?.k === "side" || a?.k === "point" ? a.port : undefined) || undefined

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
      const leadA = leadStart(s, aa)
      const leadB = leadStart(t, ba)
      // A photo port's end runs straight out of the photo like a nub's.
      const portA = aa?.k === "point"
      const portB = ba?.k === "point"
      const nubA = (detailed && !d.simple && aa?.k === "side") || portA
      const nubB = (detailed && !d.simple && ba?.k === "side") || portB
      // Port names at a nub or a photo port, or on a Simple line that is
      // one cable (a bundle's line is named by its chip).
      const ports = !d.labels.noPorts && (detailed || d.sem === "cable")
      const named = (x: Anchor | undefined, nub: boolean) =>
        x?.k === "point"
          ? !d.labels.noPorts
          : ports && x?.k === "side" && (nub || !detailed)
      const ta = named(aa, nubA) ? portOf(aa) : undefined
      const tb = named(ba, nubB) ? portOf(ba) : undefined
      const width = (text: string) => endTextWidth(text, input.measure)
      const wa = ta ? width(ta) : 0
      const wb = tb ? width(tb) : 0
      // Addresses only at a card: a breakout's junction end has none.
      const addr = d.labels.ends?.[i]
      const onCard = (x: Anchor | undefined) =>
        x?.k === "side" || x?.k === "point"
      const ia = onCard(aa) && addr?.a?.length ? addr.a : undefined
      const ib = onCard(ba) && addr?.b?.length ? addr.b : undefined
      const wia = (ia ?? []).map(width)
      const wib = (ib ?? []).map(width)
      // A nub's straight run holds its port name, then its addresses; a
      // photo port's runs straight out even with no labels, so a curve
      // carries on from its lead.
      const runA = nubRun(nubA, !!leadA, [...(ta ? [wa] : []), ...wia])
      const runB = nubRun(nubB, !!leadB, [...(tb ? [wb] : []), ...wib])
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
          : d.simple && anchor?.k !== "point"
            ? `${node}\u0000${dirKey(end)}`
            : undefined
      const sa = shared(a, e.source, aa)
      const sb = shared(b, e.target, ba)
      // A trunk is straight - unless its port faces away from its legs,
      // and it goes round to the junction by the far cards.
      const bentTrunk = d.fan?.role === "trunk" && !!d.fan.bent
      out.push({
        edge: e,
        i,
        key: `${e.id}#${i}`,
        // A cyclical link the view's default leaves unarched is bendy.
        line:
          d.fan?.role === "trunk"
            ? bentTrunk
              ? "elbow"
              : "straight"
            : d.line === "cyclical" && !arc
              ? "bendy"
              : d.line,
        ...(bentTrunk ? { rerouted: true as const } : {}),
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
        ...(leadA ? { leadA } : {}),
        ...(leadB ? { leadB } : {}),
        portA,
        portB,
        fanLeg: d.fan?.role === "leg",
      })
    })
  }
  return out
}

const reversed = (pts: readonly Pt[]) => [...pts].reverse()

/** Where a breakout leg may bend, as fractions of its run along the
 * trunk: `first`, then nearer the junction, then nearer the port. */
function fanBends(first: number): number[] {
  const out = [first]
  for (let b = first - 0.1; b >= 0.149; b -= 0.1) out.push(b)
  for (let b = first + 0.1; b <= 0.851; b += 0.1) out.push(b)
  return out
}

/** Reach scales a bendy cable tries when a card is in its way, `[a, b]`
 * for its two ends: its free curve first, then ever further from it.
 * Longer arms swing the curve out past a card, shorter ones tuck it in,
 * and one longer than the other moves its middle towards the shorter
 * one's end; 0 is as short as the arm may go. */
const BENDY_WAYS: readonly (readonly [number, number])[] = (() => {
  const f = [1, 1.3, 0.75, 1.7, 0.55, 2.2, 0.4, 0]
  const off = (x: number) => (x ? Math.abs(Math.log(x)) : 3)
  return f
    .flatMap((a) => f.map((b) => [a, b] as const))
    .sort((p, q) => off(p[0]) + off(p[1]) - off(q[0]) - off(q[1]))
})()

/** Is `c` on from `b` straight along the line from `a` through `b`? */
function onward(a: Pt, b: Pt, c: Pt): boolean {
  const [ux, uy, vx, vy] = [b.x - a.x, b.y - a.y, c.x - b.x, c.y - b.y]
  const size = Math.hypot(ux, uy) * Math.hypot(vx, vy)
  return Math.abs(ux * vy - uy * vx) <= 1e-9 * size && ux * vx + uy * vy >= 0
}

/** Does the curve through `pts` (the curved rule, as drawn) keep clear of
 * the cards it does not connect? Its straight run out of each end is one
 * run, which may touch the card it leaves (`pathClear`). */
function curveClear(obs: Obstacles, pts: Pt[], own: readonly string[]) {
  const line = curvedPolyline(pts)
  const n = line.length
  let i = 1
  while (i < n - 2 && onward(line[0], line[i], line[i + 1])) i++
  let j = n - 2
  while (j > i && onward(line[n - 1], line[j], line[j - 1])) j--
  return pathClear(obs, [line[0], ...line.slice(i, j + 1), line[n - 1]], own)
}

/** A bendy cable's arms: `bendyArms`, shortened where it shares a point
 * (`Item.share`). */
const armsOf = (it: Item) =>
  bendyArms(it.a, it.b, it.runA, it.runB, it.share ?? [1, 1])

/** A bendy cable's curve with nothing in its way: what it draws while a
 * card is dragged (`bendyLine`, `staleBend`). */
const freeBendy = (it: Item): Pt[] =>
  bendyLine(it.a, it.b, it.runA, it.runB, armsOf(it))

/** How far off straight on a line leaving a shared point may head and
 * still run close by the lines turning off to either side of it
 * (radians). */
const ON_AHEAD = 0.35

/**
 * Bendy lines leaving one shared point (a Simple side's midpoint): the
 * part of its reach each end bends within there (`bendyArms`), keyed
 * `<item key><a|b>`. At the same reach they would run over each other
 * well out of the point, where none of their names fits. The line heading
 * most nearly straight on keeps its whole reach; of the others heading
 * off to one side of it, the one heading most steeply out bends soonest,
 * as elbows turn off there (`sharedPins`), so they part and nest instead
 * of crossing.
 */
function sharedShares(all: readonly Item[]): Map<string, number> {
  type Leg = { key: string; angle: number }
  const groups = new Map<string, Leg[]>()
  for (const it of all) {
    if (it.line !== "bendy" || it.fanLeg || it.arc) continue
    for (const end of ["a", "b"] as const) {
      const e = it[end]
      if (!e.shared) continue
      const o = end === "a" ? it.b : it.a
      const [dx, dy] = [o.x - e.x, o.y - e.y]
      const on = dx * e.dir[0] + dy * e.dir[1]
      const aside = dy * e.dir[0] - dx * e.dir[1]
      const list = groups.get(e.shared) ?? []
      list.push({ key: `${it.key}${end}`, angle: Math.atan2(aside, on) })
      groups.set(e.shared, list)
    }
  }
  const out = new Map<string, number>()
  for (const list of groups.values()) {
    if (list.length < 2) continue
    const ahead = list.reduce((p, q) =>
      Math.abs(q.angle) < Math.abs(p.angle) ||
      (Math.abs(q.angle) === Math.abs(p.angle) && q.key < p.key)
        ? q
        : p
    )
    for (const side of [1, -1]) {
      const legs = list
        .filter((m) => m !== ahead && Math.sign(m.angle) === side)
        .sort(
          (p, q) =>
            Math.abs(q.angle) - Math.abs(p.angle) || (p.key < q.key ? -1 : 1)
        )
      const n =
        legs.length +
        (Math.abs(ahead.angle) < ON_AHEAD || Math.sign(ahead.angle) === side
          ? 1
          : 0)
      if (n > 1) legs.forEach((m, rank) => out.set(m.key, (rank + 1) / n))
    }
  }
  return out
}

/**
 * A bendy cable's points: its free curve (`freeBendy`: out along each
 * end's normal, straight past its labels), unless that curve runs through
 * a card it does not connect - then the nearest curve that keeps clear,
 * its arms made longer or shorter (`BENDY_WAYS`), no shorter than its
 * labels' straight run while one of those gets clear. A breakout leg
 * curves like the cable page's fan-out, bending nearer the junction or
 * the port where that keeps it clear. Null for a cable no curve gets
 * clear: it goes round the cards as an elbow.
 */
function bendyPts(it: Item, obs: Obstacles): Pt[] | null {
  const A = { x: it.a.x, y: it.a.y }
  const B = { x: it.b.x, y: it.b.y }
  const own = [it.a.node, it.b.node]
  if (it.fanLeg) {
    // Bend nearer the junction when the far port's name needs the room.
    const along = (B.x - A.x) * it.a.dir[0] + (B.y - A.y) * it.a.dir[1]
    const named = it.runB > 0
    const need = named ? 2 * it.b.stub : 0
    const first =
      along > 0 ? Math.max(0.2, Math.min(FAN_BEND, 1 - need / along)) : FAN_BEND
    for (const bend of fanBends(first)) {
      const fan = fanControls(it.a, it.b, bend)
      if (!fan) break
      // Legs converging on one card run in side by side. A point on the
      // line from the last control point to the port (`x` px out) makes
      // the curved rule end in a truly straight run, half-way back to that
      // control point: at least a stub, so each name keeps its own gap.
      const [, p2] = fan
      const last = Math.hypot(B.x - p2.x, B.y - p2.y)
      const x = Math.max(1, 2 * it.b.stub - last)
      const pts =
        named && x < last - 1
          ? [
              A,
              ...fan,
              { x: B.x + it.b.dir[0] * x, y: B.y + it.b.dir[1] * x },
              B,
            ]
          : [A, ...fan, B]
      // The control polygon is the curve's hull: clear, so is the curve.
      if (pathClear(obs, pts, own)) return pts
    }
  }
  const [ka, kb] = armsOf(it)
  // Pulled in, an arm reaches past its labels while any such curve gets
  // clear; failing that, as short as a curve goes (its labels may then
  // be left off). Reaching further, never past the cap that keeps facing
  // ends from overshooting and waving back.
  const least = (k: number, run: number) =>
    Math.min(k, Math.max(BENDY.MIN, run ? portStub(run) : 0))
  const cap = bendyCap(it.a, it.b)
  const tried = new Set<string>()
  for (const [la, lb] of [
    [least(ka, it.runA), least(kb, it.runB)],
    [Math.min(ka, BENDY.MIN), Math.min(kb, BENDY.MIN)],
  ])
    for (const [fa, fb] of BENDY_WAYS) {
      const arms = [
        Math.min(cap, Math.max(la, ka * fa)),
        Math.min(cap, Math.max(lb, kb * fb)),
      ] as const
      const key = `${arms[0]},${arms[1]}`
      if (tried.has(key)) continue
      tried.add(key)
      const pts = bendyLine(it.a, it.b, it.runA, it.runB, arms)
      if (curveClear(obs, pts, own)) return pts
    }
  return null
}

/** A photo port's line facing away from its far end: out along its lead
 * and round its photo (`pts`, from the end), then on towards the far end
 * from the last of them, along `dir`. */
interface Hook {
  pts: Pt[]
  dir: Dir
}

/** How far past a photo's side a hook turns. */
const HOOK_CLEAR = CLEAR + 4

/** Which way a hook goes: across to the photo's far (`side` 1) or near
 * side, and on past the photo's other edge or not. */
type HookWay = { side: 1 | -1; past: boolean }

const HOOK_WAYS: readonly HookWay[] = [
  { side: 1, past: false },
  { side: -1, past: false },
  { side: 1, past: true },
  { side: -1, past: true },
]

/**
 * Straight and bendy lines out of photo ports that face away from the far
 * end - a port on the top edge cabled to something below. Drawn straight,
 * the line would run back across its own photo; instead it runs out
 * along its lead as far as its labels need, turns round a side of the
 * photo and, where the far end lies behind the photo, on past it, then
 * goes on from there. Of the ways round (both ends' together, when both
 * face away), the shortest that keeps clear of every card - its own
 * included - else the shortest. Ports leaving one edge the same way nest:
 * the one nearer the side turns first and closest, so the runs never
 * cross. Keyed `<item key><a|b>`.
 */
function hooks(
  all: readonly Item[],
  rects: ReadonlyMap<string, Rect>,
  obs: ReturnType<typeof obstacles>
): Map<string, Hook> {
  type Ask = { key: string; at: PlanEnd; r: Rect; way: HookWay; far: number }
  const groups = new Map<string, Ask[]>()
  const facesAway = (at: PlanEnd, to: Pt) =>
    (to.x - at.x) * at.dir[0] + (to.y - at.y) * at.dir[1] < -2
  const length = (pts: readonly Pt[]) =>
    pts.reduce(
      (sum, p, i) =>
        i ? sum + Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) : 0,
      0
    )
  for (const it of all) {
    if (it.line !== "straight" && it.line !== "bendy") continue
    if (it.a.node === it.b.node) continue
    const ra = it.leadA && facesAway(it.a, it.b) ? rects.get(it.a.node) : null
    const rb = it.leadB && facesAway(it.b, it.a) ? rects.get(it.b.node) : null
    if (!ra && !rb) continue
    let best: { a?: HookWay; b?: HookWay; cost: number } | null = null
    for (const wa of ra ? HOOK_WAYS : [undefined])
      for (const wb of rb ? HOOK_WAYS : [undefined]) {
        const pa = wa && ra ? hookPts(it.a, ra, wa, it.a.stub, HOOK_CLEAR) : []
        const pb = wb && rb ? hookPts(it.b, rb, wb, it.b.stub, HOOK_CLEAR) : []
        const pts = [it.a, ...pa, ...[...pb].reverse(), it.b]
        const cost =
          length(pts) + (pathClear(obs, pts, [it.a.node, it.b.node]) ? 0 : 1e6)
        if (!best || cost < best.cost - 1e-6) best = { a: wa, b: wb, cost }
      }
    for (const [end, r, way] of [
      ["a", ra, best!.a],
      ["b", rb, best!.b],
    ] as const) {
      if (!r || !way) continue
      const at = it[end]
      const vertical = Math.abs(at.dir[1]) > 0.5
      const pos = vertical ? at.x : at.y
      const edge = vertical
        ? way.side > 0
          ? r.x + r.w
          : r.x
        : way.side > 0
          ? r.y + r.h
          : r.y
      const g = `${at.node}\u0000${at.dir[0]},${at.dir[1]}\u0000${way.side}`
      const list = groups.get(g) ?? []
      list.push({
        key: `${it.key}${end}`,
        at,
        r,
        way,
        far: Math.abs(edge - pos),
      })
      groups.set(g, list)
    }
  }
  const out = new Map<string, Hook>()
  for (const list of groups.values()) {
    // Nearest the side first: it turns off lowest, the others round it.
    list.sort((p, q) => p.far - q.far || (p.key < q.key ? -1 : 1))
    const base = Math.max(...list.map((x) => x.at.stub))
    list.forEach(({ key, at, r, way }, k) => {
      const [dx, dy] = at.dir
      out.set(key, {
        pts: hookPts(at, r, way, base + k * LANE, HOOK_CLEAR + k * LANE),
        dir: way.past
          ? [-dx, -dy]
          : Math.abs(dy) > 0.5
            ? [way.side, 0]
            : [0, way.side],
      })
    })
  }
  return out
}

/** A hook's points from the end `at` on photo `r`: `len` out, across to
 * `clear` past one side of the photo and, going `past`, on beyond its
 * other edge. */
function hookPts(
  at: End,
  r: Rect,
  way: HookWay,
  len: number,
  clear: number
): Pt[] {
  const [dx, dy] = at.dir
  const o = { x: at.x + dx * len, y: at.y + dy * len }
  if (Math.abs(dy) > 0.5) {
    const x = way.side > 0 ? r.x + r.w + clear : r.x - clear
    return way.past
      ? [o, { x, y: o.y }, { x, y: dy < 0 ? r.y + r.h + clear : r.y - clear }]
      : [o, { x, y: o.y }]
  }
  const y = way.side > 0 ? r.y + r.h + clear : r.y - clear
  return way.past
    ? [o, { x: o.x, y }, { x: dx < 0 ? r.x + r.w + clear : r.x - clear, y }]
    : [o, { x: o.x, y }]
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

/** A line that is one straight run past its end's lead (`pts`, leads
 * left out), walked from one of its ends: where the walk would start
 * were it all one line, and which way it runs (`InlineAsk.line`). The
 * walk's first `lead` px go over the photo, off that line. */
function lineOf(
  pts: readonly Pt[],
  fromEnd: boolean,
  lead: number
): InlineAsk["line"] {
  if (pts.length !== 2) return undefined
  const [p, q] = fromEnd ? [pts[1], pts[0]] : pts
  const len = Math.hypot(q.x - p.x, q.y - p.y)
  if (!(len > 0)) return undefined
  const u = { x: (q.x - p.x) / len, y: (q.y - p.y) / len }
  return { at: { x: p.x - u.x * lead, y: p.y - u.y * lead }, u }
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
  // Every 8px or so: a long curve's chords stray from it further than a
  // label clears it by.
  const n = Math.max(32, Math.ceil(route.length / 8))
  const out: Pt[] = []
  for (let i = 0; i <= n; i++) {
    const p = route.at(i / n)
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
  // Elbows keep their runs out of the bands' title strips too.
  const strips = (input.strips ?? []).map(
    (s): [string, Rect] | [string, Rect, "v"] =>
      s.axis
        ? [`\u0000strip:${s.id}`, s.r, s.axis]
        : [`\u0000strip:${s.id}`, s.r]
  )
  const lanesObs = strips.length ? obstacles(cards, strips) : obs
  input.routes?.begin(
    strips.length
      ? [...cards, ...strips.map(([id, r]): [string, Rect] => [id, r])]
      : cards,
    lanesObs
  )
  const turns = new Map<
    string,
    { turn: -1 | 0 | 1; depth: number; extent: number }
  >()

  // Photo ports facing away from their far ends: their straight and
  // bendy lines go round their photos first.
  const hooked = hooks(all, input.rects, obs)
  const straight = (it: Item): Pt[] => [
    { x: it.a.x, y: it.a.y },
    { x: it.b.x, y: it.b.y },
  ]
  /** An item's line (`line`, from its ends), each hooked end first out
   * along its lead and round its photo; null when `line` gives none. */
  const withHooks = (
    it: Item,
    line: (it: Item) => Pt[] | null
  ): Pt[] | null => {
    const ha = hooked.get(`${it.key}a`)
    const hb = hooked.get(`${it.key}b`)
    if (!ha && !hb) return line(it)
    // Past a hook the line leaves its photo's side: the photo is in its
    // way like any card, and its labels are on the hook.
    const from = (end: PlanEnd, h: Hook): PlanEnd => ({
      ...end,
      ...h.pts[h.pts.length - 1],
      dir: h.dir,
      node: "",
      stub: STUB,
    })
    const mid = line({
      ...it,
      a: ha ? from(it.a, ha) : it.a,
      b: hb ? from(it.b, hb) : it.b,
      runA: ha ? 0 : it.runA,
      runB: hb ? 0 : it.runB,
    })
    if (!mid) return null
    // The hooks' last points are where `mid` starts and ends.
    const pts = [
      ...(ha ? [{ x: it.a.x, y: it.a.y }, ...ha.pts.slice(0, -1)] : []),
      ...mid,
      ...(hb
        ? [...hb.pts.slice(0, -1).reverse(), { x: it.b.x, y: it.b.y }]
        : []),
    ]
    // A curve runs straight out along the hook for its labels.
    return it.line === "straight"
      ? pts
      : withLeads(pts, ha ? it.runA : 0, hb ? it.runB : 0)
  }
  const curve = (it: Item) => bendyPts(it, obs)

  // Bendy lines first, those sharing a point each bending within a reach
  // of its own: one no curve gets clear of the cards goes round them as
  // an elbow, in the lanes with the others.
  const shares = sharedShares(all)
  for (const it of all) {
    const sa = shares.get(`${it.key}a`)
    const sb = shares.get(`${it.key}b`)
    if (sa || sb) it.share = [sa ?? 1, sb ?? 1]
  }
  const bent = new Map<string, Pt[]>()
  for (const it of all) {
    if (it.line !== "bendy") continue
    const pts = withHooks(it, curve)
    if (pts) bent.set(it.key, pts)
    else {
      it.line = "elbow"
      it.rerouted = true
    }
  }

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
      ? input.routes.route(c, lanesObs, pa, pb)
      : elbowBase(c, lanesObs, pa, pb)
  })
  elbows.forEach((it, j) => {
    const pts = routes[j].pts
    if (it.nubA && !it.portA)
      turns.set(
        nubKey({ link: it.edge.id, cable: it.i, end: "a" }),
        endTurn(pts, it.a)
      )
    if (it.nubB && !it.portB)
      turns.set(
        nubKey({ link: it.edge.id, cable: it.i, end: "b" }),
        endTurn(reversed(pts), it.b)
      )
  })
  if (opts.turnsOnly) return { plans: new Map(), turns }
  assignLanes(routes, cables, lanesObs)

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
              // Out of a nub square to the card, as far as its labels.
              lead: [
                it.nubA ? Math.max(STUB, it.runA + 2) : 0,
                it.nubB ? Math.max(STUB, it.runB + 2) : 0,
              ],
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
          ? (bent.get(it.key) ??
            withHooks(it, curve) ??
            withHooks(it, freeBendy) ?? [A, B])
          : (withHooks(it, straight) ?? [A, B])
    )
  }
  // A photo port's lead joins its route: the planned points start (or
  // end) at the port. Every label is placed on the route as drawn, lead
  // included - a curve through one point more is another curve.
  const withLead = (it: Item) => {
    const pts = ptsOf.get(it.key)!
    if (!it.leadA && !it.leadB) return pts
    return [
      ...(it.leadA ? [it.leadA] : []),
      ...pts,
      ...(it.leadB ? [it.leadB] : []),
    ]
  }
  /** How far an end's lead runs over its photo before the line leaves. */
  const leadOf = (it: Item, end: "a" | "b") => {
    const from = end === "a" ? it.leadA : it.leadB
    const to = it[end]
    return from ? Math.hypot(to.x - from.x, to.y - from.y) : 0
  }
  const drawnPts = new Map<string, Pt[]>()
  const routeOf = new Map<string, Route>()
  for (const it of all) {
    const pts = withLead(it)
    drawnPts.set(it.key, pts)
    routeOf.set(it.key, routeThrough(it.line, pts, it.a.dir))
  }

  // Labels: port names first (they belong to one spot), then the chips,
  // then the addresses after each port name.
  const scene = new LabelScene(
    all.map((it): [string, Pt[]] => [
      it.key,
      polyline(it.line, drawnPts.get(it.key)!, routeOf.get(it.key)!),
    ]),
    [
      ...[...input.rects].filter(([id]) => input.solid(id)).map(([, r]) => r),
      ...(input.strips ?? []).filter((s) => s.fixed).map((s) => s.r),
    ]
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
      const line = lineOf(ptsOf.get(it.key)!, end === "b", leadOf(it, end))
      // Past the lead: a photo port's name starts where its line leaves
      // the photo, as a nub's does.
      const from = leadOf(it, end) + LABEL.LEAD
      asks.push({
        key: `${it.key}${end}`,
        cable: it.key,
        ws,
        walk: walker(route, end === "b"),
        ...(line ? { line } : {}),
        from,
        // A nub's name keeps to its run; a Simple line's finds its own.
        until: nub
          ? labelledAt(it, end === "a" ? "b" : "a")
            ? route.length / 2
            : route.length - LABEL.LEAD
          : reach(route, from, ws, labelledAt(it, end === "a" ? "b" : "a")),
        ...(nub ? { first: true, run: leadOf(it, end) } : {}),
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
      const from = port ? port.reach + LABEL.LEAD : leadOf(it, end) + LABEL.LEAD
      const line = lineOf(ptsOf.get(it.key)!, end === "b", leadOf(it, end))
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
        pts: drawnPts.get(it.key)!,
        ...(it.rerouted ? { line: "elbow" as const } : {}),
        ...((it.line === "bendy" || it.line === "cyclical") && !arcs.has(it.key)
          ? {
              bend: {
                runs: [it.runA, it.runB] as [number, number],
                ...(it.share ? { share: it.share } : {}),
              },
            }
          : {}),
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
  const busy = new Map<string, [number, number][]>()
  for (const s of input.strips ?? [])
    if (!s.fixed) busy.set(s.id, scene.occupied(s.chip))
  return { plans, turns, ...(busy.size ? { busy } : {}) }
}
