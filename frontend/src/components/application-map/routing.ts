import { measureText } from "@/lib/diagram/measure"
import type { Measure } from "@/lib/diagram/measure"
import { LABEL } from "@/lib/diagram/theme"
import {
  LabelScene,
  placeChips,
} from "@/components/topology/diagram/label-placement"
import type { ChipAsk } from "@/components/topology/diagram/label-placement"
import {
  STUB,
  curvedPolyline,
  routeThrough,
} from "@/components/topology/diagram/link-geometry"
import type {
  Dir,
  End,
  LineType,
  Pt,
  Rect,
  Route,
} from "@/components/topology/diagram/types"

import type { AppCardNode, AppEdge, AppMapGraph } from "./model"

// Where the Application map's lines run (#163): every line planned from
// the cards as they stand, so it clears every card it does not join, and
// stored on the edge (`plan`) for the canvas (LinkEdge draws a plan while
// its cards stay put) and the export alike.
//
// - Tree, parent to child: an elbow through the middle of the gap between
//   the two rows.
// - Tree, installed on: each application owns a slot - a horizontal
//   channel - in the gap above the Hosts row, its line drops from the
//   card into that slot, runs along it and drops into its host at the
//   application's own point on the host's top edge. Lines of one
//   application run as one bundle; no two bundles share a channel.
// - Flows: out of the right side, into the left (or back the other way),
//   curved through a vertical channel in the gap between the columns, a
//   channel per line so a fan-out spreads.
//
// Any line that would still touch a card it does not join - a card dragged
// into its way, a line spanning a column - is routed round the cards as
// an elbow (`orthoPath`). Middle labels (a flow's ports) sit where the
// topology puts them: on the line clear of cards and other labels, else
// shown on hover only.

/** The gap a card keeps round lines that pass it. */
export const CLEAR = 8

/** What a line routed round the cards pays for each turn, in px. */
const BEND = 40

/** Sample spacing when a route is checked against the cards, px. */
const SAMPLE = 4

const r1 = (v: number) => Math.round(v * 10) / 10

/** A card's box, from its centre. */
export function boxOf(n: AppCardNode): Rect {
  const w = n.width ?? n.data.diagram.box.w
  const h = n.height ?? n.data.diagram.box.h
  return { x: n.position.x - w / 2, y: n.position.y - h / 2, w, h }
}

const inflate = (r: Rect, d: number): Rect => ({
  x: r.x - d,
  y: r.y - d,
  w: r.w + 2 * d,
  h: r.h + 2 * d,
})

const inside = (p: Pt, r: Rect) =>
  p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h

/** A drawn route's points every `SAMPLE` px, ends included. */
export function samples(route: Pick<Route, "length" | "at">): Pt[] {
  const n = Math.max(2, Math.ceil(route.length / SAMPLE))
  const out: Pt[] = []
  for (let i = 0; i <= n; i++) {
    const p = route.at(i / n)
    out.push({ x: p.x, y: p.y })
  }
  return out
}

/** Does a route touch a card it does not join (`others`, kept `pad` px
 * off), or cut through one of its own (`own`)? */
export function routeHits(
  route: Pick<Route, "length" | "at">,
  others: readonly Rect[],
  own: readonly Rect[] = [],
  pad = 3
): boolean {
  const near = others.map((r) => inflate(r, pad))
  const mine = own.map((r) => inflate(r, -1))
  for (const p of samples(route))
    if (near.some((r) => inside(p, r)) || mine.some((r) => inside(p, r)))
      return true
  return false
}

// ── Round the cards ───────────────────────────────────────────────────────

/** A small binary heap of [cost, state]. */
class Heap {
  private a: [number, number][] = []
  get size() {
    return this.a.length
  }
  push(cost: number, v: number) {
    const a = this.a
    a.push([cost, v])
    let i = a.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (a[p][0] <= a[i][0]) break
      ;[a[p], a[i]] = [a[i], a[p]]
      i = p
    }
  }
  pop(): [number, number] {
    const a = this.a
    const top = a[0]
    const last = a.pop()!
    if (a.length) {
      a[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < a.length && a[l][0] < a[m][0]) m = l
        if (r < a.length && a[r][0] < a[m][0]) m = r
        if (m === i) break
        ;[a[m], a[i]] = [a[i], a[m]]
        i = m
      }
    }
    return top
  }
}

const DIRS: Dir[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
]
const dirIndex = (d: Dir) =>
  DIRS.findIndex(
    (x) =>
      x[0] === Math.sign(Math.round(d[0])) &&
      x[1] === Math.sign(Math.round(d[1]))
  )

/** Collinear corners and repeated points out. */
function simplify(pts: Pt[]): Pt[] {
  const out: Pt[] = []
  for (const p of pts) {
    const last = out.at(-1)
    if (last && Math.abs(last.x - p.x) < 0.01 && Math.abs(last.y - p.y) < 0.01)
      continue
    const prev = out.at(-2)
    if (last && prev) {
      const ax = last.x - prev.x
      const ay = last.y - prev.y
      const bx = p.x - last.x
      const by = p.y - last.y
      if (Math.abs(ax * by - ay * bx) < 0.01 && ax * bx + ay * by > 0) out.pop()
    }
    out.push(p)
  }
  return out
}

function segBlocked(p: Pt, q: Pt, rects: readonly Rect[]): boolean {
  const x0 = Math.min(p.x, q.x)
  const x1 = Math.max(p.x, q.x)
  const y0 = Math.min(p.y, q.y)
  const y1 = Math.max(p.y, q.y)
  for (const r of rects)
    if (x1 > r.x && x0 < r.x + r.w && y1 > r.y && y0 < r.y + r.h) return true
  return false
}

function search(
  a: End,
  b: End,
  rects: readonly Rect[],
  stub: number
): Pt[] | null {
  const A1 = { x: a.x + a.dir[0] * stub, y: a.y + a.dir[1] * stub }
  const B1 = { x: b.x + b.dir[0] * stub, y: b.y + b.dir[1] * stub }
  const blocked = rects.map((r) => inflate(r, CLEAR))
  if (blocked.some((r) => inside(A1, r) || inside(B1, r))) return null
  const axis = (
    pick: (p: Pt) => number,
    lo: (r: Rect) => number,
    hi: (r: Rect) => number
  ) => {
    const vals = new Set<number>([pick(A1), pick(B1)])
    for (const r of blocked) {
      vals.add(r1(lo(r)))
      vals.add(r1(hi(r)))
    }
    const sorted = [...vals].sort((x, y) => x - y)
    const all = new Set(sorted)
    for (let i = 1; i < sorted.length; i++)
      all.add(r1((sorted[i - 1] + sorted[i]) / 2))
    all.add(sorted[0] - 40)
    all.add(sorted[sorted.length - 1] + 40)
    return [...all].sort((x, y) => x - y)
  }
  const xs = axis(
    (p) => p.x,
    (r) => r.x,
    (r) => r.x + r.w
  )
  const ys = axis(
    (p) => p.y,
    (r) => r.y,
    (r) => r.y + r.h
  )
  const nx = xs.length
  const ny = ys.length
  const at = (i: number, j: number): Pt => ({ x: xs[i], y: ys[j] })
  const free = new Uint8Array(nx * ny)
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < ny; j++)
      free[i * ny + j] = blocked.some((r) => inside(at(i, j), r)) ? 0 : 1
  const si = xs.indexOf(A1.x) * ny + ys.indexOf(A1.y)
  const ti = xs.indexOf(B1.x) * ny + ys.indexOf(B1.y)
  const sd = dirIndex(a.dir)
  // Arrive heading into the target card: against its outward normal.
  const td = dirIndex([-b.dir[0], -b.dir[1]])
  const N = nx * ny * 4
  const dist = new Float64Array(N).fill(Infinity)
  const prev = new Int32Array(N).fill(-1)
  const heap = new Heap()
  const h = (cell: number) => {
    const p = at(Math.floor(cell / ny), cell % ny)
    return Math.abs(p.x - B1.x) + Math.abs(p.y - B1.y)
  }
  const start = si * 4 + sd
  dist[start] = 0
  heap.push(h(si), start)
  let end = -1
  while (heap.size) {
    const [, s] = heap.pop()
    const cell = s >> 2
    const d = s & 3
    // Arriving sideways was charged a turn on the way in: the first
    // arrival out of the heap is the cheapest.
    if (cell === ti) {
      end = s
      break
    }
    const i = Math.floor(cell / ny)
    const j = cell % ny
    const p = at(i, j)
    for (let k = 0; k < 4; k++) {
      // No turning straight back.
      if (DIRS[k][0] === -DIRS[d][0] && DIRS[k][1] === -DIRS[d][1]) continue
      const ni = i + DIRS[k][0]
      const nj = j + DIRS[k][1]
      if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue
      const nc = ni * ny + nj
      if (!free[nc]) continue
      const q = at(ni, nj)
      if (segBlocked(p, q, blocked)) continue
      let cost =
        dist[s] +
        Math.abs(q.x - p.x) +
        Math.abs(q.y - p.y) +
        (k === d ? 0 : BEND)
      if (nc === ti && k !== td) cost += BEND
      const ns = nc * 4 + k
      if (cost < dist[ns]) {
        dist[ns] = cost
        prev[ns] = s
        heap.push(cost + h(nc), ns)
      }
    }
  }
  if (end < 0) return null
  const cells: Pt[] = []
  for (let s = end; s >= 0; s = prev[s]) {
    const c = s >> 2
    cells.push(at(Math.floor(c / ny), c % ny))
  }
  cells.reverse()
  return simplify([{ x: a.x, y: a.y }, ...cells, { x: b.x, y: b.y }])
}

/**
 * An orthogonal path from `a` to `b` (ends with their outward normals)
 * that keeps `CLEAR` px off every card in `cards`: a short search over the
 * lines the cards' edges and the gaps between them make, paying `BEND`
 * for each turn. Terminals included; null when there is no way through.
 * The cards near the two ends are tried first, then all of them.
 */
export function orthoPath(
  a: End,
  b: End,
  cards: readonly Rect[],
  stub = STUB + CLEAR
): Pt[] | null {
  const pad = 240
  const x0 = Math.min(a.x, b.x) - pad
  const x1 = Math.max(a.x, b.x) + pad
  const y0 = Math.min(a.y, b.y) - pad
  const y1 = Math.max(a.y, b.y) + pad
  const near = cards.filter(
    (r) => r.x < x1 && r.x + r.w > x0 && r.y < y1 && r.y + r.h > y0
  )
  const first = search(a, b, near, stub)
  if (first && !routeHits(routeThrough("elbow", first, a.dir), cards, [], 1))
    return first
  return near.length === cards.length ? first : search(a, b, cards, stub)
}

// ── Plans ────────────────────────────────────────────────────────────────

interface Planned {
  pts: Pt[]
  line: LineType
}

const end = (x: number, y: number, dir: Dir): End => ({ x, y, dir })

/** A line's ends' boxes and every other card's. */
function boxesFor(
  e: AppEdge,
  boxes: ReadonlyMap<string, Rect>
): { s: Rect; t: Rect; others: Rect[] } | null {
  const s = boxes.get(e.source)
  const t = boxes.get(e.target)
  if (!s || !t) return null
  const others: Rect[] = []
  for (const [id, r] of boxes)
    if (id !== e.source && id !== e.target) others.push(r)
  return { s, t, others }
}

/** `pts` drawn as `line` when that clears the cards; else round them. */
function settle(
  want: Planned,
  a: End,
  b: End,
  s: Rect,
  t: Rect,
  others: Rect[]
): Planned {
  const route = routeThrough(want.line, want.pts, a.dir)
  if (!routeHits(route, others, [s, t])) return want
  const round = orthoPath(a, b, [...others, s, t])
  return round ? { pts: round, line: "elbow" } : want
}

/** The Tree's install lines: an application's slot in the Hosts gap, and
 * its point on each host's top edge. */
function installPlans(
  graph: AppMapGraph,
  boxes: ReadonlyMap<string, Rect>
): Map<string, Planned> {
  const out = new Map<string, Planned>()
  const lines = graph.edges.filter((e) => e.data?.kind === "install")
  if (!lines.length) return out
  const gap = graph.hostGap
  const bySource = new Map<string, AppEdge[]>()
  for (const e of lines)
    (bySource.get(e.source) ?? bySource.set(e.source, []).get(e.source)!).push(
      e
    )
  const parents = new Set(
    graph.edges.filter((e) => e.data?.kind === "child").map((e) => e.source)
  )

  // Each host's points along its top edge, in its applications' order
  // left to right.
  const anchor = new Map<string, number>()
  const byTarget = new Map<string, AppEdge[]>()
  for (const e of lines)
    (byTarget.get(e.target) ?? byTarget.set(e.target, []).get(e.target)!).push(
      e
    )
  const cx = (id: string) => {
    const r = boxes.get(id)
    return r ? r.x + r.w / 2 : 0
  }
  for (const [host, list] of byTarget) {
    const r = boxes.get(host)
    if (!r) continue
    const sorted = [...list].sort(
      (p, q) => cx(p.source) - cx(q.source) || (p.source < q.source ? -1 : 1)
    )
    sorted.forEach((e, i) =>
      anchor.set(e.id, r.x + ((i + 1) * r.w) / (sorted.length + 1))
    )
  }

  // Where each application's line leaves its card: the bottom's middle,
  // or beside it when its children's lines take the middle.
  const drop = (id: string) => {
    const r = boxes.get(id)!
    return r.x + r.w / 2 + (parents.has(id) ? Math.min(r.w / 4, 20) : 0)
  }
  // The slots: the widest bundle highest, the narrowest next to the hosts,
  // so a short bundle's lines cross the fewest others.
  const span = (src: string) => {
    const xs = [
      drop(src),
      ...bySource.get(src)!.map((e) => anchor.get(e.id) ?? 0),
    ]
    return Math.max(...xs) - Math.min(...xs)
  }
  const order = [...bySource.keys()].sort(
    (p, q) => span(q) - span(p) || cx(p) - cx(q) || (p < q ? -1 : 1)
  )
  const slots = appSlots(order, gap)

  for (const [src, list] of bySource) {
    const s = boxes.get(src)
    if (!s) continue
    const dx = drop(src)
    const y = slots.get(src)
    for (const e of list) {
      const t = boxes.get(e.target)
      const ax = anchor.get(e.id)
      if (!t || ax === undefined) continue
      const a = end(dx, s.y + s.h, [0, 1])
      const b = end(ax, t.y, [0, -1])
      const others: Rect[] = []
      for (const [id, r] of boxes)
        if (id !== src && id !== e.target) others.push(r)
      // A host dragged above its application: round the cards.
      const lane =
        y !== undefined && y > a.y + 4 && y < b.y - 4 ? y : (a.y + b.y) / 2
      const want: Planned = {
        pts: simplify([
          { x: a.x, y: a.y },
          { x: a.x, y: lane },
          { x: b.x, y: lane },
          { x: b.x, y: b.y },
        ]),
        line: "elbow",
      }
      out.set(e.id, settle(want, a, b, s, t, others))
    }
  }
  return out
}

/** Each application's channel in the gap above the Hosts row, in `order`
 * top to bottom, evenly spread. */
export function appSlots(
  order: readonly string[],
  gap: { top: number; bottom: number } | undefined
): Map<string, number> {
  const out = new Map<string, number>()
  if (!gap || !order.length) return out
  const pitch = (gap.bottom - gap.top) / order.length
  order.forEach((id, i) => out.set(id, r1(gap.top + (i + 0.5) * pitch)))
  return out
}

/** A parent's line to a child: an elbow through the gap between them. */
function childPlan(
  e: AppEdge,
  boxes: ReadonlyMap<string, Rect>
): Planned | null {
  const got = boxesFor(e, boxes)
  if (!got) return null
  const { s, t, others } = got
  const a = end(s.x + s.w / 2, s.y + s.h, [0, 1])
  const b = end(t.x + t.w / 2, t.y, [0, -1])
  const mid = (a.y + b.y) / 2
  const want: Planned = {
    pts: simplify([
      { x: a.x, y: a.y },
      { x: a.x, y: mid },
      { x: b.x, y: mid },
      { x: b.x, y: b.y },
    ]),
    line: "elbow",
  }
  if (b.y <= a.y + 2 * STUB) {
    const round = orthoPath(a, b, [...others, s, t])
    return round ? { pts: round, line: "elbow" } : want
  }
  return settle(want, a, b, s, t, others)
}

/** The Flows' lines: side to facing side, through a channel of their own
 * in the gap between the two columns. */
function flowPlans(
  graph: AppMapGraph,
  boxes: ReadonlyMap<string, Rect>
): Map<string, Planned> {
  const out = new Map<string, Planned>()
  type Ask = { e: AppEdge; a: End; b: End; s: Rect; t: Rect; others: Rect[] }
  const gaps = new Map<string, Ask[]>()
  const rest: Ask[] = []
  for (const e of graph.edges) {
    if (e.data?.kind !== "flow") continue
    const got = boxesFor(e, boxes)
    if (!got) continue
    const { s, t, others } = got
    const sy = s.y + s.h / 2
    const ty = t.y + t.h / 2
    if (t.x >= s.x + s.w + 2 * STUB) {
      const ask = {
        e,
        a: end(s.x + s.w, sy, [1, 0]),
        b: end(t.x, ty, [-1, 0]),
        s,
        t,
        others,
      }
      const k = `${r1(s.x + s.w)}|${r1(t.x)}`
      ;(gaps.get(k) ?? gaps.set(k, []).get(k)!).push(ask)
    } else if (s.x >= t.x + t.w + 2 * STUB) {
      const ask = {
        e,
        a: end(s.x, sy, [-1, 0]),
        b: end(t.x + t.w, ty, [1, 0]),
        s,
        t,
        others,
      }
      const k = `${r1(t.x + t.w)}|${r1(s.x)}`
      ;(gaps.get(k) ?? gaps.set(k, []).get(k)!).push(ask)
    } else {
      // One column: out of the right side and back into it.
      rest.push({
        e,
        a: end(s.x + s.w, sy, [1, 0]),
        b: end(t.x + t.w, ty, [1, 0]),
        s,
        t,
        others,
      })
    }
  }
  for (const [k, asks] of gaps) {
    const [lo, hi] = k.split("|").map(Number)
    // A source's lines to far rows turn first, so its fan does not cross
    // itself; sources top to bottom.
    asks.sort(
      (p, q) =>
        p.a.y - q.a.y ||
        Math.abs(q.b.y - q.a.y) - Math.abs(p.b.y - p.a.y) ||
        (p.e.id < q.e.id ? -1 : 1)
    )
    const leftToRight = asks.map((x) => (x.a.x <= x.b.x ? x : null))
    asks.forEach((x, i) => {
      const f = (i + 1) / (asks.length + 1)
      // Lines running right to left take the channels mirrored.
      const cxv = leftToRight[i] ? lo + f * (hi - lo) : hi - f * (hi - lo)
      const want: Planned = {
        pts: [
          { x: x.a.x, y: x.a.y },
          { x: r1(cxv), y: x.a.y },
          { x: r1(cxv), y: x.b.y },
          { x: x.b.x, y: x.b.y },
        ],
        line: Math.abs(x.a.y - x.b.y) < 0.5 ? "straight" : "bendy",
      }
      if (want.line === "straight") want.pts = [want.pts[0], want.pts[3]]
      out.set(x.e.id, settle(want, x.a, x.b, x.s, x.t, x.others))
    })
  }
  for (const x of rest) {
    const round = orthoPath(x.a, x.b, [...x.others, x.s, x.t])
    if (round) out.set(x.e.id, { pts: round, line: "elbow" })
  }
  return out
}

/** A plan's polyline, as the label placer sees it. */
function polyline(p: Planned): Pt[] {
  return p.line === "bendy" ? curvedPolyline(p.pts) : p.pts
}

/**
 * Every line of a map planned from its cards as they stand, with its
 * middle label placed: the graph with `plan`, `planAt` and the label's
 * place (`midT`, `midOff`, `crowded`) on each edge.
 */
export function routeGraph(
  graph: AppMapGraph,
  measure: Measure = measureText
): AppMapGraph {
  const boxes = new Map<string, Rect>()
  for (const n of graph.nodes) if (!n.hidden) boxes.set(n.id, boxOf(n))
  const plans = new Map<string, Planned>([
    ...installPlans(graph, boxes),
    ...flowPlans(graph, boxes),
  ])
  for (const e of graph.edges)
    if (e.data?.kind === "child") {
      const p = childPlan(e, boxes)
      if (p) plans.set(e.id, p)
    }

  // Middle labels: on the line, clear of the cards and of each other.
  const scene = new LabelScene(
    [...plans].map(([id, p]) => [id, polyline(p)] as [string, Pt[]]),
    boxes.values()
  )
  const asks: ChipAsk[] = []
  for (const e of graph.edges) {
    const p = plans.get(e.id)
    const mid = e.data?.labels.mid ?? []
    if (!p || !mid.length) continue
    const route = routeThrough(p.line, p.pts, [1, 0])
    asks.push({
      key: e.id,
      w:
        Math.max(...mid.map((m) => measure(m, LABEL.MID_SIZE, 600))) +
        2 * LABEL.PAD_X,
      h: mid.length * LABEL.MID_LH + 3,
      at: (u) => route.at(u),
      own: new Set([e.id]),
    })
  }
  const chips = placeChips(asks, scene)

  return {
    ...graph,
    edges: graph.edges.map((e) => {
      const p = plans.get(e.id)
      const s = boxes.get(e.source)
      const t = boxes.get(e.target)
      if (!p || !s || !t || !e.data) return e
      const chip = chips.get(e.id)
      const {
        plan: _plan,
        planAt: _at,
        midT: _t,
        midOff: _o,
        crowded: _c,
        ...data
      } = e.data
      return {
        ...e,
        data: {
          ...data,
          plan: [{ pts: p.pts, line: p.line }],
          planAt: [s.x, s.y, t.x, t.y] as [number, number, number, number],
          ...(chip
            ? {
                midT: chip.t,
                ...(chip.off ? { midOff: chip.off } : {}),
                ...(chip.crowded ? { crowded: true } : {}),
              }
            : {}),
        },
      }
    }),
  }
}

/** A planned line's drawn route (the canvas's and the export's). */
export function plannedRoute(e: AppEdge): Route | null {
  const p = e.data?.plan?.[0]
  if (!p) return null
  return routeThrough(p.line ?? e.data!.line, p.pts, [1, 0])
}
