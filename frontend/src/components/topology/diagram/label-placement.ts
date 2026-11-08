import { PORT_H, inlineSpan, uprightAngle } from "@/lib/diagram/geometry"
import type { PortPlace } from "@/lib/diagram/geometry"
import { LABEL } from "@/lib/diagram/theme"
import {
  Grid,
  boxesOverlap,
  inflate,
  segHitsBox,
  turnedBox,
  turnedBounds,
} from "./spatial"
import type { TurnedBox } from "./spatial"
import type { Pt, Rect } from "./types"

// Where a Diagram's labels go once every cable is routed. Best effort, in
// a fixed order so the result is deterministic:
//
// - End labels sit ON their own cable, which breaks for them: a port name
//   right after its nub (the line runs `LABEL.LEAD` px, then the text with
//   a gap of page on either side, then the line runs on), and the end's
//   addresses one after another further along. Side by side, each name is
//   on its own line, so it cannot read as its neighbour's. A run of labels
//   needs a straight stretch of its route clear of every card, label and
//   other cable; it slides out along the route until one is free, and is
//   left off when none is (the nub's tooltip and the link's panel still
//   name the port). An end's addresses may be cut short instead: the
//   last ones (IPv6) go before the first (`least`). A Detailed port name
//   keeps to the straight run out of its nub, which the planner lengthens for it (`portStub`). In Simple the
//   side's lines share the point they leave from, so their labels settle
//   where each cable runs on its own.
// - A middle chip, placed after every end label, sits at the middle of
//   its route, or the nearest spot along it clear of cards and other
//   labels; with none free it is
//   `crowded` and shows on hover only.

/** A run of end labels to place along one end of a cable: its port name
 * and addresses, or either, nearest the end first. All or none, unless
 * it says how far it may be cut (`least`). */
export interface InlineAsk {
  /** Unique per ask. */
  key: string
  /** The route they sit on: it never blocks them. */
  cable: string
  /** The texts' widths, measured, nearest the end first. */
  ws: number[]
  /** With no room for them all: the fewest that may show, the run cut
   * from its far end (an end's addresses, IPv6 after IPv4, drop IPv6
   * first). All or none when absent. */
  least?: number
  /** The drawn route walked from this end: the point `d` px along it and
   * the direction of travel there, degrees. */
  walk: (d: number) => Pt & { angle: number }
  /** The stretch of route they may take, px from the end. */
  from: number
  until: number
  /** Keep to the straight run out of the end (a port name at its nub). */
  first?: boolean
  /** Where that run starts, px from the end: past a photo port's lead,
   * which turns where it leaves the photo. */
  run?: number
  /** The route is a curve (a bendy line): each label follows it, bent
   * as the line bends under it (`PortPlace.path`), rather than waiting
   * for a straight stretch. */
  curved?: boolean
  /** The route is one straight line - past `run` - where `walk(d)` is
   * `at` plus `d` times the unit vector `u`. Lets a label skip the
   * stretch something is sure to block. */
  line?: { at: Pt; u: Pt }
}

/** A middle chip to place. */
export interface ChipAsk {
  key: string
  w: number
  h: number
  /** A point `t` (0..1) of the way along the route, with the direction of
   * travel there in degrees. */
  at: (t: number) => Pt & { angle?: number }
  /** The routes the chip's own edge draws: it may sit on them. */
  own: ReadonlySet<string>
}

/** Where a middle chip may sit: on its line, or beside it. */
export interface ChipPlace {
  t: number
  /** Moved off the line, perpendicular, px (0 = on it). */
  off: number
  crowded: boolean
}

type Label = { k: "label"; box: TurnedBox; dead?: boolean }

type Item =
  | { k: "seg"; cable: string; p: Pt; q: Pt }
  | { k: "card"; box: TurnedBox }
  | Label

/** A label taken into a scene; `drop` it to free its room again. */
export type Taken = Label

/** Something in a scene a box ran into. */
export type Blocker = Item

/** Does `it` stand in `box`'s way? A cable never blocks its own labels,
 * nor a dropped label anything. */
export function blocks(
  it: Blocker,
  box: TurnedBox,
  mine: (cable: string) => boolean,
  crossing = false
): boolean {
  if (it.k === "seg")
    return (
      !mine(it.cable) &&
      !(crossing && crossesSteeply(it.p, it.q, box)) &&
      segHitsBox(it.p, it.q, box)
    )
  if (it.k === "label" && it.dead) return false
  return boxesOverlap(box, it.box)
}

/** The least angle, degrees, another cable may cross a label on a curve
 * at: its gap breaks that cable there and the text reads over it. One
 * running along it more nearly than this would vanish under it. */
const CROSS = 30

/** Does the run `p`-`q` cross `box` steeply enough to pass under it? */
export function crossesSteeply(p: Pt, q: Pt, box: TurnedBox): boolean {
  const a = (Math.atan2(q.y - p.y, q.x - p.x) * 180) / Math.PI
  const d = Math.abs((((a - box.angle) % 180) + 180) % 180)
  return Math.min(d, 180 - d) >= CROSS
}

/** Everything labels keep clear of: the routes, the cards, and the labels
 * placed so far. */
export class LabelScene {
  private grid = new Grid<Item>(64)

  constructor(
    routes: Iterable<[string, readonly Pt[]]>,
    cards: Iterable<Rect>
  ) {
    for (const [cable, pts] of routes)
      for (let i = 1; i < pts.length; i++) {
        const p = pts[i - 1]
        const q = pts[i]
        this.grid.addSegment(p, q, 1, { k: "seg", cable, p, q })
      }
    for (const r of cards) this.grid.add(r, { k: "card", box: turnedBox(r) })
  }

  /** Is `box` clear of every card, label and cable but its own
   * (`mine`)? */
  free(box: TurnedBox, mine: (cable: string) => boolean): boolean {
    return !this.blocker(box, mine)
  }

  /** What `box` runs into first, if anything (`free` is its absence).
   * With `crossing`, a cable crossing it steeply does not count. */
  blocker(
    box: TurnedBox,
    mine: (cable: string) => boolean,
    crossing = false
  ): Blocker | null {
    for (const it of this.grid.near(turnedBounds(box)))
      if (blocks(it, box, mine, crossing)) return it
    return null
  }

  take(box: TurnedBox): Taken {
    const it: Label = { k: "label", box }
    this.grid.add(turnedBounds(box), it)
    return it
  }

  drop(it: Taken): void {
    it.dead = true
  }

  /**
   * What crosses `r` from side to side, as x spans (sorted, merged, `pad`
   * wider each side): the cables through it, and the cards and labels in
   * it. Where a band's title chip may not go.
   */
  occupied(r: Rect, pad = 4): [number, number][] {
    const spans: [number, number][] = []
    const y0 = r.y
    const y1 = r.y + r.h
    for (const it of this.grid.near(r)) {
      if (it.k === "seg") {
        const { p, q } = it
        if (Math.max(p.y, q.y) < y0 || Math.min(p.y, q.y) > y1) continue
        let a = p.x
        let b = q.x
        if (Math.abs(q.y - p.y) > 1e-6) {
          // The part of the run within the strip's height.
          const at = (y: number) =>
            p.x + ((q.x - p.x) * (y - p.y)) / (q.y - p.y)
          const lo = Math.max(y0, Math.min(p.y, q.y))
          const hi = Math.min(y1, Math.max(p.y, q.y))
          a = at(lo)
          b = at(hi)
        }
        spans.push([Math.min(a, b), Math.max(a, b)])
        continue
      }
      if (it.k === "label" && it.dead) continue
      const b = turnedBounds(it.box)
      if (b.y > y1 || b.y + b.h < y0) continue
      spans.push([b.x, b.x + b.w])
    }
    const out: [number, number][] = []
    for (const [a, b] of spans
      .map(([lo, hi]): [number, number] => [lo - pad, hi + pad])
      .filter(([lo, hi]) => hi > r.x && lo < r.x + r.w)
      .sort((x, y) => x[0] - y[0] || x[1] - y[1])) {
      const last = out.at(-1)
      if (last && a <= last[1]) last[1] = Math.max(last[1], b)
      else out.push([a, b])
    }
    return out.map(([a, b]) => [Math.floor(a), Math.ceil(b)])
  }
}

/** How sure a skip is: what it leaves out is blocked by at least this
 * much, far beyond rounding. */
const SURE = 1e-3

/**
 * The stretch of a straight line where a box centred on it (`hw` along,
 * `hh` across) surely runs into `it`: [from, to] in px along the line from
 * `line.at`, or null. What the box meets there lies at least `SURE` inside
 * it, so the exact test would find it too.
 */
function sureBlock(
  it: Blocker,
  line: { at: Pt; u: Pt },
  hw: number,
  hh: number
): [number, number][] {
  const { at, u } = line
  const along = (p: Pt) => (p.x - at.x) * u.x + (p.y - at.y) * u.y
  const across = (p: Pt) => (p.y - at.y) * u.x - (p.x - at.x) * u.y
  const w = hw - 2 * SURE
  const h = hh - SURE
  if (w <= 0 || h <= 0) return []
  const edges: [Pt, Pt][] = []
  if (it.k === "seg") edges.push([it.p, it.q])
  else {
    const { cx, cy, hw: bw, hh: bh, angle } = it.box
    const r = (angle * Math.PI) / 180
    const [c, s] = [Math.cos(r), Math.sin(r)]
    const corner = (i: number, j: number): Pt => ({
      x: cx + i * bw * c - j * bh * s,
      y: cy + i * bw * s + j * bh * c,
    })
    const k = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)]
    for (let i = 0; i < 4; i++) edges.push([k[i], k[(i + 1) % 4]])
  }
  const out: [number, number][] = []
  for (const [p, q] of edges) {
    // Long enough that a point of it well inside the box is a real hit.
    if (Math.hypot(q.x - p.x, q.y - p.y) < 1) continue
    const [ap, aq] = [across(p), across(q)]
    let t0 = 0
    let t1 = 1
    if (ap === aq) {
      if (Math.abs(ap) > h) continue
    } else {
      const ta = (-h - ap) / (aq - ap)
      const tb = (h - ap) / (aq - ap)
      t0 = Math.max(0, Math.min(ta, tb))
      t1 = Math.min(1, Math.max(ta, tb))
      if (t0 > t1) continue
    }
    const [lp, lq] = [along(p), along(q)]
    const x0 = lp + (lq - lp) * t0
    const x1 = lp + (lq - lp) * t1
    out.push([Math.min(x0, x1) - w, Math.max(x0, x1) + w])
  }
  return out
}

/** How much further along its straight line a box centred `centre` px
 * along it stays surely blocked by `it` (0 when it is not sure to be). */
function sureRun(
  it: Blocker,
  line: { at: Pt; u: Pt },
  box: TurnedBox,
  centre: number
): number {
  const spans = sureBlock(it, line, box.hw, box.hh).sort((x, y) => x[0] - y[0])
  let lo = Infinity
  let hi = -Infinity
  for (const [a, b] of spans) {
    if (a > hi) {
      if (lo <= centre && centre <= hi) break
      ;[lo, hi] = [a, b]
    } else hi = Math.max(hi, b)
  }
  return lo <= centre && centre <= hi ? hi - centre : 0
}

/** An end label's box at its place: the text and its gaps along the
 * line, `pad` more at each end and `across` more each side. */
export function inlineBox(
  place: PortPlace,
  w: number,
  pad = 0,
  across = 0
): TurnedBox {
  return {
    cx: place.x,
    cy: place.y,
    hw: inlineSpan(w) / 2 + pad,
    hh: PORT_H / 2 + across,
    angle: place.rotate,
  }
}

/** How far a label on a curve may bend away from its chord, degrees:
 * gentle enough to read, and - its chord turned upright - never upside
 * down. */
const BEND = 20
/** Spacing of a curved label's points, px. */
const CURVE_STEP = 3
/** The longest piece of a curved label one box stands for, px. */
const CURVE_PIECE = 8

/**
 * A label `span` px long laid on a curve from `a` px along it: its place
 * (centre, chord turned upright, and the stretch it reads along) and the
 * boxes it takes, piece by piece along the curve. Null where the curve
 * bends more than `BEND` under it.
 */
function onCurve(
  walk: (d: number) => Pt & { angle: number },
  a: number,
  span: number,
  pad: number
): { place: PortPlace; boxes: TurnedBox[]; taken: TurnedBox[] } | null {
  const n = Math.max(2, Math.ceil(span / CURVE_STEP))
  const pts: (Pt & { angle: number })[] = []
  for (let k = 0; k <= n; k++) pts.push(walk(a + (span * k) / n))
  const [p, q] = [pts[0], pts[n]]
  if (Math.hypot(q.x - p.x, q.y - p.y) < span * 0.8) return null
  const chord = (Math.atan2(q.y - p.y, q.x - p.x) * 180) / Math.PI
  let most = 0
  for (const t of pts) most = Math.max(most, turnOf(t.angle, chord))
  if (most > BEND) return null
  const c = walk(a + span / 2)
  const rotate = uprightAngle(chord)
  const line = pts.map((t) => ({ x: t.x, y: t.y }))
  const place: PortPlace = { x: c.x, y: c.y, rotate }
  // A curve this gentle is a straight label. Turned upright, the text
  // reads the curve the other way.
  if (most > 1)
    place.path = turnOf(rotate, chord) > 90 ? [...line].reverse() : line
  return {
    place,
    boxes: curveBoxes(line, pad),
    taken: curveBoxes(line),
  }
}

/**
 * The boxes a label laid along a curve takes (`PortPlace.path`, read in
 * either direction): one for each piece of it up to `CURVE_PIECE` px
 * long, as tall as the label, `pad` more at both ends and half that each
 * side.
 */
export function curveBoxes(path: readonly Pt[], pad = 0): TurnedBox[] {
  const out: TurnedBox[] = []
  const n = path.length - 1
  let i = 0
  while (i < n) {
    let j = i + 1
    let len = Math.hypot(path[j].x - path[i].x, path[j].y - path[i].y)
    while (j < n) {
      const next = Math.hypot(
        path[j + 1].x - path[i].x,
        path[j + 1].y - path[i].y
      )
      if (next > CURVE_PIECE) break
      j++
      len = next
    }
    const [u, v] = [path[i], path[j]]
    out.push({
      cx: (u.x + v.x) / 2,
      cy: (u.y + v.y) / 2,
      hw: len / 2 + (i === 0 || j === n ? pad : 0),
      hh: PORT_H / 2 + pad / 2,
      angle: (Math.atan2(v.y - u.y, v.x - u.x) * 180) / Math.PI,
    })
    i = j
  }
  return out
}

/** Steps along a route a run of labels tries, px. */
const STEP = 2
/** Steps a stretch's straightness is checked at, px. */
const PROBE = 4
/** The most a stretch may turn under a run of labels, degrees: a line
 * bending less stays inside its labels' gaps. */
const STRAIGHT = 8
/** Clear space kept past each end of a label from another one. */
const PAD = 1

const turnOf = (a: number, b: number) =>
  Math.abs(((((a - b + 540) % 360) + 360) % 360) - 180)

/** How long a run of labels is along its line: each one's text and gaps,
 * and a lead of line between two. */
export function inlineLength(ws: readonly number[]): number {
  if (!ws.length) return 0
  return (
    ws.reduce((s, w) => s + inlineSpan(w), 0) + (ws.length - 1) * LABEL.LEAD
  )
}

/** A run of end labels placed: each one's place, and how far along the
 * route from its end the run reaches, px. */
export interface InlinePlace {
  at: PortPlace[]
  reach: number
}

/**
 * Place every run of end labels, in order: on a straight stretch of its
 * route between `from` and `until`, nearest the end first, each label
 * centred on the line and turned to read upright, clear of every card,
 * label and other cable; cut short as its `least` allows when the whole
 * run has no room. Null = no room, left off.
 */
export function placeInline(
  asks: readonly InlineAsk[],
  scene: LabelScene
): Map<string, InlinePlace | null> {
  const out = new Map<string, InlinePlace | null>()
  for (const ask of asks) {
    // The whole run, or - when it has no room anywhere - the longest
    // shorter one down to `least` labels, cut from the far end.
    let found: InlinePlace | null = null
    const least = Math.min(Math.max(1, ask.least ?? Infinity), ask.ws.length)
    for (let n = ask.ws.length; n >= least && !found; n--)
      found = placeRun(ask, ask.ws.slice(0, n), scene)
    out.set(ask.key, found)
  }
  return out
}

/** One run of labels (`ws`, nearest the end first) placed along `ask`'s
 * route and taken into the scene, or null. */
function placeRun(
  ask: InlineAsk,
  ws: readonly number[],
  scene: LabelScene
): InlinePlace | null {
  const walk = ask.walk
  const spans = ws.map(inlineSpan)
  const total = inlineLength(ws)
  const mine = (c: string) => c === ask.cable
  // What stopped the last try: a label sliding along its line usually
  // runs into the same thing a step on, so it is asked first.
  let last: Blocker | null = null
  // On a curve the labels read over a cable crossing them.
  const crossing = !!ask.curved
  const stop = (box: TurnedBox): Blocker | null => {
    if (last && blocks(last, box, mine, crossing)) return last
    last = scene.blocker(box, mine, crossing)
    return last
  }
  // A port name keeps to its nub's run: straight from the end on. The
  // run is probed every PROBE px once, however far the name slides:
  // the two directions furthest apart so far stand for all of them (a
  // stretch whose directions spread more than twice STRAIGHT cannot lie
  // within STRAIGHT of one chord; one that spreads less does when both
  // of those do).
  let upto = ask.run ?? 0
  let ref = NaN
  let lo = Infinity
  let hi = -Infinity
  let loA = 0
  let hiA = 0
  const runTo = (b: number) => {
    for (; upto < b; upto += PROBE) {
      const angle = walk(upto).angle
      if (Number.isNaN(ref)) ref = angle
      const dev = ((((angle - ref + 540) % 360) + 360) % 360) - 180
      if (dev < lo) [lo, loA] = [dev, angle]
      if (dev > hi) [hi, hiA] = [dev, angle]
    }
  }
  const bentFrom = (chord: number) =>
    hi - lo > 2 * STRAIGHT + 1e-9 ||
    turnOf(loA, chord) > STRAIGHT ||
    turnOf(hiA, chord) > STRAIGHT
  // On a straight route, the tries after one that stopped are passed
  // over while the label that stopped is sure to stay stopped by what
  // stopped it (each would fail the same way).
  const line = ask.line
  let skip: { from: number; by: number } | null = null
  let found: InlinePlace | null = null
  for (let d = ask.from; d + total <= ask.until + 1e-6; d += STEP) {
    if (skip && d - skip.from <= skip.by) continue
    skip = null
    const places: PortPlace[] = []
    const takes: TurnedBox[][] = []
    let off = d
    let bent = false
    for (let i = 0; i < spans.length; i++) {
      if (ask.curved) {
        const fit = onCurve(walk, off, spans[i], PAD)
        if (!fit) break
        let hit: Blocker | null = null
        for (const box of fit.boxes) if ((hit = stop(box))) break
        if (hit) break
        places.push(fit.place)
        takes.push(fit.taken)
        off += spans[i] + LABEL.LEAD
        continue
      }
      // Each label on a straight stretch of its own, centred on the
      // route and turned along the stretch.
      const [a, b] = [off, off + spans[i]]
      const p = walk(a)
      const q = walk(b)
      const chord = (Math.atan2(q.y - p.y, q.x - p.x) * 180) / Math.PI
      let straight = Math.hypot(q.x - p.x, q.y - p.y) > spans[i] * 0.97
      if (ask.first && i === 0) {
        if (straight) runTo(b)
        if (straight && (bentFrom(chord) || turnOf(q.angle, chord) > STRAIGHT))
          straight = false
      } else
        for (let k = a; straight && k < b + PROBE; k += PROBE)
          if (turnOf(walk(Math.min(k, b)).angle, chord) > STRAIGHT)
            straight = false
      if (!straight) {
        bent = i === 0
        break
      }
      const c = walk(a + spans[i] / 2)
      const place = { x: c.x, y: c.y, rotate: uprightAngle(chord) }
      const box = inlineBox(place, ws[i], PAD, PAD / 2)
      const hit = stop(box)
      if (hit) {
        const by = line ? sureRun(hit, line, box, a + spans[i] / 2) : 0
        if (by > 0) skip = { from: d, by }
        break
      }
      places.push(place)
      takes.push([inlineBox(place, ws[i])])
      off = b + LABEL.LEAD
    }
    if (places.length === spans.length) {
      found = { at: places, reach: d + total }
      for (const boxes of takes) for (const box of boxes) scene.take(box)
      break
    }
    // Past the run out of the nub: nothing further along will do.
    if (ask.first && bent && d > ask.from) break
  }
  return found
}

/** Where a middle chip may sit, nearest the middle first. */
const CHIP_T = [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.18, 0.82]

/** Where a chip centred `off` px beside its line at `t` sits. */
export function chipCentre(
  at: (t: number) => Pt & { angle?: number },
  t: number,
  off: number
): Pt {
  const p = at(t)
  if (!off) return { x: p.x, y: p.y }
  const r = ((p.angle ?? 0) * Math.PI) / 180
  return { x: p.x - Math.sin(r) * off, y: p.y + Math.cos(r) * off }
}

/**
 * Place every middle chip, in order: on its line at the middle, or the
 * nearest spot along it clear of cards and labels; failing that, beside
 * the line (a short breakout trunk, whose port name takes the line); and
 * failing that it is `crowded`, left at the middle.
 */
export function placeChips(
  asks: readonly ChipAsk[],
  scene: LabelScene
): Map<string, ChipPlace> {
  const out = new Map<string, ChipPlace>()
  for (const ask of asks) {
    const boxAt = (t: number, off: number) => {
      const p = chipCentre(ask.at, t, off)
      return turnedBox(
        inflate(
          { x: p.x - ask.w / 2, y: p.y - ask.h / 2, w: ask.w, h: ask.h },
          2
        )
      )
    }
    const beside = ask.h / 2 + LABEL.BESIDE
    let found: ChipPlace | null = null
    for (const off of [0, beside, -beside]) {
      const t = CHIP_T.find((c) =>
        scene.free(boxAt(c, off), (k) => ask.own.has(k))
      )
      if (t !== undefined) {
        found = { t, off, crowded: false }
        break
      }
    }
    if (!found) {
      out.set(ask.key, { t: 0.5, off: 0, crowded: true })
      continue
    }
    scene.take(boxAt(found.t, found.off))
    out.set(ask.key, found)
  }
  return out
}
