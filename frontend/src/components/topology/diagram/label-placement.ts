import { PORT_H, portPlace, uprightAngle } from "@/lib/diagram/geometry"
import type { PortPlace } from "@/lib/diagram/geometry"
import { LABEL } from "@/lib/diagram/theme"
import {
  Grid,
  boxesOverlap,
  inflate,
  segBox,
  segHitsBox,
  turnedBox,
  turnedBounds,
} from "./spatial"
import type { TurnedBox } from "./spatial"
import type { Pt, Rect } from "./types"

// Where a Diagram's labels go once every cable is routed. Best effort, in
// a fixed order so the result is deterministic:
//
// - A port name runs along its own cable's first straight run, beside the
//   line on the outside of its first bend. When that spot is taken by
//   another cable, label or card it tries the other side of the line, then
//   slides out along the run (either side); when nothing fits it is left
//   off (the nub's tooltip still names the port). Where that left names
//   off on one card side - cables running out of it side by side, like
//   breakout legs converging on one card - the side's names are seated
//   again in order along it, each in the gap before its cable when free,
//   and the seating that shows more names is kept.
// - A middle chip sits at the middle of its route, or the nearest spot
//   along it clear of cards and other labels; with none free it is
//   `crowded` and shows on hover only.
// - An end's addresses run along its cable like a port name, on a straight
//   stretch of the route: in Detailed on the other side of the line from
//   the port name, in Simple a little way out from the point the side's
//   lines share. With no free stretch they are left off.

/** A port name to place. */
export interface PortLabelAsk {
  /** Unique per label. */
  key: string
  /** The route it belongs to: its own cable never blocks it. */
  cable: string
  text: string
  /** Measured text width. */
  w: number
  /** The route's terminal at the port. */
  start: Pt
  /** Direction of travel away from the port, degrees. */
  angle: number
  /** Straight length the route runs from the terminal. */
  room: number
  /** Preferred side of the line (`portSide`). */
  side: 1 | -1
  /** The card side the name's cable leaves square to (node and side):
   * names in one group are re-seated together when some were left off. */
  group?: string
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
        this.grid.add(segBox(p, q, 1), { k: "seg", cable, p, q })
      }
    for (const r of cards) this.grid.add(r, { k: "card", box: turnedBox(r) })
  }

  /** Is `box` clear of every card, label and cable but its own
   * (`mine`)? */
  free(box: TurnedBox, mine: (cable: string) => boolean): boolean {
    for (const it of this.grid.near(turnedBounds(box))) {
      if (it.k === "seg") {
        if (mine(it.cable)) continue
        if (segHitsBox(it.p, it.q, box)) return false
      } else if (it.k === "label" && it.dead) continue
      else if (boxesOverlap(box, it.box)) return false
    }
    return true
  }

  take(box: TurnedBox): Taken {
    const it: Label = { k: "label", box }
    this.grid.add(turnedBounds(box), it)
    return it
  }

  drop(it: Taken): void {
    it.dead = true
  }
}

/** A port name's box at a place. `gap` keeps names from reading as one
 * where they meet end to end. */
export function portBox(place: PortPlace, w: number, gap = 0): TurnedBox {
  return {
    cx: place.x,
    cy: place.y,
    hw: (w + 3) / 2 + gap,
    hh: PORT_H / 2,
    angle: place.rotate,
  }
}

/** The clear space kept between two port names end to end. */
const NAME_GAP = 3

/** How far out along its run a port name may start: from just past the
 * nub, in small steps, while the whole name stays on the run. */
function alongs(ask: PortLabelAsk): number[] {
  const out: number[] = []
  const last = ask.room - ask.w - 1
  for (let d = LABEL.PORT_DIST; d <= last + 1e-6; d += 6) out.push(d)
  return out
}

/** Place every port name, in order. Null = left off. */
export function placePortLabels(
  asks: readonly PortLabelAsk[],
  scene: LabelScene
): Map<string, PortPlace | null> {
  const out = new Map<string, PortPlace | null>()
  const taken = new Map<string, Taken>()
  for (const ask of asks) {
    let found: PortPlace | null = null
    for (const d of alongs(ask)) {
      for (const side of [ask.side, -ask.side as 1 | -1]) {
        const place = portPlace(ask.start, ask.angle, ask.w, side, d)
        if (
          scene.free(portBox(place, ask.w, NAME_GAP), (c) => c === ask.cable)
        ) {
          found = place
          break
        }
      }
      if (found) break
    }
    if (found) taken.set(ask.key, scene.take(portBox(found, ask.w)))
    out.set(ask.key, found)
  }
  reseat(asks, scene, out, taken)
  return out
}

/** Where a name first fits along its run, trying `sides` in turn. */
function firstFit(
  ask: PortLabelAsk,
  sides: readonly (1 | -1)[],
  scene: LabelScene
): PortPlace | null {
  for (const side of sides)
    for (const d of alongs(ask)) {
      const place = portPlace(ask.start, ask.angle, ask.w, side, d)
      if (scene.free(portBox(place, ask.w, NAME_GAP), (c) => c === ask.cable))
        return place
    }
  return null
}

/**
 * Seat again the names of each card side (`group`) the first pass left
 * some off: in order along the side, each takes the gap before its cable
 * when free, else the one after - from either end of the side. Cables
 * running out side by side leave one gap per name that way, where the
 * first pass could fill a gap two names needed. The seating that shows
 * the most names is kept (the first pass's on a tie).
 */
function reseat(
  asks: readonly PortLabelAsk[],
  scene: LabelScene,
  out: Map<string, PortPlace | null>,
  taken: Map<string, Taken>
): void {
  const groups = new Map<string, PortLabelAsk[]>()
  for (const a of asks) {
    if (!a.group) continue
    const list = groups.get(a.group)
    if (list) list.push(a)
    else groups.set(a.group, [a])
  }
  // Where a name's cable sits across its run: along the right hand of
  // travel, which is where side +1 puts it.
  const across = (a: PortLabelAsk) => {
    const r = (a.angle * Math.PI) / 180
    return -Math.sin(r) * a.start.x + Math.cos(r) * a.start.y
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue
    const shown = list.filter((a) => out.get(a.key)).length
    if (shown === list.length) continue
    for (const a of list) {
      const t = taken.get(a.key)
      if (t) scene.drop(t)
    }
    let best: Map<string, PortPlace | null> | null = null
    let most = shown
    for (const dir of [1, -1] as const) {
      const sorted = [...list].sort(
        (x, y) => dir * (across(x) - across(y)) || (x.key < y.key ? -1 : 1)
      )
      const places = new Map<string, PortPlace | null>()
      const held: Taken[] = []
      for (const a of sorted) {
        const place = firstFit(a, [-dir as 1 | -1, dir], scene)
        if (place) held.push(scene.take(portBox(place, a.w)))
        places.set(a.key, place)
      }
      for (const t of held) scene.drop(t)
      if (held.length > most) {
        most = held.length
        best = places
      }
    }
    if (best) for (const [k, p] of best) out.set(k, p)
    for (const a of list) {
      const p = out.get(a.key)
      if (p) taken.set(a.key, scene.take(portBox(p, a.w)))
    }
  }
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
    const beside = ask.h / 2 + LABEL.PORT_OFFSET
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

/** An end's addresses to place: a block of lines running along its cable
 * from that end. */
export interface EndLabelAsk {
  key: string
  /** The widest line, measured. */
  w: number
  lines: number
  /** The drawn route walked from this end: the point `d` px along it, and
   * the direction of travel there in degrees. */
  walk: (d: number) => Pt & { angle: number }
  /** The stretch of route the block may sit along, px from the end. */
  from: number
  until: number
  /** Preferred side of the line (+1 = the right hand of travel). */
  side: 1 | -1
}

/** An address block's box at a place. */
export function endBox(
  place: PortPlace,
  w: number,
  lines: number,
  gap = 0
): TurnedBox {
  return {
    cx: place.x,
    cy: place.y,
    hw: (w + 3) / 2 + gap,
    hh: (lines * PORT_H) / 2,
    angle: place.rotate,
  }
}

/** Steps along a route an address block tries, px. */
const END_STEP = 4
/** The most a stretch may turn under an address block, degrees. */
const STRAIGHT = 8

const turnOf = (a: number, b: number) =>
  Math.abs(((((a - b + 540) % 360) + 360) % 360) - 180)

/**
 * Place every end's addresses, in order: along a straight stretch of its
 * route between `from` and `until`, beside the line on its preferred side
 * first, turned like a port name to read upright. The block keeps clear of
 * every card, label and cable, its own included. Null = left off.
 */
export function placeEndLabels(
  asks: readonly EndLabelAsk[],
  scene: LabelScene
): Map<string, PortPlace | null> {
  const out = new Map<string, PortPlace | null>()
  for (const ask of asks) {
    const at = new Map<number, Pt & { angle: number }>()
    const walk = (d: number) => {
      let p = at.get(d)
      if (!p) at.set(d, (p = ask.walk(d)))
      return p
    }
    const h = ask.lines * PORT_H
    let found: PortPlace | null = null
    for (const side of [ask.side, -ask.side as 1 | -1]) {
      for (let d = ask.from; d + ask.w <= ask.until + 1e-6; d += END_STEP) {
        const p = walk(d)
        const q = walk(d + ask.w)
        const chord = (Math.atan2(q.y - p.y, q.x - p.x) * 180) / Math.PI
        let straight = Math.hypot(q.x - p.x, q.y - p.y) > ask.w * 0.95
        for (let k = d; straight && k <= d + ask.w; k += END_STEP)
          if (turnOf(walk(k).angle, chord) > STRAIGHT) straight = false
        if (!straight) continue
        const r = (chord * Math.PI) / 180
        const o = side * (LABEL.PORT_OFFSET + h / 2)
        const place = {
          x: (p.x + q.x) / 2 - Math.sin(r) * o,
          y: (p.y + q.y) / 2 + Math.cos(r) * o,
          rotate: uprightAngle(chord),
        }
        if (
          scene.free(endBox(place, ask.w, ask.lines, NAME_GAP), () => false)
        ) {
          found = place
          break
        }
      }
      if (found) break
    }
    if (found) scene.take(endBox(found, ask.w, ask.lines))
    out.set(ask.key, found)
  }
  return out
}
