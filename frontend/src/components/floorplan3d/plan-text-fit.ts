import { pointInPolygon, rotatePoint } from "@/components/floorplan/shapes"
import type { Pt } from "@/components/floorplan/shapes"

// Fitting a room's, an area's or a zone's name inside its own floor: the
// text is a box on the plan that must stay inside the area's outline, a
// margin in from its edges, and clear of every wall on the level. Where
// the 2D place fits, the text keeps it; else it moves to the spot in the
// room with the most space, turned along the room if that holds it better,
// shrunk to what fits - and is left out when that is too small to read.
// All in plan cells.

/** A wall run's leg: no text within `clear` of it (cells). */
export interface FitSegment {
  a: Pt
  b: Pt
  clear: number
}

/** Where a text may lie: inside `outline`, `margin` in from its edges and
 * clear of the `obstacles`. `angles` are the turns (degrees) the text may
 * take besides its own. */
export interface FitRegion {
  outline: Pt[]
  margin: number
  obstacles: FitSegment[]
  angles?: number[]
}

/** A box on the plan: its middle, half sizes, turn (degrees clockwise). */
export interface FitBox {
  c: Pt
  hw: number
  hh: number
  rot: number
}

/** Where a fitted text lies: its quad's `pivot` at `at`, turned
 * `rotation`, at `scale` times its own size; it may grow up to `maxGrow`
 * times that about its pivot and stay inside. */
export interface PlacedText {
  at: Pt
  pivot: [number, number]
  rotation: number
  scale: number
  maxGrow: number
}

/** Smaller than this share of its own size a name is not shown. */
export const MIN_FIT_SCALE = 0.5
/** The most a fit lets a text grow (Readable's cap). */
export const MAX_FIT_GROW = 60

/** p in the box's own frame, round its middle. */
function local(p: Pt, b: FitBox): Pt {
  return rotatePoint([p[0] - b.c[0], p[1] - b.c[1]], [0, 0], -b.rot)
}

/** Whether a segment touches the box [−ex, ex] × [−ey, ey]
 * (Liang-Barsky). */
export function segmentHitsRect(a: Pt, b: Pt, ex: number, ey: number) {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  let t0 = 0
  let t1 = 1
  const clip = (p: number, q: number) => {
    if (p === 0) return q >= 0
    const r = q / p
    if (p < 0) {
      if (r > t1) return false
      if (r > t0) t0 = r
    } else {
      if (r < t0) return false
      if (r < t1) t1 = r
    }
    return true
  }
  return (
    clip(-dx, a[0] + ex) &&
    clip(dx, ex - a[0]) &&
    clip(-dy, a[1] + ey) &&
    clip(dy, ey - a[1])
  )
}

/** Whether a box lies inside the region: its middle and its corners
 * (grown by the margin) inside the outline, no outline edge through it,
 * no wall within its clearance. */
export function boxFits(region: FitRegion, box: FitBox): boolean {
  const { outline, margin, obstacles } = region
  if (outline.length < 3 || !pointInPolygon(box.c, outline)) return false
  const ex = box.hw + margin
  const ey = box.hh + margin
  for (const [sx, sy] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ]) {
    const p = rotatePoint(
      [box.c[0] + sx * ex, box.c[1] + sy * ey],
      box.c,
      box.rot
    )
    if (!pointInPolygon(p, outline)) return false
  }
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    if (segmentHitsRect(local(outline[j], box), local(outline[i], box), ex, ey))
      return false
  }
  for (const o of obstacles) {
    const k = o.clear
    if (
      segmentHitsRect(local(o.a, box), local(o.b, box), box.hw + k, box.hh + k)
    )
      return false
  }
  return true
}

/** The largest s in (lo, hi] for which `at(s)` fits - the boxes growing
 * with s, each holding the one before; `lo` when none beyond it does. */
export function maxFit(
  region: FitRegion,
  at: (s: number) => FitBox,
  lo: number,
  hi: number
): number {
  if (boxFits(region, at(hi))) return hi
  let a = lo
  let b = hi
  for (let i = 0; i < 22; i++) {
    const m = (a + b) / 2
    if (boxFits(region, at(m))) a = m
    else b = m
  }
  return a
}

/** An angle as text reads it: in (−90, 90]. */
export function readableAngle(deg: number): number {
  let a = ((deg % 180) + 180) % 180
  if (a > 90) a -= 180
  return a === -90 ? 90 : a
}

/** The direction of an outline's longest edge (degrees, readable) - the
 * way a polygon room runs. */
export function mainAxis(outline: readonly Pt[]): number {
  let best = 0
  let len = -1
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const dx = outline[i][0] - outline[j][0]
    const dy = outline[i][1] - outline[j][1]
    const l = Math.hypot(dx, dy)
    if (l > len) {
      len = l
      best = (Math.atan2(dy, dx) * 180) / Math.PI
    }
  }
  return readableAngle(best)
}

/** A quad's middle (cells): `w` × `h` with its `pivot` at `at`, turned
 * `rotation`, grown `grow` about the pivot. */
function quadCentre(
  place: { at: Pt; pivot: [number, number]; rotation: number },
  w: number,
  h: number,
  grow: number
): Pt {
  return rotatePoint(
    [
      place.at[0] + (0.5 - place.pivot[0]) * w * grow,
      place.at[1] + (0.5 - place.pivot[1]) * h * grow,
    ],
    place.at,
    place.rotation
  )
}

const GRID = 14

/** How far (cells) a box must move along its own axes to lie the margin
 * in from the outline's extent in its frame; null when it cannot or need
 * not. For a rectangle at the box's turn that extent is the room. */
export function slideIn(region: FitRegion, box: FitBox): Pt | null {
  const loc = region.outline.map((p) => local(p, box))
  const xs = loc.map((p) => p[0])
  const ys = loc.map((p) => p[1])
  const m = region.margin + 1e-6
  const lo = [Math.min(...xs) + m + box.hw, Math.min(...ys) + m + box.hh]
  const hi = [Math.max(...xs) - m - box.hw, Math.max(...ys) - m - box.hh]
  if (lo[0] > hi[0] || lo[1] > hi[1]) return null
  const dx = Math.min(Math.max(0, lo[0]), hi[0])
  const dy = Math.min(Math.max(0, lo[1]), hi[1])
  if (!dx && !dy) return null
  return rotatePoint([dx, dy], [0, 0], box.rot)
}

/**
 * Fit a `w` × `h` text (cells, at its own size) into a region. `place` is
 * where the 2D plan puts it. Null when it cannot be shown at a readable
 * size without leaving its room or crossing a wall.
 */
export function fitPlanText(
  region: FitRegion,
  place: { at: Pt; pivot: [number, number]; rotation: number },
  w: number,
  h: number,
  {
    minScale = MIN_FIT_SCALE,
    maxGrow = MAX_FIT_GROW,
    anywhere = false,
  }: {
    minScale?: number
    maxGrow?: number
    /** Skip its 2D place: the roomiest spot only. */
    anywhere?: boolean
  } = {}
): PlacedText | null {
  if (!(w > 0 && h > 0) || region.outline.length < 3) return null
  const grown =
    (p: typeof place) =>
    (g: number): FitBox => ({
      c: quadCentre(p, w, h, g),
      hw: (w * g) / 2,
      hh: (h * g) / 2,
      rot: p.rotation,
    })
  const natural = grown(place)
  // Its 2D place holds it: it stays, and grows only as far as the room.
  if (!anywhere && boxFits(region, natural(1)))
    return { ...place, scale: 1, maxGrow: maxFit(region, natural, 1, maxGrow) }
  // Too near an edge: slid in off it, along its own axes.
  const slide = anywhere ? null : slideIn(region, natural(1))
  if (slide) {
    const moved = {
      ...place,
      at: [place.at[0] + slide[0], place.at[1] + slide[1]] as Pt,
    }
    const at = grown(moved)
    if (boxFits(region, at(1)))
      return { ...moved, scale: 1, maxGrow: maxFit(region, at, 1, maxGrow) }
  }

  // Else the spot with the most room, at each turn it may take.
  const xs = region.outline.map((p) => p[0])
  const ys = region.outline.map((p) => p[1])
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  const spanX = Math.max(...xs) - minX
  const spanY = Math.max(...ys) - minY
  const home = natural(1).c
  const angles = [place.rotation]
  for (const a of region.angles ?? [])
    if (!angles.some((b) => Math.abs(readableAngle(a - b)) < 1)) angles.push(a)

  interface Spot {
    c: Pt
    rot: number
    s: number
  }
  const sized = (c: Pt, rot: number) => (s: number) => ({
    c,
    hw: (w * s) / 2,
    hh: (h * s) / 2,
    rot,
  })
  // The roomiest spot at the turn being searched; and at the text's own
  // turn, the nearest spot to its 2D place that holds it whole.
  const st: { best: Spot | null; near: Spot | null; nearD: number } = {
    best: null,
    near: null,
    nearD: Infinity,
  }
  const consider = (c: Pt, rot: number, own: boolean) => {
    if (!pointInPolygon(c, region.outline)) return
    const at = sized(c, rot)
    const floor = st.best ? st.best.s : 0
    // Pruned: a spot that cannot beat the best and is no whole fit.
    const need = own ? Math.min(floor, 1) : floor
    if (need > 0 && !boxFits(region, at(need))) return
    if (need <= 0 && !boxFits(region, at(1e-3))) return
    const s = maxFit(region, at, Math.max(need, 1e-3), maxGrow)
    if (!st.best || s > st.best.s * 1.0001) st.best = { c, rot, s }
    if (own && s >= 1) {
      const d = Math.hypot(c[0] - home[0], c[1] - home[1])
      if (d < st.nearD) {
        st.nearD = d
        st.near = { c, rot, s }
      }
    }
  }
  const bests: Spot[] = []
  for (const rot of angles) {
    const own = !anywhere && rot === place.rotation
    st.best = null
    for (let i = 0; i < GRID; i++)
      for (let j = 0; j < GRID; j++)
        consider(
          [
            minX + ((i + 0.5) / GRID) * spanX,
            minY + ((j + 0.5) / GRID) * spanY,
          ],
          rot,
          own
        )
    // Narrow in round the best spot.
    let stepX = spanX / GRID
    let stepY = spanY / GRID
    for (let round = 0; round < 3; round++) {
      const top = st.best as Spot | null
      if (!top) break
      for (let i = -2; i <= 2; i++)
        for (let j = -2; j <= 2; j++)
          if (i || j)
            consider(
              [top.c[0] + (i * stepX) / 2, top.c[1] + (j * stepY) / 2],
              rot,
              own
            )
      stepX /= 2
      stepY /= 2
    }
    const found = st.best as Spot | null
    if (found) bests.push(found)
  }
  const pick = (c: Pt, rot: number, scale: number, grow: number) => ({
    at: c,
    pivot: [0.5, 0.5] as [number, number],
    rotation: rot,
    scale,
    maxGrow: grow,
  })
  const near = st.near
  if (near) return pick(near.c, near.rot, 1, near.s)
  // Whole at another turn, else the largest it gets.
  const whole = bests
    .filter((b) => b.s >= 1)
    .sort((a, b) => b.s - a.s)
    .at(0)
  if (whole) return pick(whole.c, whole.rot, 1, whole.s)
  const own = bests.find((b) => b.rot === place.rotation)
  let top = bests
    .slice()
    .sort((a, b) => b.s - a.s)
    .at(0)
  // Its own turn unless another is clearly roomier.
  if (own && top && top.s < own.s * 1.15) top = own
  if (!top || top.s < minScale) return null
  return pick(top.c, top.rot, top.s, 1)
}

/** How far (cells) a standing text's line - through `c`, along `rot` -
 * runs inside its room each way: back (-) and ahead (+). 0 both ways
 * when `c` itself is not clear. */
export function standingSpan(
  region: FitRegion,
  c: Pt,
  rot: number,
  reach = 1e4
): { back: number; ahead: number } {
  if (!boxFits(region, { c, hw: 1e-4, hh: 1e-3, rot }))
    return { back: 0, ahead: 0 }
  const r = (rot * Math.PI) / 180
  const u: Pt = [Math.cos(r), Math.sin(r)]
  // A segment from c, t along +-u, as a thin box round its middle.
  const run = (sign: number) =>
    maxFit(
      region,
      (t) => ({
        c: [c[0] + (sign * u[0] * t) / 2, c[1] + (sign * u[1] * t) / 2],
        hw: t / 2,
        hh: 1e-3,
        rot,
      }),
      0,
      reach
    )
  return { back: run(-1), ahead: run(1) }
}

/** Where a standing text of `halfWidth` sits on its line: slid along it
 * (`offset`, cells, from its flat middle) to lie inside the span, and the
 * half width it keeps - less where the span is shorter. */
export function standingPlace(
  span: { back: number; ahead: number },
  halfWidth: number
): { offset: number; half: number } {
  if (span.back + span.ahead >= 2 * halfWidth)
    return {
      offset: Math.min(
        Math.max(0, halfWidth - span.back),
        span.ahead - halfWidth
      ),
      half: halfWidth,
    }
  return {
    offset: (span.ahead - span.back) / 2,
    half: (span.ahead + span.back) / 2,
  }
}

/** A level's walls as legs to keep clear of (cells): each its half
 * thickness and `pad` out from its middle line. */
export function wallSegments(
  walls: readonly {
    points: [number, number][]
    thickness_mm?: number | null
  }[],
  cellMm: number,
  defaultThicknessMm: number,
  padMm: number
): FitSegment[] {
  const out: FitSegment[] = []
  for (const wl of walls) {
    const clear = ((wl.thickness_mm || defaultThicknessMm) / 2 + padMm) / cellMm
    for (let i = 1; i < wl.points.length; i++)
      out.push({ a: wl.points[i - 1], b: wl.points[i], clear })
  }
  return out
}

/** The legs near an outline: only these can touch a text inside it. */
export function segmentsNear(
  segs: readonly FitSegment[],
  outline: readonly Pt[]
): FitSegment[] {
  const xs = outline.map((p) => p[0])
  const ys = outline.map((p) => p[1])
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  return segs.filter(
    (s) =>
      Math.max(s.a[0], s.b[0]) + s.clear >= minX &&
      Math.min(s.a[0], s.b[0]) - s.clear <= maxX &&
      Math.max(s.a[1], s.b[1]) + s.clear >= minY &&
      Math.min(s.a[1], s.b[1]) - s.clear <= maxY
  )
}
