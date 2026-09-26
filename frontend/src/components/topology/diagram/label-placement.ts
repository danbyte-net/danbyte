import { PORT_H, portPlace } from "@/lib/diagram/geometry"
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
//   off (the nub's tooltip still names the port).
// - A middle chip sits at the middle of its route, or the nearest spot
//   along it clear of cards and other labels; with none free it is
//   `crowded` and shows on hover only.

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

type Item =
  | { k: "seg"; cable: string; p: Pt; q: Pt }
  | { k: "card"; box: TurnedBox }
  | { k: "label"; box: TurnedBox }

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
      } else if (boxesOverlap(box, it.box)) return false
    }
    return true
  }

  take(box: TurnedBox): void {
    this.grid.add(turnedBounds(box), { k: "label", box })
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
    if (found) scene.take(portBox(found, ask.w))
    out.set(ask.key, found)
  }
  return out
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
