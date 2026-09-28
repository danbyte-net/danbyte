import { NUB } from "./card-layout"
import { LANE } from "./lanes"
import type { Obstacles } from "./lanes"
import { photoAnchors } from "./photo-anchors"
import type { PhotoFace, PointAnchor } from "./photo-anchors"
import type {
  Anchor,
  DiagramMode,
  Dir,
  End,
  PortRef,
  Pt,
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

/** The part of a node's box its sides are on: all of it, or - a photo
 * taking its cables at its edge - the image above its `cap` px of
 * caption. */
export function imageBox(box: Rect, cap?: number): Rect {
  return cap ? { ...box, h: Math.max(0, box.h - cap) } : box
}

/**
 * A link end in flow coordinates. `out` moves a side anchor out along the
 * side's normal - `NUB.OUT` starts the line at a Detailed nub's tip. A
 * photo port's line starts where its lead leaves the node's box, straight
 * above or below the port (`leadStart` is the port itself); so does a
 * line off the bottom of a photo taking its cables at its edge, under the
 * caption.
 */
export function anchorPoint(box: Rect, a: Anchor, out = 0): End {
  if (a.k === "junction")
    return { x: box.x + box.w / 2, y: box.y + box.h / 2, dir: a.dir }
  if (a.k === "point") {
    return {
      x: box.x + a.fx * box.w,
      y: a.exit === "T" ? box.y : box.y + box.h,
      dir: a.exit === "T" ? SIDE_DIR.T : SIDE_DIR.B,
    }
  }
  const [sx, sy] = sideStart(imageBox(box, a.cap), a.side)
  const [ax, ay] = ALONG[a.side]
  const d = SIDE_DIR[a.side]
  const y = sy + ay * a.off + d[1] * out
  return {
    x: sx + ax * a.off + d[0] * out,
    y: a.cap && a.side === "B" ? Math.max(y, box.y + box.h) : y,
    dir: d,
  }
}

/** Where a photo port's lead starts: its marker's centre (or its stub's
 * place on the image edge); for a photo taking its cables at its edge,
 * the image's bottom edge above a line leaving under the caption. Null
 * for any other anchor. */
export function leadStart(box: Rect, a: Anchor | undefined): Pt | null {
  if (a?.k === "side")
    return a.cap && a.side === "B"
      ? { x: box.x + a.off, y: box.y + box.h - a.cap }
      : null
  if (a?.k !== "point") return null
  return { x: box.x + a.fx * box.w, y: box.y + a.fy * box.h }
}

export interface AnchorLink {
  id: string
  source: string
  target: string
  /** One entry per cable, with the port at each end (and its component,
   * for photo markers): each gets its own nub in Detailed mode. Absent or
   * empty = one unnamed end. */
  cables?: readonly {
    a?: string
    b?: string
    aRef?: PortRef
    bRef?: PortRef
  }[]
  /** Pin an end to a side (a cyclical arc leaves on its bulge side). */
  force?: { a?: Side; b?: Side }
  /** Meet at the side midpoints even in Detailed mode - for links that
   * are not cables (LLDP neighbours, BGP sessions). */
  simple?: boolean
  /** An end on a breakout's junction: no nub, it leaves the junction's
   * centre along this direction. */
  junction?: { a?: Dir; b?: Dir }
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
  /** The cards a line should not have to leave straight into: a side
   * with a third card right outside it gives way to the next best. */
  blockers?: Obstacles
  /** The gap two facing sides should leave between them (Detailed: a port
   * name at each end). A pair of sides closer than this gives way to the
   * other axis's pair when that one has the room. */
  roomy?: number
  /** Nodes drawn as photos: their cable ends land on their ports, in
   * either mode (photo-anchors.ts). */
  photos?: ReadonlyMap<string, PhotoFace>
  /** Photos taking their cables at their edge: anchored like cards on
   * their image, with this many px of caption under it (`Anchor.cap`). */
  caps?: ReadonlyMap<string, number>
  /** Photo ports leave by their nearer image edge, never towards their
   * far end (`photoAnchors`). */
  nearExits?: boolean
}

/** How far out from a side a third card makes it a poor exit: a stub and
 * a port name's worth. */
const EXIT_ZONE = 40

/** Is a third card right outside `side` of `box`? */
function exitBlocked(
  box: Rect,
  side: Side,
  own: readonly string[],
  blockers: Obstacles
): boolean {
  const zone: Rect =
    side === "T"
      ? { x: box.x, y: box.y - EXIT_ZONE, w: box.w, h: EXIT_ZONE }
      : side === "B"
        ? { x: box.x, y: box.y + box.h, w: box.w, h: EXIT_ZONE }
        : side === "L"
          ? { x: box.x - EXIT_ZONE, y: box.y, w: EXIT_ZONE, h: box.h }
          : { x: box.x + box.w, y: box.y, w: EXIT_ZONE, h: box.h }
  for (const { id, r } of blockers.near(zone)) {
    if (own.includes(id)) continue
    if (
      r.x < zone.x + zone.w &&
      zone.x < r.x + r.w &&
      r.y < zone.y + zone.h &&
      zone.y < r.y + r.h
    )
      return true
  }
  return false
}

/**
 * `chooseSides`, steered off a side that runs straight into a third card:
 * when either preferred side is blocked and the other axis's pair is not,
 * that pair is taken instead.
 */
export function chooseClearSides(
  a: Rect,
  b: Rect,
  own: readonly string[],
  blockers?: Obstacles,
  roomy = 0
): [Side, Side] {
  const best = chooseSides(a, b)
  if (!blockers && !roomy) return best
  const blocked = ([sa, sb]: [Side, Side]) =>
    !!blockers &&
    (exitBlocked(a, sa, own, blockers) || exitBlocked(b, sb, own, blockers))
  /** The open gap between two facing sides. */
  const gap = ([sa]: [Side, Side]) =>
    sa === "R"
      ? b.x - (a.x + a.w)
      : sa === "L"
        ? a.x - (b.x + b.w)
        : sa === "B"
          ? b.y - (a.y + a.h)
          : a.y - (b.y + b.h)
  const cramped = (s: [Side, Side]) => roomy > 0 && gap(s) < roomy
  if (!blocked(best) && !cramped(best)) return best
  const dx = b.x + b.w / 2 - (a.x + a.w / 2)
  const dy = b.y + b.h / 2 - (a.y + a.h / 2)
  const alt: [Side, Side] =
    best[0] === "T" || best[0] === "B"
      ? dx >= 0
        ? ["R", "L"]
        : ["L", "R"]
      : dy >= 0
        ? ["B", "T"]
        : ["T", "B"]
  if (blocked(alt)) return best
  if (blocked(best)) return alt
  // Only cramped: the other pair must have the room, and face the right
  // way (a positive gap).
  return !cramped(alt) ? alt : best
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
  /** An arc's end: arcs to farther cards sit further out along the side,
   * so the arcs leaving one side nest. */
  far?: number
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
  nodeBoxes: ReadonlyMap<string, Rect>,
  links: readonly AnchorLink[],
  mode: DiagramMode,
  opts: AnchorOptions = {}
): Anchors {
  // A photo taking its cables at its edge is anchored on its image.
  const caps = opts.caps?.size ? opts.caps : null
  let boxes = nodeBoxes
  if (caps) {
    const shrunk = new Map(nodeBoxes)
    for (const [id, cap] of caps) {
      const r = nodeBoxes.get(id)
      if (r) shrunk.set(id, imageBox(r, cap))
    }
    boxes = shrunk
  }
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
          : chooseClearSides(
              boxes.get(l.source)!,
              boxes.get(l.target)!,
              [l.source, l.target],
              opts.blockers,
              l.simple ? 0 : opts.roomy
            )
      sides = [l.force?.a ?? auto[0], l.force?.b ?? auto[1]]
    }
    out.sides.set(l.id, sides)
  }

  const capOf = (node: string) => {
    const cap = caps?.get(node)
    return cap ? { cap } : {}
  }
  const midAnchor = (node: string, side: Side, port?: string): Anchor => ({
    k: "side",
    side,
    off: sideLength(boxes.get(node)!, side) / 2,
    ...(port ? { port } : {}),
    ...capOf(node),
  })

  // Cable ends on photo nodes land on their ports whatever the mode.
  const photo: ReadonlyMap<string, PointAnchor> = opts.photos?.size
    ? photoAnchors(opts.photos, boxes, live, !opts.nearExits)
    : new Map()
  const photoEnd = (l: AnchorLink, i: number, end: "a" | "b") =>
    photo.size ? photo.get(`${l.id}#${i}${end}`) : undefined

  // Simple mode, and links that never get nubs: side midpoints - one line
  // per cable where a photo end lands each on its own port.
  const detailed: AnchorLink[] = []
  for (const l of live) {
    if (mode === "detailed" && !l.simple) {
      detailed.push(l)
      continue
    }
    const [sa, sb] = out.sides.get(l.id)!
    const cables = l.cables ?? []
    if (cables.some((_, i) => photoEnd(l, i, "a") || photoEnd(l, i, "b"))) {
      out.links.set(l.id, {
        a: cables.map(
          (c, i): Anchor =>
            l.junction?.a
              ? { k: "junction", dir: l.junction.a }
              : (photoEnd(l, i, "a") ?? midAnchor(l.source, sa, c.a))
        ),
        b: cables.map(
          (c, i): Anchor =>
            l.junction?.b
              ? { k: "junction", dir: l.junction.b }
              : (photoEnd(l, i, "b") ?? midAnchor(l.target, sb, c.b))
        ),
      })
      continue
    }
    const first = l.cables?.[0]
    out.links.set(l.id, {
      a: [
        l.junction?.a
          ? { k: "junction", dir: l.junction.a }
          : midAnchor(l.source, sa, first?.a),
      ],
      b: [
        l.junction?.b
          ? { k: "junction", dir: l.junction.b }
          : midAnchor(l.target, sb, first?.b),
      ],
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

  // Each end, keyed for its side. Junction ends get no nub, and photo
  // ends keep their ports.
  const perSide = new Map<string, EndEntry[]>()
  const junctionEnds: {
    link: string
    cable: number
    end: "a" | "b"
    dir: Dir
  }[] = []
  const photoEnds: {
    link: string
    cable: number
    end: "a" | "b"
    anchor: Anchor
  }[] = []
  for (const l of detailed) {
    const [sa, sb] = out.sides.get(l.id)!
    const cables = l.cables?.length ? l.cables : [{}]
    cables.forEach((c, i) => {
      const r = rank.get(`${l.id}#${i}`) ?? i
      for (const end of ["a", "b"] as const) {
        const jdir = l.junction?.[end]
        if (jdir) {
          junctionEnds.push({ link: l.id, cable: i, end, dir: jdir })
          continue
        }
        const own = photoEnd(l, i, end)
        if (own) {
          photoEnds.push({ link: l.id, cable: i, end, anchor: own })
          continue
        }
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
          // A far end on a photo is where its lead leaves the photo.
          const far = photoEnd(l, i, end === "a" ? "b" : "a")
          const fp = far && anchorPoint(boxes.get(partner)!, far)
          const [px, py] = fp
            ? [fp.x, fp.y]
            : sideMid(boxes.get(partner)!, pSide)
          const n = SIDE_DIR[side]
          const t = ALONG[side]
          const vx = px - mx
          const vy = py - my
          const along = vx * t[0] + vy * t[1]
          e.key = Math.atan2(along, vx * n[0] + vy * n[1])
          if (l.force && l.force.a === l.force.b) {
            // An arc (both ends on its bulge side): those running one way
            // leave from that end of the side, the longest outermost.
            e.key = along >= 0 ? Math.PI / 2 : -Math.PI / 2
            e.far = along >= 0 ? -Math.abs(along) : Math.abs(along)
          }
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
        (x.far ?? 0) - (y.far ?? 0) ||
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
      // A photo cannot grow for its nubs: on a short side they keep a
      // lane apart, closer to its corners, before they close up.
      const inset = caps?.has(node)
        ? Math.min(
            NUB.INSET,
            Math.max(0, (len - NUB.ALONG - LANE * (n - 1)) / 2)
          )
        : NUB.INSET
      const pitch =
        n > 1
          ? Math.max(
              0,
              Math.min(NUB.PITCH, (len - 2 * inset - NUB.ALONG) / (n - 1))
            )
          : 0
      ordered.forEach((e, i) => {
        const off = len / 2 + (i - (n - 1) / 2) * pitch
        const anchor: Anchor = {
          k: "side",
          side: s,
          off,
          ...(e.port ? { port: e.port } : {}),
          ...capOf(node),
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
  for (const j of junctionEnds)
    anchorsOf.get(j.link)![j.end][j.cable] = { k: "junction", dir: j.dir }
  for (const p of photoEnds) anchorsOf.get(p.link)![p.end][p.cable] = p.anchor
  for (const [id, a] of anchorsOf) out.links.set(id, a)
  return out
}

/**
 * A link's ends per cable, as drawn: side midpoints re-chosen from the two
 * boxes for a `simple` link while it follows a drag (`live`), or one with
 * no anchors yet; else each cable's anchors - a Simple link's side
 * midpoints, a Detailed cable's nub tip. A junction end leaves its
 * junction's centre either way.
 */
export function linkEnds(
  link: { a: readonly Anchor[]; b: readonly Anchor[]; simple?: boolean },
  s: Rect,
  t: Rect,
  live = true
): [End, End][] {
  const onPhoto =
    link.a.some((a) => a.k === "point") || link.b.some((b) => b.k === "point")
  // A photo taking its cables at its edge keeps to its image.
  const capOf = (list: readonly Anchor[]) => {
    const a = list.find((x) => x.k === "side")
    return a?.k === "side" ? a.cap : undefined
  }
  const [ca, cb] = [capOf(link.a), capOf(link.b)]
  const mid = (box: Rect, side: Side, cap?: number) =>
    anchorPoint(box, {
      k: "side",
      side,
      off: sideLength(imageBox(box, cap), side) / 2,
      ...(cap ? { cap } : {}),
    })
  if (link.simple && live && onPhoto) {
    // Photo ports stay where they are; a card end meets its side midpoint.
    const [ss, ts] = chooseSides(imageBox(s, ca), imageBox(t, cb))
    const end = (box: Rect, a: Anchor, side: Side, cap?: number) =>
      a.k === "side" ? mid(box, side, cap) : anchorPoint(box, a)
    const out: [End, End][] = []
    const n = Math.min(link.a.length, link.b.length)
    for (let i = 0; i < n; i++)
      out.push([end(s, link.a[i], ss, ca), end(t, link.b[i], ts, cb)])
    return out
  }
  if ((link.simple && live) || !link.a.length || !link.b.length) {
    const [ss, ts] = chooseSides(imageBox(s, ca), imageBox(t, cb))
    const ja = link.a[0]?.k === "junction" ? link.a[0] : null
    const jb = link.b[0]?.k === "junction" ? link.b[0] : null
    return [
      [
        ja ? anchorPoint(s, ja) : mid(s, ss, ca),
        jb ? anchorPoint(t, jb) : mid(t, ts, cb),
      ],
    ]
  }
  const out: [End, End][] = []
  const n = Math.min(link.a.length, link.b.length)
  const tip = link.simple ? 0 : NUB.OUT
  for (let i = 0; i < n; i++) {
    const a = link.a[i] as Anchor | undefined
    const b = link.b[i] as Anchor | undefined
    if (a && b) out.push([anchorPoint(s, a, tip), anchorPoint(t, b, tip)])
  }
  return out
}

/** How an elbow end leaves its side (`lanes.ts` endTurn), keyed like a
 * nub: `${link}#${cable}${end}`. */
export type EndTurns = ReadonlyMap<
  string,
  { turn: -1 | 0 | 1; depth: number; extent: number }
>

export const nubKey = (n: Pick<Nub, "link" | "cable" | "end">) =>
  `${n.link}#${n.cable}${n.end}`

/** Depths closer than this count as one corridor. */
const SAME_DEPTH = 6

/**
 * Re-order the elbow nubs on each side by how their routes turn, so the
 * routes nest instead of crossing right outside the card: those turning
 * towards the side's start first (shallowest nearest that corner), then
 * those running straight out, then those turning towards its end
 * (shallowest nearest that corner). In one corridor, the route that runs
 * further round goes outside. Only the elbow nubs move, among the places
 * they held. In place; true when anything moved.
 */
export function reorderNubs(anchors: Anchors, turns: EndTurns): boolean {
  let changed = false
  const cmp = (x: Nub, y: Nub) => {
    const tx = turns.get(nubKey(x))!
    const ty = turns.get(nubKey(y))!
    if (tx.turn !== ty.turn) return tx.turn - ty.turn
    const dd =
      Math.abs(tx.depth - ty.depth) < SAME_DEPTH ? 0 : tx.depth - ty.depth
    if (tx.turn < 0) return dd || tx.extent - ty.extent
    if (tx.turn > 0) return -dd || tx.extent - ty.extent
    return tx.extent - ty.extent
  }
  for (const [node, nubs] of anchors.nubs) {
    let moved = false
    for (const side of SIDES) {
      const mine = nubs.filter((n) => n.side === side && turns.has(nubKey(n)))
      if (mine.length < 2) continue
      const slots = mine.map((n) => n.off).sort((a, b) => a - b)
      const sorted = [...mine].sort((x, y) => x.off - y.off).sort(cmp)
      for (const [i, n] of sorted.entries()) {
        if (n.off === slots[i]) continue
        n.off = slots[i]
        const ends = anchors.links.get(n.link)
        const a = ends
          ? (ends[n.end][n.cable] as Anchor | undefined)
          : undefined
        if (a && a.k === "side") a.off = slots[i]
        moved = true
      }
    }
    if (!moved) continue
    changed = true
    anchors.nubs.set(
      node,
      [...nubs].sort(
        (x, y) => SIDES.indexOf(x.side) - SIDES.indexOf(y.side) || x.off - y.off
      )
    )
  }
  return changed
}
