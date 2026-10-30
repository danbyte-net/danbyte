// Pure geometry for the Site map's building outlines - a ring of [lat, lng]
// points, never closed (the last point joins the first). Leaflet-free so the
// draw and reshape rules are testable; the server applies the same rules
// (api/site_map_outlines.py: 3 to 500 points, no self-crossing, an area).

export type Pt = [number, number]

export const MIN_POINTS = 3
export const MAX_POINTS = 500

function orient(p: Pt, q: Pt, r: Pt): number {
  const v = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
  return Math.abs(v) < 1e-18 ? 0 : v > 0 ? 1 : -1
}

function onSegment(p: Pt, q: Pt, r: Pt): boolean {
  return (
    Math.min(p[0], r[0]) <= q[0] &&
    q[0] <= Math.max(p[0], r[0]) &&
    Math.min(p[1], r[1]) <= q[1] &&
    q[1] <= Math.max(p[1], r[1])
  )
}

/** Whether segments ab and cd meet (touching and collinear overlap count). */
export function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o1 = orient(a, b, c)
  const o2 = orient(a, b, d)
  const o3 = orient(c, d, a)
  const o4 = orient(c, d, b)
  if (o1 !== o2 && o3 !== o4) return true
  return (
    (o1 === 0 && onSegment(a, c, b)) ||
    (o2 === 0 && onSegment(a, d, b)) ||
    (o3 === 0 && onSegment(c, a, d)) ||
    (o4 === 0 && onSegment(c, b, d))
  )
}

/** No two non-adjacent edges of the closed ring meet. */
export function isSimple(points: Pt[]): boolean {
  const n = points.length
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue
      if (
        segmentsCross(
          points[i],
          points[(i + 1) % n],
          points[j],
          points[(j + 1) % n]
        )
      )
        return false
    }
  }
  return true
}

/** Twice the signed area (shoelace), in degrees². */
function area2(points: Pt[]): number {
  let a = 0
  for (let i = 0; i < points.length; i++) {
    const [y1, x1] = points[i]
    const [y2, x2] = points[(i + 1) % points.length]
    a += x1 * y2 - x2 * y1
  }
  return a
}

/** Why `points` cannot be an outline, or null when it can. */
export function outlineProblem(points: Pt[]): string | null {
  if (points.length < MIN_POINTS) return "An outline needs at least 3 points."
  if (points.length > MAX_POINTS) return "An outline has at most 500 points."
  if (!isSimple(points)) return "The outline crosses itself."
  if (Math.abs(area2(points)) < 1e-12) return "The outline has no area."
  return null
}

/** Drop a point that repeats the one before it (the two clicks of the
 * double-click that finishes a drawing land on the same spot), and a last
 * point that repeats the first. `eps` is in degrees (~1e-6 ≈ 10 cm). */
export function dedupe(points: Pt[], eps = 1e-6): Pt[] {
  const same = (a: Pt, b: Pt) =>
    Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps
  const out: Pt[] = []
  for (const p of points)
    if (out.length === 0 || !same(out[out.length - 1], p)) out.push(p)
  while (out.length > 1 && same(out[0], out[out.length - 1])) out.pop()
  return out
}

/** The ring with point `i` moved to `to`. */
export function moveVertex(points: Pt[], i: number, to: Pt): Pt[] {
  return points.map((p, j) => (j === i ? to : p))
}

/** The ring with a new point at the middle of the edge from `i` to the next
 * point (the last edge closes the ring). */
export function insertVertex(points: Pt[], i: number): Pt[] {
  const a = points[i]
  const b = points[(i + 1) % points.length]
  const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
  return [...points.slice(0, i + 1), mid, ...points.slice(i + 1)]
}

/** The ring without point `i`; null when that would leave fewer than 3. */
export function removeVertex(points: Pt[], i: number): Pt[] | null {
  if (points.length <= MIN_POINTS) return null
  return points.filter((_, j) => j !== i)
}

/** Where the label sits: the area centroid, or the mean of the points for a
 * degenerate ring. */
export function centroid(points: Pt[]): Pt {
  const a = area2(points)
  if (Math.abs(a) < 1e-18) {
    const n = points.length || 1
    return [
      points.reduce((s, p) => s + p[0], 0) / n,
      points.reduce((s, p) => s + p[1], 0) / n,
    ]
  }
  let cy = 0
  let cx = 0
  for (let i = 0; i < points.length; i++) {
    const [y1, x1] = points[i]
    const [y2, x2] = points[(i + 1) % points.length]
    const f = x1 * y2 - x2 * y1
    cx += (x1 + x2) * f
    cy += (y1 + y2) * f
  }
  return [cy / (3 * a), cx / (3 * a)]
}

/** The midpoints of every edge, closing edge included - where the "+"
 * handles sit. */
export function edgeMidpoints(points: Pt[]): Pt[] {
  return points.map((a, i) => {
    const b = points[(i + 1) % points.length]
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] as Pt
  })
}

/** Squared distance in degrees - good enough to pick the nearest site. */
export function nearestIndex(target: Pt, candidates: Pt[]): number {
  let best = -1
  let bestD = Infinity
  candidates.forEach((c, i) => {
    const d = (c[0] - target[0]) ** 2 + (c[1] - target[1]) ** 2
    if (d < bestD) {
      bestD = d
      best = i
    }
  })
  return best
}
