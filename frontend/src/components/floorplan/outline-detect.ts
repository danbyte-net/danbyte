import type { Pt } from "./shapes"

// Detect outline: one click on a building or a room in a plan's background
// picture proposes the polygon around it. Pure functions over RGBA pixels -
// the worker (outline.worker.ts) runs the expensive part, the region and
// its contour; the page simplifies and squares the contour as the sliders
// move, which is cheap.
//
//   colour: grow a region from the clicked pixel by colour distance (a map's
//           building fill up to its outline).
//   room:   a line drawing - dark pixels are walls; gaps up to a door's
//           width are bridged by a morphological close, then the white
//           space round the click is filled.
//
// Then the region's outer contour (marching squares over pixel corners),
// Ramer-Douglas-Peucker, and squaring: edges within a few degrees of the
// shape's main direction snap to it, and jogs shorter than a threshold go.

/** RGBA pixels, row by row (ImageData's layout). */
export interface Raster {
  width: number
  height: number
  data: Uint8ClampedArray
}

export type RasterMode = "colour" | "room"

export interface DetectOptions {
  mode: RasterMode
  /** colour: how far a pixel may be from the clicked colour, 0-100 (% of
   * the black-to-white distance). */
  tolerance: number
  /** room: pixels darker than this (0-255 luminance) are walls. */
  threshold: number
  /** room: gaps in the walls up to this many pixels wide are bridged. */
  gapPx: number
  /** The region may cover at most this share of the picture. */
  maxShare?: number
}

/** Why nothing was found: the click was on a wall (room mode), the region
 * ran over most of the picture, or it is a speck. */
export type DetectFailure = "wall" | "large" | "small" | "outside"

export type DetectResult =
  | { ok: true; contour: Pt[]; pixels: number }
  | { ok: false; reason: DetectFailure }

/** The black-to-white distance in RGB. */
const RGB_SPAN = Math.sqrt(3 * 255 * 255)
export const DEFAULT_MAX_SHARE = 0.5

/** The clicked colour: the 3 × 3 pixels round the seed, averaged, so one
 * odd pixel (JPEG noise, an anti-aliased edge) does not decide it. */
function seedColour(
  r: Raster,
  sx: number,
  sy: number
): [number, number, number] {
  let cr = 0
  let cg = 0
  let cb = 0
  let n = 0
  for (let y = sy - 1; y <= sy + 1; y++)
    for (let x = sx - 1; x <= sx + 1; x++) {
      if (x < 0 || y < 0 || x >= r.width || y >= r.height) continue
      const i = (y * r.width + x) * 4
      cr += r.data[i]
      cg += r.data[i + 1]
      cb += r.data[i + 2]
      n++
    }
  return [cr / n, cg / n, cb / n]
}

/** Flood fill (4-connected) from `seed` over the pixels `ok` allows. */
function flood(
  w: number,
  h: number,
  seed: number,
  ok: (i: number) => boolean
): { mask: Uint8Array; count: number } {
  const mask = new Uint8Array(w * h)
  const stack = new Int32Array(w * h)
  let sp = 0
  mask[seed] = 1
  stack[sp++] = seed
  let count = 1
  const last = w * (h - 1)
  while (sp) {
    const i = stack[--sp]
    const x = i % w
    for (let k = 0; k < 4; k++) {
      let j: number
      if (k === 0) {
        if (x === 0) continue
        j = i - 1
      } else if (k === 1) {
        if (x === w - 1) continue
        j = i + 1
      } else if (k === 2) {
        if (i < w) continue
        j = i - w
      } else {
        if (i >= last) continue
        j = i + w
      }
      if (!mask[j] && ok(j)) {
        mask[j] = 1
        stack[sp++] = j
        count++
      }
    }
  }
  return { mask, count }
}

/** The region of pixels within `tolerance` (0-100) of the clicked colour,
 * connected to the click. */
export function growByColour(
  r: Raster,
  seed: Pt,
  tolerance: number
): { mask: Uint8Array; count: number } {
  const [sx, sy] = seed
  const [cr, cg, cb] = seedColour(r, sx, sy)
  const lim = (Math.max(0, Math.min(100, tolerance)) / 100) * RGB_SPAN
  const lim2 = lim * lim
  const d = r.data
  return flood(r.width, r.height, sy * r.width + sx, (j) => {
    const k = j * 4
    const dr = d[k] - cr
    const dg = d[k + 1] - cg
    const db = d[k + 2] - cb
    return dr * dr + dg * dg + db * db <= lim2
  })
}

/** Pixels darker than `threshold` (0-255 luminance): the drawing's walls. */
export function wallMask(r: Raster, threshold: number): Uint8Array {
  const out = new Uint8Array(r.width * r.height)
  const d = r.data
  for (let i = 0, k = 0; i < out.length; i++, k += 4) {
    // Transparent pixels are paper.
    const a = d[k + 3] / 255
    const lum =
      (0.299 * d[k] + 0.587 * d[k + 1] + 0.114 * d[k + 2]) * a + 255 * (1 - a)
    if (lum < threshold) out[i] = 1
  }
  return out
}

/** Distance from each pixel to the nearest set pixel of `mask`, in
 * pixels, by a two-pass chamfer: weights 1 and 1 give the chessboard
 * distance (a square's reach), 3 and 4 nearly the straight one. Infinity
 * when the mask is empty. */
export function chamfer(
  mask: Uint8Array,
  w: number,
  h: number,
  straight = 1,
  diagonal = 1
): Float32Array {
  const a = straight
  const b = diagonal
  const d = new Float32Array(w * h)
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? 0 : Infinity
  // Forward pass: from the top left.
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      let v = d[i]
      if (v === 0) continue
      if (x > 0) v = Math.min(v, d[i - 1] + a)
      if (y > 0) {
        v = Math.min(v, d[i - w] + a)
        if (x > 0) v = Math.min(v, d[i - w - 1] + b)
        if (x < w - 1) v = Math.min(v, d[i - w + 1] + b)
      }
      d[i] = v
    }
  // Backward pass: from the bottom right.
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x
      let v = d[i]
      if (v === 0) continue
      if (x < w - 1) v = Math.min(v, d[i + 1] + a)
      if (y < h - 1) {
        v = Math.min(v, d[i + w] + a)
        if (x < w - 1) v = Math.min(v, d[i + w + 1] + b)
        if (x > 0) v = Math.min(v, d[i + w - 1] + b)
      }
      d[i] = v
    }
  if (a !== 1) for (let i = 0; i < d.length; i++) d[i] /= a
  return d
}

/** The nearest pixel `want` allows, walking from the seed over pixels
 * `pass` allows, at most `reach` steps; null when there is none. */
function nearestReachable(
  w: number,
  h: number,
  seed: number,
  reach: number,
  pass: (i: number) => boolean,
  want: (i: number) => boolean
): number | null {
  const seen = new Set<number>([seed])
  let ring = [seed]
  for (let step = 0; step <= reach && ring.length; step++) {
    const next: number[] = []
    for (const i of ring) {
      if (want(i)) return i
      const x = i % w
      const near = [
        x > 0 ? i - 1 : -1,
        x < w - 1 ? i + 1 : -1,
        i >= w ? i - w : -1,
        i < w * (h - 1) ? i + w : -1,
      ]
      for (const j of near)
        if (j >= 0 && !seen.has(j) && pass(j)) {
          seen.add(j)
          next.push(j)
        }
    }
    ring = next
  }
  return null
}

/**
 * The white space round the click in a line drawing, its doors bridged:
 * a morphological opening of the free space with a square of `gapPx`
 * across. The free space shrunk by half the gap (every pixel at least that
 * far from a wall) splits at each doorway narrower than the gap; the part
 * round the click, grown back by as much without crossing a wall, is the
 * room. A square, unlike a disc, keeps a room's corners sharp and leaves
 * no bulge in the doorway. A room narrower than the gap is filled with a
 * smaller square, as large as the click allows.
 */
export function fillRoom(
  r: Raster,
  seed: Pt,
  threshold: number,
  gapPx: number
): { mask: Uint8Array; count: number } | null {
  const { width: w, height: h } = r
  const walls = wallMask(r, threshold)
  const s = seed[1] * w + seed[0]
  if (walls[s]) return null
  const toWall = chamfer(walls, w, h)
  let rad = Math.max(0, Math.floor(gapPx / 2))
  let start = nearestReachable(
    w,
    h,
    s,
    rad + 1,
    (i) => !walls[i],
    (i) => toWall[i] > rad
  )
  if (start == null) {
    rad = Math.max(0, Math.floor(toWall[s]) - 1)
    start = s
  }
  const core = flood(w, h, start, (i) => toWall[i] > rad)
  if (rad === 0) return core
  const toCore = chamfer(core.mask, w, h)
  return flood(w, h, start, (i) => !walls[i] && toCore[i] <= rad)
}

/**
 * The outer boundary of the region in `mask`, along pixel edges: the
 * corners where it turns, in pixel coordinates (a pixel (x, y) spans x..x+1).
 * Marching squares from the region's top-left pixel, which is always on the
 * outer boundary; holes are left out. Diagonal neighbours are not joined
 * (the region is 4-connected).
 */
export function traceOuter(mask: Uint8Array, w: number, h: number): Pt[] {
  let start = -1
  for (let i = 0; i < mask.length; i++)
    if (mask[i]) {
      start = i
      break
    }
  if (start < 0) return []
  const sx = start % w
  const sy = (start - sx) / w
  const at = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] ? 1 : 0
  const out: Pt[] = []
  let x = sx
  let y = sy
  let pdx = 0
  let pdy = 0
  let guard = 4 * (w + 1) * (h + 1)
  do {
    const s =
      at(x - 1, y - 1) |
      (at(x, y - 1) << 1) |
      (at(x - 1, y) << 2) |
      (at(x, y) << 3)
    let dx = 0
    let dy = 0
    switch (s) {
      case 1:
      case 5:
      case 13:
        dy = -1
        break
      case 2:
      case 3:
      case 7:
        dx = 1
        break
      case 4:
      case 12:
      case 14:
        dx = -1
        break
      case 8:
      case 10:
      case 11:
        dy = 1
        break
      case 6:
        if (pdx === 0 && pdy === -1) dx = -1
        else dx = 1
        break
      case 9:
        if (pdx === 1 && pdy === 0) dy = -1
        else dy = 1
        break
      default:
        return out
    }
    if (dx !== pdx || dy !== pdy) out.push([x, y])
    x += dx
    y += dy
    pdx = dx
    pdy = dy
  } while ((x !== sx || y !== sy) && --guard > 0)
  return out
}

/**
 * The region opened by a square `rad` pixels each way: the teeth a colour
 * region grows into an anti-aliased outline (a pixel or two wide) go, the
 * body stays. The part round the seed; the region as it was when opening
 * leaves nothing there.
 */
export function openRegion(
  mask: Uint8Array,
  w: number,
  h: number,
  seed: number,
  rad: number
): { mask: Uint8Array; count: number } {
  const count = () => mask.reduce((n, v) => n + v, 0)
  if (rad <= 0) return { mask, count: count() }
  const outside = new Uint8Array(mask.length)
  for (let i = 0; i < mask.length; i++) outside[i] = mask[i] ? 0 : 1
  const toOut = chamfer(outside, w, h)
  const core = new Uint8Array(mask.length)
  // The picture's edge does not erode: a building cut by it stays whole.
  for (let i = 0; i < mask.length; i++) core[i] = toOut[i] > rad ? 1 : 0
  const toCore = chamfer(core, w, h)
  const start = nearestReachable(
    w,
    h,
    seed,
    rad + 1,
    (i) => !!mask[i],
    (i) => !!core[i]
  )
  if (start == null) return { mask, count: count() }
  return flood(w, h, start, (i) => !!mask[i] && toCore[i] <= rad)
}

/** Find the region round `seed` (a pixel) and its outer contour. */
export function detectRegion(
  r: Raster,
  seed: Pt,
  opts: DetectOptions
): DetectResult {
  const sx = Math.floor(seed[0])
  const sy = Math.floor(seed[1])
  if (sx < 0 || sy < 0 || sx >= r.width || sy >= r.height)
    return { ok: false, reason: "outside" }
  let grown =
    opts.mode === "room"
      ? fillRoom(r, [sx, sy], opts.threshold, opts.gapPx)
      : growByColour(r, [sx, sy], opts.tolerance)
  if (!grown) return { ok: false, reason: "wall" }
  const total = r.width * r.height
  if (grown.count > (opts.maxShare ?? DEFAULT_MAX_SHARE) * total)
    return { ok: false, reason: "large" }
  if (opts.mode === "colour")
    grown = openRegion(grown.mask, r.width, r.height, sy * r.width + sx, 1)
  if (grown.count < 4) return { ok: false, reason: "small" }
  const contour = traceOuter(grown.mask, r.width, r.height)
  if (contour.length < 3) return { ok: false, reason: "small" }
  return { ok: true, contour, pixels: grown.count }
}

// ── Shaping the contour ────────────────────────────────────────────────────

/** Twice the signed area (shoelace). */
function area2(pts: readonly Pt[]): number {
  let s = 0
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i]
    const [x2, y2] = pts[(i + 1) % pts.length]
    s += x1 * y2 - x2 * y1
  }
  return s
}

/** The polygon's area (always positive). */
export function polygonArea(pts: readonly Pt[]): number {
  return Math.abs(area2(pts)) / 2
}

function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len2 = dx * dx + dy * dy
  if (!len2) return Math.hypot(p[0] - a[0], p[1] - a[1])
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)
}

function rdpOpen(pts: readonly Pt[], eps: number): Pt[] {
  if (pts.length < 3) return [...pts]
  // Iterative, so a long contour never runs out of stack.
  const keep = new Uint8Array(pts.length)
  keep[0] = keep[pts.length - 1] = 1
  const todo: [number, number][] = [[0, pts.length - 1]]
  while (todo.length) {
    const [a, b] = todo.pop()!
    let best = -1
    let far = eps
    for (let i = a + 1; i < b; i++) {
      const d = segDist(pts[i], pts[a], pts[b])
      if (d > far) {
        far = d
        best = i
      }
    }
    if (best >= 0) {
      keep[best] = 1
      todo.push([a, best], [best, b])
    }
  }
  return pts.filter((_, i) => keep[i])
}

/** Ramer-Douglas-Peucker on a closed outline: split at the point farthest
 * from the first, simplify both halves. */
export function simplifyClosed(pts: readonly Pt[], eps: number): Pt[] {
  if (pts.length <= 3 || eps <= 0) return [...pts]
  let far = 0
  let at = 0
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1])
    if (d > far) {
      far = d
      at = i
    }
  }
  const a = rdpOpen(pts.slice(0, at + 1), eps)
  const b = rdpOpen([...pts.slice(at), pts[0]], eps)
  const out = [...a.slice(0, -1), ...b.slice(0, -1)]
  return out.length >= 3 ? out : [...pts]
}

/** Points that do not turn (on the line between their neighbours) go. */
export function dropCollinear(pts: readonly Pt[], tol = 1e-9): Pt[] {
  let cur = [...pts]
  for (let pass = 0; pass < 2; pass++) {
    const out: Pt[] = []
    for (let i = 0; i < cur.length; i++) {
      const a = cur[(i - 1 + cur.length) % cur.length]
      const p = cur[i]
      const b = cur[(i + 1) % cur.length]
      const cross =
        (p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0])
      const same = p[0] === a[0] && p[1] === a[1]
      if (!same && Math.abs(cross) > tol) out.push(p)
    }
    if (out.length < 3) return cur
    cur = out
  }
  return cur
}

/** An edge as a line: a unit direction through a point, its length, and
 * whether it was snapped to the main direction. */
interface Line {
  ux: number
  uy: number
  px: number
  py: number
  len: number
  /** The quarter-turn it was snapped to, or null. */
  snap: number | null
}

function intersect(a: Line, b: Line): Pt | null {
  const cross = a.ux * b.uy - a.uy * b.ux
  if (Math.abs(cross) < 1e-9) return null
  const t = ((b.px - a.px) * b.uy - (b.py - a.py) * b.ux) / cross
  return [a.px + t * a.ux, a.py + t * a.uy]
}

const parallelSnaps = (a: Line, b: Line) =>
  a.snap !== null && b.snap !== null && (a.snap - b.snap) % 2 === 0

function mergeLines(a: Line, b: Line): Line {
  const len = a.len + b.len || 1
  return {
    ux: a.ux,
    uy: a.uy,
    px: (a.px * a.len + b.px * b.len) / len,
    py: (a.py * a.len + b.py * b.len) / len,
    len: a.len + b.len,
    snap: a.snap,
  }
}

function vertices(lines: Line[]): Pt[] {
  const n = lines.length
  return lines.map((l, i) => {
    const prev = lines[(i - 1 + n) % n]
    return intersect(prev, l) ?? [(prev.px + l.px) / 2, (prev.py + l.py) / 2]
  })
}

/** The main direction of an outline (radians, in [-45°, 45°)): the
 * length-weighted mean of its edges' directions modulo a quarter turn. */
export function mainDirection(pts: readonly Pt[]): number {
  let sx = 0
  let sy = 0
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i]
    const [x2, y2] = pts[(i + 1) % pts.length]
    const len = Math.hypot(x2 - x1, y2 - y1)
    const a = Math.atan2(y2 - y1, x2 - x1)
    sx += len * Math.cos(4 * a)
    sy += len * Math.sin(4 * a)
  }
  return Math.atan2(sy, sx) / 4
}

/**
 * Square an outline's corners: an edge within `tolDeg` of the main
 * direction (or a quarter turn from it) is turned onto it about its middle;
 * neighbouring edges that end up in line become one; an edge shorter than
 * `jog` goes, its neighbours meeting directly (in line: merged). The corners
 * are where the edges' lines meet. Edges far from the main direction keep
 * theirs. Null when the result would cross itself.
 */
export function squareCorners(
  pts: readonly Pt[],
  {
    tolDeg = 8,
    jog = 0,
    fit,
  }: {
    tolDeg?: number
    jog?: number
    /** The contour the outline was simplified from: each edge is moved
     * (keeping its direction) to the length-weighted middle of the contour
     * runs nearest it, so a staircase ends up through its middle rather
     * than on its corners. */
    fit?: readonly Pt[]
  } = {}
): Pt[] | null {
  if (pts.length < 3) return null
  const theta = mainDirection(pts)
  const tol = (tolDeg * Math.PI) / 180
  const quarter = Math.PI / 2
  let lines: Line[] = []
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i]
    const [x2, y2] = pts[(i + 1) % pts.length]
    const len = Math.hypot(x2 - x1, y2 - y1)
    if (!len) continue
    const a = Math.atan2(y2 - y1, x2 - x1)
    const k = Math.round((a - theta) / quarter)
    const target = theta + k * quarter
    const snapped = Math.abs(a - target) <= tol
    const dir = snapped ? target : a
    lines.push({
      ux: Math.cos(dir),
      uy: Math.sin(dir),
      px: (x1 + x2) / 2,
      py: (y1 + y2) / 2,
      len,
      snap: snapped ? ((k % 4) + 4) % 4 : null,
    })
  }
  // Neighbours in line become one.
  const mergeRuns = (ls: Line[]): Line[] => {
    let out = [...ls]
    let changed = true
    while (changed && out.length > 3) {
      changed = false
      for (let i = 0; i < out.length && out.length > 3; i++) {
        const j = (i + 1) % out.length
        if (parallelSnaps(out[i], out[j])) {
          const m = mergeLines(out[i], out[j])
          if (j === 0) out = [m, ...out.slice(1, i)]
          else out.splice(i, 2, m)
          changed = true
          break
        }
      }
    }
    return out
  }
  lines = mergeRuns(lines)
  // Tiny jogs go, shortest first.
  for (let guard = lines.length; guard > 0 && lines.length > 3; guard--) {
    const vs = vertices(lines)
    let worst = -1
    let short = jog
    for (let i = 0; i < lines.length; i++) {
      const a = vs[i]
      const b = vs[(i + 1) % vs.length]
      const dx = b[0] - a[0]
      const dy = b[1] - a[1]
      // An edge whose corners crossed over runs backwards: no length.
      const along = dx * lines[i].ux + dy * lines[i].uy
      const len = along <= 0 ? 0 : Math.hypot(dx, dy)
      if (len < short) {
        short = len
        worst = i
      }
    }
    if (worst < 0) break
    lines.splice(worst, 1)
    lines = mergeRuns(lines)
  }
  if (lines.length < 3) return null
  if (fit && fit.length >= 3) lines = refit(lines, fit)
  const out = dropCollinear(vertices(lines), 1e-6)
  if (out.length < 3 || crossesItself(out)) return null
  return out
}

/**
 * Fit each line to the contour it stands for: the contour's runs go to the
 * edge nearest their middles, and each line is laid through their
 * length-weighted centroid along their principal direction. Squared lines
 * then share one main direction again (the fitted ones', averaged), so a
 * staircase's edge ends up through its middle at its true angle rather
 * than on the corners simplification kept.
 */
function refit(lines: Line[], contour: readonly Pt[]): Line[] {
  const vs = vertices(lines)
  const n = lines.length
  const w = new Float64Array(n)
  const sx = new Float64Array(n)
  const sy = new Float64Array(n)
  const sxx = new Float64Array(n)
  const syy = new Float64Array(n)
  const sxy = new Float64Array(n)
  for (let k = 0; k < contour.length; k++) {
    const a = contour[k]
    const b = contour[(k + 1) % contour.length]
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (!len) continue
    const mx = (a[0] + b[0]) / 2
    const my = (a[1] + b[1]) / 2
    let best = -1
    let near = Infinity
    for (let i = 0; i < n; i++) {
      const d = segDist([mx, my], vs[i], vs[(i + 1) % n])
      if (d < near) {
        near = d
        best = i
      }
    }
    w[best] += len
    sx[best] += len * mx
    sy[best] += len * my
    sxx[best] += len * mx * mx
    syy[best] += len * my * my
    sxy[best] += len * mx * my
  }
  /** The fitted direction of line i (radians), when it has enough to go on. */
  const fitted = lines.map((l, i) => {
    if (w[i] < 4) return null
    const cx = sx[i] / w[i]
    const cy = sy[i] / w[i]
    const vxx = sxx[i] / w[i] - cx * cx
    const vyy = syy[i] / w[i] - cy * cy
    const vxy = sxy[i] / w[i] - cx * cy
    let a = 0.5 * Math.atan2(2 * vxy, vxx - vyy)
    // Keep the edge's own way round.
    if (Math.cos(a) * l.ux + Math.sin(a) * l.uy < 0) a += Math.PI
    return a
  })
  let ax = 0
  let ay = 0
  lines.forEach((l, i) => {
    const a = fitted[i]
    if (l.snap === null || a === null) return
    ax += w[i] * Math.cos(4 * a)
    ay += w[i] * Math.sin(4 * a)
  })
  const theta = ax || ay ? Math.atan2(ay, ax) / 4 : null
  const quarter = Math.PI / 2
  return lines.map((l, i) => {
    if (!w[i]) return l
    const cx = sx[i] / w[i]
    const cy = sy[i] / w[i]
    let dir = Math.atan2(l.uy, l.ux)
    if (l.snap !== null && theta !== null)
      dir = theta + Math.round((dir - theta) / quarter) * quarter
    else if (l.snap === null && fitted[i] !== null) dir = fitted[i]!
    return { ...l, ux: Math.cos(dir), uy: Math.sin(dir), px: cx, py: cy }
  })
}

function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o = (p: Pt, q: Pt, r: Pt) =>
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
  const d1 = o(c, d, a)
  const d2 = o(c, d, b)
  const d3 = o(a, b, c)
  const d4 = o(a, b, d)
  return d1 * d2 < 0 && d3 * d4 < 0
}

/** Two edges that are not neighbours cross. */
export function crossesItself(pts: readonly Pt[]): boolean {
  const n = pts.length
  for (let i = 0; i < n; i++)
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue
      if (segmentsCross(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n]))
        return true
    }
  return false
}

export interface ShapeOptions {
  /** Ramer-Douglas-Peucker tolerance, in the contour's units. */
  epsilon: number
  /** Square near-right corners and drop tiny jogs. */
  square: boolean
  /** Edges shorter than this go when squaring (contour units). */
  jog?: number
  /** Degrees an edge may be off the main direction and still snap. */
  tolDeg?: number
  /** At most this many corners: the tolerance grows until it fits. */
  maxPoints?: number
}

/** The contour as an area outline: simplified, squared when asked, never
 * more than `maxPoints` corners. */
export function shapeOutline(contour: readonly Pt[], o: ShapeOptions): Pt[] {
  const max = o.maxPoints ?? 200
  let eps = Math.max(o.epsilon, 1e-6)
  let out: Pt[] = []
  for (let tries = 0; tries < 24; tries++) {
    const simple = dropCollinear(simplifyClosed(dropCollinear(contour), eps))
    out = simple
    if (o.square) {
      const sq = squareCorners(simple, {
        tolDeg: o.tolDeg ?? 8,
        jog: o.jog ?? eps * 2,
        fit: contour,
      })
      if (sq) out = sq
    }
    if (out.length <= max) return out
    eps *= 1.5
  }
  return out.slice(0, max)
}

// ── Pixels and cells ───────────────────────────────────────────────────────

/** Where the picture spans on the plan, in cells. */
export interface Frame {
  x: number
  y: number
  width: number
  height: number
}

/** Picture pixels → plan cells: the picture is stretched over `frame`. */
export function pixelsToCells(
  pts: readonly Pt[],
  size: { width: number; height: number },
  frame: Frame
): Pt[] {
  const kx = frame.width / size.width
  const ky = frame.height / size.height
  return pts.map(([x, y]) => [frame.x + x * kx, frame.y + y * ky])
}

/** Plan cells → picture pixels (the click). */
export function cellsToPixels(
  p: Pt,
  size: { width: number; height: number },
  frame: Frame
): Pt {
  return [
    ((p[0] - frame.x) * size.width) / frame.width,
    ((p[1] - frame.y) * size.height) / frame.height,
  ]
}

/** Pixels per cell, the mean of both axes. */
export function pxPerCell(
  size: { width: number; height: number },
  frame: Frame
): number {
  return (size.width / frame.width + size.height / frame.height) / 2
}

/** Points kept inside the grid. */
export function clampToGrid(pts: readonly Pt[], w: number, h: number): Pt[] {
  return pts.map(([x, y]) => [
    Math.max(0, Math.min(w, x)),
    Math.max(0, Math.min(h, y)),
  ])
}
