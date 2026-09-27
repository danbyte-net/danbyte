import type { Edge, Node } from "@xyflow/react"

import { LABEL } from "@/lib/diagram/theme"
import { inlineBox } from "../diagram/label-placement"
import { routeThrough, leaves } from "../diagram/link-geometry"
import { boxesOverlap, segHitsBox, segHitsRect } from "../diagram/spatial"
import type { TurnedBox } from "../diagram/spatial"
import type { Anchor, DiagramEdgeData, Pt, Rect } from "../diagram/types"

// Checks the Diagram's planned lines against the rules the owner set: no
// two cables on one run, no line behind a card it does not connect, and
// end labels (port names, addresses) ON their own cable, clear of
// everything else.

export interface Drawn {
  edge: string
  cable: number
  line: string
  source: string
  target: string
  /** Terminals included; curves sampled. */
  pts: Pt[]
  /** The ends meet a shared point (a Simple side midpoint, a junction). */
  sharedA: boolean
  sharedB: boolean
  labels: {
    end: "a" | "b"
    text: string
    box: TurnedBox
    along: number
    /** An address, after the port name. */
    ip?: boolean
  }[]
}

export function boxOf(n: Node): Rect {
  return {
    x: n.position.x - n.width! / 2,
    y: n.position.y - n.height! / 2,
    w: n.width!,
    h: n.height!,
  }
}

/** Every planned cable of a build, as drawn. */
export function drawn(
  nodes: readonly Node[],
  edges: readonly Edge[],
  measure: (t: string, s: number, w?: 400 | 500 | 600 | 700) => number
): Drawn[] {
  const kinds = new Map(nodes.map((n) => [n.id, n.type]))
  const out: Drawn[] = []
  for (const e of edges) {
    const d = e.data as DiagramEdgeData | undefined
    if (e.type !== "link" || !d?.plan) continue
    d.plan.forEach((p, i) => {
      const route = routeThrough(d.line, p.pts, leaves(p.pts))
      const pts =
        d.line === "bendy" || d.line === "cyclical"
          ? Array.from({ length: 33 }, (_, k) => {
              const q = route.at(k / 32)
              return { x: q.x, y: q.y }
            })
          : route.pts
      const labels: Drawn["labels"] = []
      for (const end of ["a", "b"] as const) {
        const start = end === "a" ? route.pts[0] : route.pts.at(-1)!
        const add = (text: string, place: Pt & { rotate: number }, ip?: true) =>
          labels.push({
            end,
            text,
            box: inlineBox(place, measure(text, LABEL.END_SIZE, 400)),
            along: Math.hypot(place.x - start.x, place.y - start.y),
            ...(ip ? { ip } : {}),
          })
        const place = p[end]
        const anchor = d[end][i] as Anchor | undefined
        if (place && anchor?.k === "side" && anchor.port)
          add(anchor.port, place)
        const ips = p.ips?.[end]
        const texts = d.labels.ends?.[i]?.[end] ?? []
        ips?.forEach((at, k) => {
          if (texts[k]) add(texts[k], at, true)
        })
      }
      out.push({
        edge: e.id,
        cable: i,
        line: d.line,
        source: e.source,
        target: e.target,
        pts,
        sharedA: !!d.simple || kinds.get(e.source) === "junction",
        sharedB: !!d.simple || kinds.get(e.target) === "junction",
        labels,
      })
    })
  }
  return out
}

interface Seg {
  p: Pt
  q: Pt
  i: number
  n: number
}

const segs = (pts: Pt[]): Seg[] =>
  pts.slice(1).map((q, i) => ({ p: pts[i], q, i, n: pts.length - 1 }))

const horiz = (s: Seg) => Math.abs(s.p.y - s.q.y) < 1e-6
const vert = (s: Seg) => Math.abs(s.p.x - s.q.x) < 1e-6

/**
 * Pairs of cables with parallel runs closer than `gap` that overlap by
 * more than a pixel - two lines drawn on (or beside) each other. Runs out
 * of a shared point are exempt for their first `shared` px.
 */
export function crowdedRuns(
  cables: readonly Drawn[],
  gap: number,
  shared = 8 + 12 * 8
): string[] {
  const out: string[] = []
  for (let x = 0; x < cables.length; x++)
    for (let y = x + 1; y < cables.length; y++) {
      const A = cables[x]
      const B = cables[y]
      if (A.line !== "elbow" || B.line !== "elbow") continue
      for (const s of segs(A.pts))
        for (const t of segs(B.pts)) {
          const h = horiz(s) && horiz(t)
          const v = vert(s) && vert(t)
          if (!h && !v) continue
          const cs = h ? s.p.y : s.p.x
          const ct = h ? t.p.y : t.p.x
          if (Math.abs(cs - ct) >= gap) continue
          const [s0, s1] = h
            ? [Math.min(s.p.x, s.q.x), Math.max(s.p.x, s.q.x)]
            : [Math.min(s.p.y, s.q.y), Math.max(s.p.y, s.q.y)]
          const [t0, t1] = h
            ? [Math.min(t.p.x, t.q.x), Math.max(t.p.x, t.q.x)]
            : [Math.min(t.p.y, t.q.y), Math.max(t.p.y, t.q.y)]
          const lap = Math.min(s1, t1) - Math.max(s0, t0)
          if (lap <= 1) continue
          // Lines leaving one shared point run together for a moment.
          const fromShared = (c: Drawn, g: Seg) =>
            (g.i === 0 && c.sharedA) || (g.i === g.n - 1 && c.sharedB)
          if (fromShared(A, s) && fromShared(B, t) && lap <= shared) continue
          out.push(`${A.edge}#${A.cable} ~ ${B.edge}#${B.cable}`)
        }
    }
  return out
}

/** Cables that pass through a card they do not connect. */
export function throughCards(
  cables: readonly Drawn[],
  cards: ReadonlyMap<string, Rect>
): string[] {
  const out: string[] = []
  for (const c of cables)
    for (const s of segs(c.pts))
      for (const [id, r] of cards) {
        if (id === c.source || id === c.target) continue
        if (segHitsRect(s.p, s.q, r)) out.push(`${c.edge}#${c.cable} x ${id}`)
      }
  return out
}

/** How far `p` lies from a polyline. */
function offLine(pts: readonly Pt[], p: Pt): number {
  let best = Infinity
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1], pts[i]]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const l2 = dx * dx + dy * dy
    const u = l2
      ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2))
      : 0
    best = Math.min(best, Math.hypot(p.x - a.x - u * dx, p.y - a.y - u * dy))
  }
  return best
}

/** End labels that sit off their own line, a port name past its cable's
 * first straight run, labels that overlap, or lie on another cable. */
export function labelFaults(cables: readonly Drawn[]): string[] {
  const out: string[] = []
  const all = cables.flatMap((c) => c.labels.map((l) => ({ c, l })))
  for (const { c, l } of all) {
    const pts = l.end === "a" ? c.pts : [...c.pts].reverse()
    // Curves are sampled: allow the chord's sag.
    const tol = c.line === "bendy" || c.line === "cyclical" ? 1.5 : 0.5
    if (offLine(c.pts, { x: l.box.cx, y: l.box.cy }) > tol)
      out.push(`${c.edge}#${c.cable}${l.end} ${l.text}: off its line`)
    // A nub's name keeps to its first run; a Simple line's finds its own.
    const shared = l.end === "a" ? c.sharedA : c.sharedB
    if (c.line === "elbow" && pts.length > 2 && !l.ip && !shared) {
      const run = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y)
      const w = l.box.hw * 2
      if (l.along + w / 2 > run + 0.5)
        out.push(`${c.edge}#${c.cable}${l.end} ${l.text}: past its bend`)
    }
    for (const d of cables) {
      if (d === c) continue
      for (const s of segs(d.pts))
        if (segHitsBox(s.p, s.q, l.box))
          out.push(`${l.text} on ${d.edge}#${d.cable}`)
    }
  }
  for (let i = 0; i < all.length; i++)
    for (let j = i + 1; j < all.length; j++)
      if (boxesOverlap(all[i].l.box, all[j].l.box))
        out.push(`${all[i].l.text} over ${all[j].l.text}`)
  return out
}

/** Do two segments cross (properly)? */
export function crosses(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o = (p: Pt, q: Pt, r: Pt) =>
    Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x))
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0
}

/** Crossings between two routes' first `k` runs from their `end`s. */
export function earlyCrossings(
  x: readonly Pt[],
  y: readonly Pt[],
  k = 3
): number {
  let n = 0
  const sx = segs([...x]).slice(0, k)
  const sy = segs([...y]).slice(0, k)
  for (const s of sx) for (const t of sy) if (crosses(s.p, s.q, t.p, t.q)) n++
  return n
}
