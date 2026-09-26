import { NUB } from "./card-layout"
import type {
  Anchor,
  DiagramMode,
  Dir,
  End,
  Rect,
  Side,
  SideCount,
} from "./types"

// Where each link end meets its card. Every end leaves through the side
// facing the other end. In Simple mode all of a side's lines meet at that
// side's midpoint and fan out from there; in Detailed mode each cabled
// interface gets its own nub along the side, ordered by where its far end
// is so lines leaving one side do not cross. Pure: boxes in, anchors out.

/** Outward normal of each side. */
export const SIDE_DIR: Record<Side, Dir> = {
  T: [0, -1],
  R: [1, 0],
  B: [0, 1],
  L: [-1, 0],
}

/** The direction offsets run along a side: left to right on T and B, top
 * to bottom on L and R. */
const ALONG: Record<Side, Dir> = { T: [1, 0], B: [1, 0], L: [0, 1], R: [0, 1] }

const SIDES: readonly Side[] = ["T", "R", "B", "L"]

const natural = (a: string, b: string) =>
  a.localeCompare(b, "en", { numeric: true, sensitivity: "base" })

/** How long a side of a `w` x `h` box is. */
export function sideLength(box: { w: number; h: number }, side: Side): number {
  return side === "T" || side === "B" ? box.w : box.h
}

/** Where offsets along a side start from. */
function sideStart(box: Rect, side: Side): [number, number] {
  switch (side) {
    case "T":
      return [box.x, box.y]
    case "B":
      return [box.x, box.y + box.h]
    case "L":
      return [box.x, box.y]
    case "R":
      return [box.x + box.w, box.y]
  }
}

function sideMid(box: Rect, side: Side): [number, number] {
  const [x, y] = sideStart(box, side)
  const [ax, ay] = ALONG[side]
  const half = sideLength(box, side) / 2
  return [x + ax * half, y + ay * half]
}

/**
 * The sides two boxes face each other on: the side the line between their
 * centres leaves through once both boxes' extents are counted, so the
 * answer is symmetric (A's bottom always meets B's top) and wide cards
 * connect up and down.
 */
export function chooseSides(a: Rect, b: Rect): [Side, Side] {
  const dx = b.x + b.w / 2 - (a.x + a.w / 2)
  const dy = b.y + b.h / 2 - (a.y + a.h / 2)
  const vertical = Math.abs(dy) * (a.w + b.w) >= Math.abs(dx) * (a.h + b.h)
  if (vertical) return dy >= 0 ? ["B", "T"] : ["T", "B"]
  return dx >= 0 ? ["R", "L"] : ["L", "R"]
}

/**
 * A link end in flow coordinates. `out` moves a side anchor out along the
 * side's normal - `NUB.OUT` starts the line at a Detailed nub's tip.
 */
export function anchorPoint(box: Rect, a: Anchor, out = 0): End {
  if (a.k === "point") {
    return {
      x: box.x + a.fx * box.w,
      y: box.y + a.fy * box.h,
      dir: a.exit === "T" ? SIDE_DIR.T : SIDE_DIR.B,
    }
  }
  const [sx, sy] = sideStart(box, a.side)
  const [ax, ay] = ALONG[a.side]
  const d = SIDE_DIR[a.side]
  return {
    x: sx + ax * a.off + d[0] * out,
    y: sy + ay * a.off + d[1] * out,
    dir: d,
  }
}

export interface AnchorLink {
  id: string
  source: string
  target: string
  /** One entry per cable, with the port at each end: each gets its own
   * nub in Detailed mode. Absent or empty = one unnamed end. */
  cables?: readonly { a?: string; b?: string }[]
  /** Pin an end to a side (a cyclical arc leaves on its bulge side). */
  force?: { a?: Side; b?: Side }
  /** Meet at the side midpoints even in Detailed mode - for links that
   * are not cables (LLDP neighbours, BGP sessions). */
  simple?: boolean
}

/** A Detailed-mode nub on a card. */
export interface Nub {
  link: string
  /** Index into the link's `cables`. */
  cable: number
  end: "a" | "b"
  port?: string
  side: Side
  /** Centre, px along the side from its start. */
  off: number
}

export interface Anchors {
  /** The sides each link's ends face, `[a, b]`. Pass them back in
   * (`opts.sides`) to keep them while the boxes grow to fit their nubs.
   * An end wrapped round a corner has its actual side on its anchor. */
  sides: Map<string, [Side, Side]>
  /** Per link, one anchor per cable at each end (one each in Simple). */
  links: Map<string, { a: Anchor[]; b: Anchor[] }>
  /** Detailed: each card's nubs, in order along each side. */
  nubs: Map<string, Nub[]>
  /** Detailed: nubs per side of each card, after wrapping - what
   * `cardLayout` sizes the card for. */
  demand: Map<string, SideCount>
}

export interface AnchorOptions {
  sides?: ReadonlyMap<string, readonly [Side, Side]>
}

interface EndEntry {
  link: string
  cable: number
  end: "a" | "b"
  node: string
  partner: string
  side: Side
  port?: string
  /** Sort key: where the far end is, seen from this side. */
  key: number
  /** Tie-break inside one node pair: the cable's rank in the pair (the
   * same at both ends), signed so the cables arrive in the order they left
   * and a bundle never twists. */
  sec: number
}

/** Where the adjacent side takes the ends spilled off a side's start
 * ("lo") or end ("hi"), and at which of its own ends they go. */
const SPILL: Record<
  Side,
  { lo: [Side, "lo" | "hi"]; hi: [Side, "lo" | "hi"] }
> = {
  T: { lo: ["L", "lo"], hi: ["R", "lo"] },
  B: { lo: ["L", "hi"], hi: ["R", "hi"] },
  L: { lo: ["T", "lo"], hi: ["B", "lo"] },
  R: { lo: ["T", "hi"], hi: ["B", "hi"] },
}

/**
 * Anchor every link end. Links whose nodes have no box are skipped.
 *
 * Detailed ordering along a side, so the lines leaving it do not cross:
 * by the angle to the far end's side midpoint, then - for several cables
 * to the same card - in one order for the pair, mirrored where needed so
 * the bundle arrives in the order it left. Above `NUB.MAX_PER_SIDE` ends
 * on a side, the ends at each extreme continue round the corner onto the
 * adjacent side. Nubs sit centred on their side at `NUB.PITCH`, closer
 * only when the side is too short.
 */
export function anchorLinks(
  boxes: ReadonlyMap<string, Rect>,
  links: readonly AnchorLink[],
  mode: DiagramMode,
  opts: AnchorOptions = {}
): Anchors {
  const out: Anchors = {
    sides: new Map(),
    links: new Map(),
    nubs: new Map(),
    demand: new Map(),
  }
  const live = links.filter((l) => boxes.has(l.source) && boxes.has(l.target))

  for (const l of live) {
    const pinned = opts.sides?.get(l.id)
    let sides: [Side, Side]
    if (pinned) sides = [pinned[0], pinned[1]]
    else {
      const auto: [Side, Side] =
        l.source === l.target
          ? ["R", "R"]
          : chooseSides(boxes.get(l.source)!, boxes.get(l.target)!)
      sides = [l.force?.a ?? auto[0], l.force?.b ?? auto[1]]
    }
    out.sides.set(l.id, sides)
  }

  const midAnchor = (node: string, side: Side, port?: string): Anchor => ({
    k: "side",
    side,
    off: sideLength(boxes.get(node)!, side) / 2,
    ...(port ? { port } : {}),
  })

  // Simple mode, and links that never get nubs: side midpoints.
  const detailed: AnchorLink[] = []
  for (const l of live) {
    if (mode === "detailed" && !l.simple) {
      detailed.push(l)
      continue
    }
    const [sa, sb] = out.sides.get(l.id)!
    const first = l.cables?.[0]
    out.links.set(l.id, {
      a: [midAnchor(l.source, sa, first?.a)],
      b: [midAnchor(l.target, sb, first?.b)],
    })
  }
  if (!detailed.length) return out

  // One order for all the cables between a node pair, by the port name at
  // the pair's first node - both ends rank a cable the same.
  const pairOf = (l: AnchorLink) =>
    l.source < l.target ? `${l.source}|${l.target}` : `${l.target}|${l.source}`
  const byPair = new Map<string, { l: AnchorLink; i: number; port: string }[]>()
  for (const l of detailed) {
    const cables = l.cables?.length ? l.cables : [{}]
    const firstIsSource = l.source <= l.target
    const list = byPair.get(pairOf(l)) ?? []
    cables.forEach((c, i) =>
      list.push({ l, i, port: (firstIsSource ? c.a : c.b) ?? "" })
    )
    byPair.set(pairOf(l), list)
  }
  const rank = new Map<string, number>()
  for (const list of byPair.values()) {
    list.sort(
      (x, y) =>
        natural(x.port, y.port) ||
        (x.l.id < y.l.id ? -1 : x.l.id > y.l.id ? 1 : 0) ||
        x.i - y.i
    )
    list.forEach((c, r) => rank.set(`${c.l.id}#${c.i}`, r))
  }

  // Each end, keyed for its side.
  const perSide = new Map<string, EndEntry[]>()
  for (const l of detailed) {
    const [sa, sb] = out.sides.get(l.id)!
    const cables = l.cables?.length ? l.cables : [{}]
    cables.forEach((c, i) => {
      const r = rank.get(`${l.id}#${i}`) ?? i
      for (const end of ["a", "b"] as const) {
        const node = end === "a" ? l.source : l.target
        const partner = end === "a" ? l.target : l.source
        const side = end === "a" ? sa : sb
        const pSide = end === "a" ? sb : sa
        const e: EndEntry = {
          link: l.id,
          cable: i,
          end,
          node,
          partner,
          side,
          ...(c[end] ? { port: c[end] } : {}),
          key: 0,
          sec: 0,
        }
        if (node === partner) {
          e.sec = 2 * r + (end === "b" ? 1 : 0)
        } else {
          const [mx, my] = sideMid(boxes.get(node)!, side)
          const [px, py] = sideMid(boxes.get(partner)!, pSide)
          const n = SIDE_DIR[side]
          const t = ALONG[side]
          const vx = px - mx
          const vy = py - my
          e.key = Math.atan2(vx * t[0] + vy * t[1], vx * n[0] + vy * n[1])
          // The traveller's left hand, walking from the pair's first node
          // to its second: out of this side, or into it.
          const left: Dir = node < partner ? [n[1], -n[0]] : [-n[1], n[0]]
          const s = left[0] * t[0] + left[1] * t[1] < 0 ? -1 : 1
          e.sec = s * r
        }
        const k = `${node}\u0000${side}`
        const list = perSide.get(k) ?? []
        list.push(e)
        perSide.set(k, list)
      }
    })
  }

  for (const list of perSide.values())
    list.sort(
      (x, y) =>
        x.key - y.key ||
        (x.partner < y.partner ? -1 : x.partner > y.partner ? 1 : 0) ||
        x.sec - y.sec ||
        (x.link < y.link ? -1 : x.link > y.link ? 1 : 0) ||
        x.cable - y.cable ||
        (x.end < y.end ? -1 : x.end > y.end ? 1 : 0)
    )

  // Wrap: a side holding more than the cap spills its extremes round the
  // corners. The ends nearest the corner stay nearest it.
  const nodes = new Set(detailed.flatMap((l) => [l.source, l.target]))
  const anchorsOf = new Map<string, { a: Anchor[]; b: Anchor[] }>()
  for (const l of detailed) {
    const n = l.cables?.length || 1
    anchorsOf.set(l.id, { a: new Array(n), b: new Array(n) })
  }
  for (const node of nodes) {
    const sides = new Map<Side, EndEntry[]>(
      SIDES.map((s) => [s, [...(perSide.get(`${node}\u0000${s}`) ?? [])]])
    )
    // Ends arriving round the corner at a side's start, and at its end.
    // Each corner is shared with one side only, so one group at most each.
    const lead = new Map<Side, EndEntry[]>(SIDES.map((s) => [s, []]))
    const tail = new Map<Side, EndEntry[]>(SIDES.map((s) => [s, []]))
    for (const s of SIDES) {
      const list = sides.get(s)!
      const excess = list.length - NUB.MAX_PER_SIDE
      if (excess <= 0) continue
      const lo = list.splice(0, Math.floor(excess / 2))
      const hi = list.splice(list.length - (excess - lo.length))
      // `moved` runs from the corner outward: the spill off the side's end
      // continues in order, the spill off its start runs backwards.
      const spill = (moved: EndEntry[], [to, at]: [Side, "lo" | "hi"]) => {
        if (at === "lo") lead.get(to)!.push(...moved)
        else tail.get(to)!.push(...moved.slice().reverse())
      }
      spill(lo.slice().reverse(), SPILL[s].lo)
      spill(hi, SPILL[s].hi)
    }
    const box = boxes.get(node)!
    const demand: SideCount = { T: 0, R: 0, B: 0, L: 0 }
    const nubs: Nub[] = []
    for (const s of SIDES) {
      const ordered = [...lead.get(s)!, ...sides.get(s)!, ...tail.get(s)!]
      demand[s] = ordered.length
      const len = sideLength(box, s)
      const n = ordered.length
      const pitch =
        n > 1
          ? Math.max(
              0,
              Math.min(NUB.PITCH, (len - 2 * NUB.INSET - NUB.ALONG) / (n - 1))
            )
          : 0
      ordered.forEach((e, i) => {
        const off = len / 2 + (i - (n - 1) / 2) * pitch
        const anchor: Anchor = {
          k: "side",
          side: s,
          off,
          ...(e.port ? { port: e.port } : {}),
        }
        anchorsOf.get(e.link)![e.end][e.cable] = anchor
        nubs.push({
          link: e.link,
          cable: e.cable,
          end: e.end,
          ...(e.port ? { port: e.port } : {}),
          side: s,
          off,
        })
      })
    }
    out.demand.set(node, demand)
    out.nubs.set(node, nubs)
  }
  for (const [id, a] of anchorsOf) out.links.set(id, a)
  return out
}

/**
 * A link's ends per cable, as drawn: side midpoints re-chosen from the two
 * boxes for a `simple` link (or one with no anchors yet), else each
 * cable's anchors, starting at the Detailed nub's tip.
 */
export function linkEnds(
  link: { a: readonly Anchor[]; b: readonly Anchor[]; simple?: boolean },
  s: Rect,
  t: Rect
): [End, End][] {
  if (link.simple || !link.a.length || !link.b.length) {
    const [ss, ts] = chooseSides(s, t)
    return [
      [
        anchorPoint(s, { k: "side", side: ss, off: sideLength(s, ss) / 2 }),
        anchorPoint(t, { k: "side", side: ts, off: sideLength(t, ts) / 2 }),
      ],
    ]
  }
  const out: [End, End][] = []
  const n = Math.min(link.a.length, link.b.length)
  for (let i = 0; i < n; i++) {
    const a = link.a[i] as Anchor | undefined
    const b = link.b[i] as Anchor | undefined
    if (a && b)
      out.push([anchorPoint(s, a, NUB.OUT), anchorPoint(t, b, NUB.OUT)])
  }
  return out
}
