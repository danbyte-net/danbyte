import { laneSegments } from "./cable-draw"
import type { LaidSeg } from "./cable-draw"
import type { Pt } from "./cable-route"

// One label pass for everything the 2D plan writes - the canvas
// (plan-labels-layer.tsx) and the paper export (plan-svg.ts) alike. Each
// text is a request with a priority and a few places it may go; the
// highest ranked take their first free place, the rest move on to their
// next, and a text with nowhere left to go hides. A forced request (a
// traced or hovered cable, the selection, a plan label) always shows.
//
// Cable names read like road names on a map: along the line, upright,
// on a halo, repeated every so often along a long run so whichever part
// of the cable is in view carries its name.
//
// Units: everything is laid out in "units" - screen px on the canvas,
// paper mm on the export - at `scale` units per cell; places are kept in
// cells, as the routes are.

/** A rectangle in units (or cells, where said). */
export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** Labels on screen: the font (px) and the interval a name repeats at
 * along a long run (px of on-screen length). */
export const LABEL_FONT_PX = 11
export const LABEL_REPEAT_PX = 280
/** On paper: the same in mm. */
export const LABEL_FONT_MM = 2
export const LABEL_REPEAT_MM = 70
/** A chip's font beside an end (px / mm). */
export const CHIP_FONT_PX = 10
export const CHIP_FONT_MM = 1.8

/** ~Average glyph width of the sans, per em. */
const GLYPH_EM = 0.6
const EPS = 1e-6

/** A line of text's box at `font`: its width and height (units). */
export function textSize(text: string, font: number): { w: number; h: number } {
  return { w: text.length * font * GLYPH_EM + font * 0.4, h: font * 1.3 }
}

export function boxesHit(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  )
}

/** The boxes taken so far, bucketed in a grid: near-linear for thousands. */
export class Occupancy {
  private grid = new Map<string, Box[]>()
  private all: Box[] = []
  constructor(private cell = 64) {}

  private keys(b: Box): string[] {
    const out: string[] = []
    const c = this.cell
    const x0 = Math.floor(b.x / c)
    const x1 = Math.floor((b.x + b.w) / c)
    const y0 = Math.floor(b.y / c)
    const y1 = Math.floor((b.y + b.h) / c)
    // A huge box (a plan label across the plan) checks the list instead.
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 400) return ["*"]
    for (let gx = x0; gx <= x1; gx++)
      for (let gy = y0; gy <= y1; gy++) out.push(`${gx},${gy}`)
    return out
  }

  free(b: Box): boolean {
    const big = this.grid.get("*")
    if (big?.some((o) => boxesHit(b, o))) return false
    const ks = this.keys(b)
    if (ks[0] === "*") return !this.all.some((o) => boxesHit(b, o))
    for (const k of ks)
      if (this.grid.get(k)?.some((o) => boxesHit(b, o))) return false
    return true
  }

  add(b: Box): void {
    this.all.push(b)
    for (const k of this.keys(b)) {
      const list = this.grid.get(k)
      if (list) list.push(b)
      else this.grid.set(k, [b])
    }
  }

  boxes(): readonly Box[] {
    return this.all
  }
}

/** One place a label may go: its box (units) and what draws it there. */
export interface LabelSpot<T> {
  box: Box
  data: T
}

export interface LabelRequest<T> {
  id: string
  /** Higher places first; ties keep the requests' order. */
  priority: number
  /** Always shown - its first free place, else its first. */
  force?: boolean
  /** Where it may go, best first. */
  spots: LabelSpot<T>[]
  /** Kept clear when it can be (an area's name off its racks). */
  avoid?: readonly Box[]
  /** Never placed over these (an icon's name off the other icons): a spot
   * that hits one is no spot, forced or not. */
  block?: { free: (b: Box) => boolean }
}

/** Place the requests, highest ranked first, each at its first free spot.
 * Returns the id → the spot chosen; a request missing from it hides. */
export function placeLabels<T>(
  reqs: readonly LabelRequest<T>[],
  occ: Occupancy = new Occupancy()
): Map<string, LabelSpot<T>> {
  const order = reqs
    .map((r, i) => ({ r, i }))
    .sort((a, b) => b.r.priority - a.r.priority || a.i - b.i)
  const out = new Map<string, LabelSpot<T>>()
  for (const { r } of order) {
    const spots = r.block ? r.spots.filter((s) => r.block!.free(s.box)) : r.spots
    if (!spots.length && !(r.force && r.spots.length)) continue
    let pick: LabelSpot<T> | undefined
    if (r.avoid?.length)
      pick = spots.find(
        (s) => occ.free(s.box) && !r.avoid!.some((a) => boxesHit(s.box, a))
      )
    pick ??= spots.find((s) => occ.free(s.box))
    if (!pick && r.force) pick = spots[0] ?? r.spots[0]
    if (!pick) continue
    occ.add(pick.box)
    out.set(r.id, pick)
  }
  return out
}

// ── Along a line ────────────────────────────────────────────────────────────

/** A straight stretch of a run (cells), and whether it rides a tray. */
export interface Leg {
  a: Pt
  b: Pt
  tray: boolean
}

const len = (a: Pt, b: Pt) => Math.hypot(b[0] - a[0], b[1] - a[1])

/** A polyline's straight stretches, collinear pieces joined. */
export function polylineLegs(points: readonly Pt[], tray = false): Leg[] {
  const legs: Leg[] = []
  for (let i = 0; i < points.length - 1; i++)
    pushLeg(legs, { a: points[i], b: points[i + 1], tray })
  return legs
}

function pushLeg(legs: Leg[], leg: Leg) {
  if (len(leg.a, leg.b) < EPS) return
  const prev = legs.at(-1)
  if (prev) {
    const d1: Pt = [prev.b[0] - prev.a[0], prev.b[1] - prev.a[1]]
    const d2: Pt = [leg.b[0] - leg.a[0], leg.b[1] - leg.a[1]]
    const cross = d1[0] * d2[1] - d1[1] * d2[0]
    const dot = d1[0] * d2[0] + d1[1] * d2[1]
    if (
      Math.abs(cross) < 1e-6 * len(prev.a, prev.b) * len(leg.a, leg.b) + EPS &&
      dot > 0 &&
      len(prev.b, leg.a) < 1e-3
    ) {
      // The joined stretch rides a tray when most of it does.
      const l1 = len(prev.a, prev.b)
      const l2 = len(leg.a, leg.b)
      prev.tray = (prev.tray ? l1 : 0) + (leg.tray ? l2 : 0) >= (l1 + l2) / 2
      prev.b = leg.b
      return
    }
  }
  legs.push({ ...leg })
}

/** A cable's straight stretches in its own lane - where its name runs -
 * leaving out the pieces `skip` says (those drawn in a bundle). */
export function cableLegs(
  segs: readonly LaidSeg[],
  skip: (s: LaidSeg) => boolean = () => false
): Leg[][] {
  const joined = laneSegments(segs)
  const out: Leg[][] = []
  let cur: Leg[] | null = null
  segs.forEach((s, i) => {
    if (skip(s)) {
      cur = null
      return
    }
    if (!cur) {
      cur = []
      out.push(cur)
    }
    pushLeg(cur, {
      a: joined[i].a,
      b: joined[i].b,
      tray: !!s.group?.startsWith("t:"),
    })
  })
  return out.filter((l) => l.length)
}

/** The angle text runs at along a→b (degrees), kept upright: never
 * upside down, a vertical run reading bottom to top. */
export function uprightAngle(a: Pt, b: Pt): number {
  let deg = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI
  if (deg >= 90 - EPS) deg -= 180
  else if (deg < -90 - EPS) deg += 180
  return Math.abs(deg) < EPS ? 0 : deg
}

/** A `w` x `h` box turned by `deg` about (cx, cy): its upright bounds. */
export function turnedBox(
  cx: number,
  cy: number,
  w: number,
  h: number,
  deg: number
): Box {
  const r = (deg * Math.PI) / 180
  const c = Math.abs(Math.cos(r))
  const s = Math.abs(Math.sin(r))
  const bw = w * c + h * s
  const bh = w * s + h * c
  return { x: cx - bw / 2, y: cy - bh / 2, w: bw, h: bh }
}

/** Where a label along a line draws: its centre (cells) and its angle. */
export interface AlongSpot {
  at: Pt
  angle: number
}

/**
 * The slots a text takes along `legs`: on every stretch long enough to
 * hold it, one every `repeat` units of its length, centred; each slot with
 * a few places either way along the stretch to move to. `offset` (units)
 * sets it beside the line, on either side, instead of on it. With a
 * `view` (units) only slots in it are laid out. Stretches along a tray
 * first, then the longer.
 */
export function alongSlots(
  legs: readonly Leg[],
  size: { w: number; h: number },
  {
    scale,
    repeat,
    view,
    offset = 0,
  }: { scale: number; repeat: number; view?: Box | null; offset?: number }
): LabelSpot<AlongSpot>[][] {
  const need = size.w + size.h
  const sorted = [...legs].sort(
    (x, y) => Number(y.tray) - Number(x.tray) || len(y.a, y.b) - len(x.a, x.b)
  )
  const slots: LabelSpot<AlongSpot>[][] = []
  for (const leg of sorted) {
    const L = len(leg.a, leg.b) * scale
    if (L < need) continue
    const dir: Pt = [
      (leg.b[0] - leg.a[0]) / (L / scale),
      (leg.b[1] - leg.a[1]) / (L / scale),
    ]
    const nrm: Pt = [-dir[1], dir[0]]
    const angle = uprightAngle(leg.a, leg.b)
    const lo = need / 2
    const range = L - need
    const count = Math.max(1, Math.floor(range / repeat) + 1)
    const step = range / count
    const sides = offset ? [offset, -offset] : [0]
    for (let k = 0; k < count; k++) {
      const centre = lo + step * (k + 0.5)
      const at0: Pt = [
        leg.a[0] + (dir[0] * centre) / scale,
        leg.a[1] + (dir[1] * centre) / scale,
      ]
      if (view) {
        const [ux, uy] = [at0[0] * scale, at0[1] * scale]
        const m = size.w / 2
        if (
          ux < view.x - m ||
          uy < view.y - m ||
          ux > view.x + view.w + m ||
          uy > view.y + view.h + m
        )
          continue
      }
      const spots: LabelSpot<AlongSpot>[] = []
      const shifts =
        count === 1 ? [0, -0.2, 0.2, -0.4, 0.4] : [0, -0.15, 0.15, -0.3, 0.3]
      for (const f of shifts) {
        const s = centre + f * (count === 1 ? range : step)
        if (s < lo - EPS || s > lo + range + EPS) continue
        for (const side of sides) {
          const at: Pt = [
            leg.a[0] + (dir[0] * s + nrm[0] * side) / scale,
            leg.a[1] + (dir[1] * s + nrm[1] * side) / scale,
          ]
          spots.push({
            box: turnedBox(at[0] * scale, at[1] * scale, size.w, size.h, angle),
            data: { at, angle },
          })
        }
      }
      slots.push(spots)
    }
  }
  return slots
}

// ── A cable's ends ──────────────────────────────────────────────────────────

export type Edge = "top" | "bottom" | "left" | "right"

/** Where a run leaves its tile's box (cells): the point on the box's edge,
 * which edge, and the run's direction there. Walks the run from its first
 * point; a run that starts outside the box leaves from where it starts. */
export function tileExit(
  points: readonly Pt[],
  rect: Box
): { at: Pt; edge: Edge | null; dir: Pt } {
  const inside = (p: Pt) =>
    p[0] > rect.x + EPS &&
    p[0] < rect.x + rect.w - EPS &&
    p[1] > rect.y + EPS &&
    p[1] < rect.y + rect.h - EPS
  const dirOf = (p: Pt, q: Pt): Pt => {
    const l = len(p, q) || 1
    return [(q[0] - p[0]) / l, (q[1] - p[1]) / l]
  }
  if (points.length < 2 || !inside(points[0]))
    return {
      at: points[0],
      edge: null,
      dir: points.length > 1 ? dirOf(points[0], points[1]) : [0, -1],
    }
  for (let i = 0; i < points.length - 1; i++) {
    const p = points[i]
    const q = points[i + 1]
    if (inside(q)) continue
    const d: Pt = [q[0] - p[0], q[1] - p[1]]
    const tx =
      d[0] > EPS
        ? (rect.x + rect.w - p[0]) / d[0]
        : d[0] < -EPS
          ? (rect.x - p[0]) / d[0]
          : Infinity
    const ty =
      d[1] > EPS
        ? (rect.y + rect.h - p[1]) / d[1]
        : d[1] < -EPS
          ? (rect.y - p[1]) / d[1]
          : Infinity
    const t = Math.max(0, Math.min(1, tx, ty))
    const edge: Edge =
      tx <= ty ? (d[0] > 0 ? "right" : "left") : d[1] > 0 ? "bottom" : "top"
    return { at: [p[0] + d[0] * t, p[1] + d[1] * t], edge, dir: dirOf(p, q) }
  }
  const last = points[points.length - 1]
  return { at: last, edge: null, dir: dirOf(points[points.length - 2], last) }
}

/**
 * The places an end's chip may go (centres, cells): outside its tile, at
 * the edge the run leaves by - above or below it for the top or the
 * bottom edge, beside it for a side - to either side of the run, never on
 * the tile. `size` and `gap` in units.
 */
export function endChipSpots(
  exit: { at: Pt; edge: Edge | null },
  rect: Box,
  size: { w: number; h: number },
  gap: number,
  scale: number
): LabelSpot<{ at: Pt }>[] {
  const { w, h } = size
  const ex = exit.at[0] * scale
  const ey = exit.at[1] * scale
  const r = {
    x0: rect.x * scale,
    y0: rect.y * scale,
    x1: (rect.x + rect.w) * scale,
    y1: (rect.y + rect.h) * scale,
  }
  const centres: [number, number][] = []
  switch (exit.edge) {
    case "top":
    case "bottom": {
      const cy = exit.edge === "top" ? r.y0 - gap - h / 2 : r.y1 + gap + h / 2
      centres.push([ex + gap + w / 2, cy], [ex - gap - w / 2, cy], [ex, cy])
      break
    }
    case "left":
    case "right": {
      const cx = exit.edge === "left" ? r.x0 - gap - w / 2 : r.x1 + gap + w / 2
      centres.push([cx, ey - gap - h / 2], [cx, ey + gap + h / 2], [cx, ey])
      break
    }
    default:
      centres.push(
        [ex + gap + w / 2, ey - gap - h / 2],
        [ex - gap - w / 2, ey - gap - h / 2],
        [ex + gap + w / 2, ey + gap + h / 2],
        [ex - gap - w / 2, ey + gap + h / 2]
      )
  }
  return centres.map(([cx, cy]) => ({
    box: { x: cx - w / 2, y: cy - h / 2, w, h },
    data: { at: [cx / scale, cy / scale] as Pt },
  }))
}

/** The places a name may go round a box (cells): under it, hugging its
 * edge, else above, right, left. Data: the name's centre (cells). */
export function besideSpots(
  rect: Box,
  size: { w: number; h: number },
  gap: number,
  scale: number
): LabelSpot<{ at: Pt }>[] {
  const { w, h } = size
  const x0 = rect.x * scale
  const y0 = rect.y * scale
  const x1 = (rect.x + rect.w) * scale
  const y1 = (rect.y + rect.h) * scale
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  return (
    [
      [cx, y1 + gap + h / 2],
      [cx, y0 - gap - h / 2],
      [x1 + gap + w / 2, cy],
      [x0 - gap - w / 2, cy],
    ] as [number, number][]
  ).map(([x, y]) => ({
    box: { x: x - w / 2, y: y - h / 2, w, h },
    data: { at: [x / scale, y / scale] as Pt },
  }))
}

/** The places a name may go round an icon `rect` (cells), best first:
 * right, left, below, above, then the four corners. Data: the name's
 * centre (cells). */
export function aroundSpots(
  rect: Box,
  size: { w: number; h: number },
  gap: number,
  scale: number
): LabelSpot<{ at: Pt }>[] {
  const { w, h } = size
  const x0 = rect.x * scale
  const y0 = rect.y * scale
  const x1 = (rect.x + rect.w) * scale
  const y1 = (rect.y + rect.h) * scale
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  const right = x1 + gap + w / 2
  const left = x0 - gap - w / 2
  const below = y1 + gap + h / 2
  const above = y0 - gap - h / 2
  return (
    [
      [right, cy],
      [left, cy],
      [cx, below],
      [cx, above],
      [right, below],
      [left, below],
      [right, above],
      [left, above],
    ] as [number, number][]
  ).map(([x, y]) => ({
    box: { x: x - w / 2, y: y - h / 2, w, h },
    data: { at: [x / scale, y / scale] as Pt },
  }))
}

/** The places an area's name may go inside its box (cells): its top left
 * corner first, then the other corners, its middle, and a few points
 * between - the caller keeps it off the racks with `avoid`. Data: the
 * name box's top left (cells). */
export function insideSpots(
  rect: Box,
  size: { w: number; h: number },
  pad: number,
  scale: number
): LabelSpot<{ at: Pt }>[] {
  const x0 = rect.x * scale + pad
  const y0 = rect.y * scale + pad
  const x1 = (rect.x + rect.w) * scale - pad - size.w
  const y1 = (rect.y + rect.h) * scale - pad - size.h
  if (x1 < x0 || y1 < y0) return []
  const fr = [0, 1, 0.5, 0.25, 0.75]
  const seen = new Set<string>()
  const out: LabelSpot<{ at: Pt }>[] = []
  const add = (fx: number, fy: number) => {
    const x = x0 + (x1 - x0) * fx
    const y = y0 + (y1 - y0) * fy
    const key = `${x.toFixed(1)},${y.toFixed(1)}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({
      box: { x, y, w: size.w, h: size.h },
      data: { at: [x / scale, y / scale] },
    })
  }
  add(0, 0)
  add(1, 0)
  add(0, 1)
  add(1, 1)
  add(0.5, 0.5)
  for (const fy of fr) for (const fx of fr) add(fx, fy)
  return out
}

/** Label ranks, highest first. Plan labels the user placed never hide;
 * cables are the focus - the traced, hovered and selected first, then the
 * documented, then the rest - then what the plan holds. */
export const RANK = {
  planLabel: 9e6,
  focus: 8e6,
  tileFixed: 7e6,
  tilePinned: 6e6,
  cableStored: 5e6,
  bundle: 4.5e6,
  cable: 4e6,
  endChip: 3.5e6,
  tray: 3e6,
  tile: 2e6,
  area: 1e6,
  raised: 0,
} as const
