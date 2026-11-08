// Raised floors as outlines, and touching raised floors as one region.
//
// A raised floor is a whole-cell rectangle, or - with `points` - a polygon in
// cell units (a hall turned on the plan). api/raised_floor_geometry.py is the
// server's twin: a point on an outline counts as on the floor.
//
// Drawing: neighbouring raised floors of the same plenum depth and colour are
// one construction - a pad built from strips must read as one pad, not as a
// stack of dashed boxes. `raisedRegions` merges them: the pieces to fill (in
// one path, so nothing is filled twice) and the outer boundary to stroke,
// with every seam between the parts left out. The 2D canvas, the PDF/SVG
// export and the 3D room all draw from it.

export type Pt = [number, number]

/** What an outline is read from: the editor's rows, the contents' rows. */
export interface RaisedLike {
  x: number
  y: number
  width: number
  height: number
  points?: readonly (readonly [number, number])[] | null
}

/** A raised floor's outline, its corners in order (cell units). */
export function raisedOutline(a: RaisedLike): Pt[] {
  if (a.points && a.points.length >= 3)
    return a.points.map((p) => [p[0], p[1]] as Pt)
  return rectOutline(a.x, a.y, a.width, a.height)
}

export function rectOutline(x: number, y: number, w: number, h: number): Pt[] {
  return [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ]
}

/** Whether the raised floor is a polygon (else a rectangle). */
export const isRaisedPolygon = (a: RaisedLike) => (a.points?.length ?? 0) >= 3

const EPS = 1e-6

function onSegment(p: Pt, a: Pt, b: Pt, eps = EPS): boolean {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len2 = dx * dx + dy * dy
  if (len2 < 1e-18) return Math.hypot(p[0] - a[0], p[1] - a[1]) <= eps
  const t = Math.max(
    0,
    Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)
  )
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy)) <= eps
}

/** Even-odd ray cast; a point on the outline may answer either way. */
export function strictlyInside(p: Pt, poly: readonly Pt[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > p[1] !== yj > p[1]) {
      const x = ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi
      if (p[0] < x) inside = !inside
    }
  }
  return inside
}

function onOutline(p: Pt, poly: readonly Pt[], eps = EPS): boolean {
  for (let i = 0; i < poly.length; i++)
    if (onSegment(p, poly[i], poly[(i + 1) % poly.length], eps)) return true
  return false
}

/** Whether `p` lies inside the outline or on it. */
export function outlineContains(
  poly: readonly Pt[],
  p: readonly [number, number],
  eps = EPS
): boolean {
  const q: Pt = [p[0], p[1]]
  return onOutline(q, poly, eps) || strictlyInside(q, poly)
}

/** Whether `p` stands on the raised floor (its outline included). */
export function raisedContains(
  a: RaisedLike,
  p: readonly [number, number]
): boolean {
  if (!isRaisedPolygon(a))
    return (
      a.x - EPS <= p[0] &&
      p[0] <= a.x + a.width + EPS &&
      a.y - EPS <= p[1] &&
      p[1] <= a.y + a.height + EPS
    )
  return outlineContains(raisedOutline(a), p)
}

/** Signed shoelace area. */
export function signedArea(poly: readonly Pt[]): number {
  let s = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    s += a[0] * b[1] - b[0] * a[1]
  }
  return s / 2
}

function orient(p: Pt, q: Pt, r: Pt): number {
  const v = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
  return Math.abs(v) < 1e-12 ? 0 : v > 0 ? 1 : -1
}

/** Segments cross at a point inside both (touching does not count). */
function properlyCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  return (
    orient(a, b, c) * orient(a, b, d) < 0 &&
    orient(c, d, a) * orient(c, d, b) < 0
  )
}

/** A point just inside the outline beside each edge's midpoint. */
function probes(poly: readonly Pt[]): Pt[] {
  const out: Pt[] = []
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (len < 1e-9) continue
    const mx = (a[0] + b[0]) / 2
    const my = (a[1] + b[1]) / 2
    const nx = (-(b[1] - a[1]) / len) * 1e-4
    const ny = ((b[0] - a[0]) / len) * 1e-4
    const q1: Pt = [mx + nx, my + ny]
    const q2: Pt = [mx - nx, my - ny]
    if (strictlyInside(q1, poly)) out.push(q1)
    else if (strictlyInside(q2, poly)) out.push(q2)
  }
  return out
}

interface BBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export function outlineBounds(poly: readonly Pt[]): BBox {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of poly) {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  return { minX, minY, maxX, maxY }
}

/** Whether two outlines share interior - sharing an edge or a corner is
 * fine (pads that abut). The server's `overlaps`. */
export function outlinesOverlap(a: readonly Pt[], b: readonly Pt[]): boolean {
  const ba = outlineBounds(a)
  const bb = outlineBounds(b)
  if (
    ba.maxX <= bb.minX + EPS ||
    bb.maxX <= ba.minX + EPS ||
    ba.maxY <= bb.minY + EPS ||
    bb.maxY <= ba.minY + EPS
  )
    return false
  for (let i = 0; i < a.length; i++)
    for (let j = 0; j < b.length; j++)
      if (
        properlyCross(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length])
      )
        return true
  for (const p of a) if (strictlyInside(p, b) && !onOutline(p, b)) return true
  for (const p of b) if (strictlyInside(p, a) && !onOutline(p, a)) return true
  return (
    probes(a).some((q) => strictlyInside(q, b)) ||
    probes(b).some((q) => strictlyInside(q, a))
  )
}

/** Whether two outlines touch or overlap (share any point). */
function outlinesTouch(a: readonly Pt[], b: readonly Pt[]): boolean {
  const ba = outlineBounds(a)
  const bb = outlineBounds(b)
  if (
    ba.maxX < bb.minX - EPS ||
    bb.maxX < ba.minX - EPS ||
    ba.maxY < bb.minY - EPS ||
    bb.maxY < ba.minY - EPS
  )
    return false
  for (const p of a) if (outlineContains(b, p)) return true
  for (const p of b) if (outlineContains(a, p)) return true
  for (let i = 0; i < a.length; i++)
    for (let j = 0; j < b.length; j++)
      if (
        properlyCross(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length])
      )
        return true
  return false
}

/** The union of whole-cell rectangles as disjoint rectangles (row runs over
 * the rectangles' own edges, stacked where a run repeats), so overlapping
 * legacy rows are still filled once. */
export function rectUnionPieces(
  rects: readonly { x: number; y: number; width: number; height: number }[]
): Pt[][] {
  if (!rects.length) return []
  const xs = [...new Set(rects.flatMap((r) => [r.x, r.x + r.width]))].sort(
    (a, b) => a - b
  )
  const ys = [...new Set(rects.flatMap((r) => [r.y, r.y + r.height]))].sort(
    (a, b) => a - b
  )
  const covered = (i: number, j: number) => {
    const cx = (xs[i] + xs[i + 1]) / 2
    const cy = (ys[j] + ys[j + 1]) / 2
    return rects.some(
      (r) => r.x < cx && cx < r.x + r.width && r.y < cy && cy < r.y + r.height
    )
  }
  // Runs of each band, as [x0, x1].
  const bands: [number, number][][] = []
  for (let j = 0; j < ys.length - 1; j++) {
    const runs: [number, number][] = []
    let start = -1
    for (let i = 0; i <= xs.length - 1; i++) {
      const on = i < xs.length - 1 && covered(i, j)
      if (on && start < 0) start = i
      if (!on && start >= 0) {
        runs.push([xs[start], xs[i]])
        start = -1
      }
    }
    bands.push(runs)
  }
  // A run the band below repeats exactly grows downward instead.
  const out: Pt[][] = []
  let open = new Map<string, { x0: number; x1: number; y0: number }>()
  for (let j = 0; j <= bands.length; j++) {
    const next = new Map<string, { x0: number; x1: number; y0: number }>()
    for (const [x0, x1] of bands[j] ?? []) {
      const key = `${x0}:${x1}`
      const was = open.get(key)
      next.set(key, was ?? { x0, x1, y0: ys[j] })
      open.delete(key)
    }
    for (const r of open.values())
      out.push(rectOutline(r.x0, r.y0, r.x1 - r.x0, ys[j] - r.y0))
    open = next
  }
  return out
}

/** One drawn raised-floor region: touching rows of one depth and colour. */
export interface RaisedRegion<T> {
  /** The rows it is made of; the first is the one it is named after. */
  rows: T[]
  color: string
  plenum_mm: number
  /** Disjoint pieces to fill, each counter-clockwise on screen axes. */
  pieces: Pt[][]
  /** The outer boundary only - the seams between the rows left out - as
   * polylines (a closed one repeats its first point at the end). */
  outline: Pt[][]
  bounds: BBox
}

/** The outer boundary of disjoint pieces: each edge cut where another
 * piece's corner or edge meets it, and a stretch kept only where the side
 * facing away from its own piece is outside every piece. */
export function outerBoundary(pieces: readonly Pt[][]): Pt[][] {
  const segs: [Pt, Pt][] = []
  const boxes = pieces.map(outlineBounds)
  pieces.forEach((poly, pi) => {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]
      const b = poly[(i + 1) % poly.length]
      const dx = b[0] - a[0]
      const dy = b[1] - a[1]
      const len = Math.hypot(dx, dy)
      if (len < 1e-9) continue
      const ts = [0, 1]
      const lo = { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]) }
      const hi = { x: Math.max(a[0], b[0]), y: Math.max(a[1], b[1]) }
      pieces.forEach((other, oi) => {
        if (oi === pi) return
        const bx = boxes[oi]
        if (
          bx.maxX < lo.x - EPS ||
          bx.minX > hi.x + EPS ||
          bx.maxY < lo.y - EPS ||
          bx.minY > hi.y + EPS
        )
          return
        for (let k = 0; k < other.length; k++) {
          const c = other[k]
          const d = other[(k + 1) % other.length]
          if (onSegment(c, a, b))
            ts.push(((c[0] - a[0]) * dx + (c[1] - a[1]) * dy) / (len * len))
          if (properlyCross(a, b, c, d)) {
            const ex = d[0] - c[0]
            const ey = d[1] - c[1]
            const den = dx * ey - dy * ex
            ts.push(((c[0] - a[0]) * ey - (c[1] - a[1]) * ex) / den)
          }
        }
      })
      ts.sort((p, q) => p - q)
      const nx = (-dy / len) * 1e-4
      const ny = (dx / len) * 1e-4
      for (let k = 0; k < ts.length - 1; k++) {
        const t0 = ts[k]
        const t1 = ts[k + 1]
        if ((t1 - t0) * len < 1e-6) continue
        const tm = (t0 + t1) / 2
        const m: Pt = [a[0] + dx * tm, a[1] + dy * tm]
        // Which side faces away from its own piece.
        const left: Pt = [m[0] + nx, m[1] + ny]
        const right: Pt = [m[0] - nx, m[1] - ny]
        const out = strictlyInside(left, poly) ? right : left
        if (pieces.some((p) => strictlyInside(out, p))) continue
        segs.push([
          [a[0] + dx * t0, a[1] + dy * t0],
          [a[0] + dx * t1, a[1] + dy * t1],
        ])
      }
    }
  })
  return chainSegments(segs)
}

const keyOf = (p: Pt) => `${Math.round(p[0] * 1e5)}:${Math.round(p[1] * 1e5)}`

/** Segments joined end to end into polylines; points along a straight line
 * dropped, so a dashed stroke runs on across them. */
function chainSegments(segs: [Pt, Pt][]): Pt[][] {
  const at = new Map<string, number[]>()
  segs.forEach(([a, b], i) => {
    for (const p of [a, b]) {
      const k = keyOf(p)
      const list = at.get(k)
      if (list) list.push(i)
      else at.set(k, [i])
    }
  })
  const used = new Array<boolean>(segs.length).fill(false)
  const lines: Pt[][] = []
  const extend = (line: Pt[]) => {
    for (;;) {
      const end = line[line.length - 1]
      const next = (at.get(keyOf(end)) ?? []).find((i) => !used[i])
      if (next === undefined) return
      used[next] = true
      const [a, b] = segs[next]
      line.push(keyOf(a) === keyOf(end) ? b : a)
    }
  }
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue
    used[i] = true
    const line: Pt[] = [segs[i][0], segs[i][1]]
    extend(line)
    line.reverse()
    extend(line)
    lines.push(straighten(line))
  }
  return lines
}

function straighten(line: Pt[]): Pt[] {
  const closed = line.length > 2 && keyOf(line[0]) === keyOf(line.at(-1)!)
  const out: Pt[] = []
  for (const p of line) {
    while (
      out.length >= 2 &&
      orient(out[out.length - 2], out[out.length - 1], p) === 0
    )
      out.pop()
    out.push(p)
  }
  if (
    closed &&
    out.length > 3 &&
    orient(out[out.length - 2], out[0], out[1]) === 0
  ) {
    // The start sits mid-edge: begin at the next corner instead.
    out.shift()
    out[out.length - 1] = out[0]
  }
  return out
}

const ccw = (poly: Pt[]) => (signedArea(poly) < 0 ? [...poly].reverse() : poly)

/**
 * The raised floors as drawn regions: rows of the same plenum depth and
 * colour that touch or overlap form one region, filled once and outlined
 * only on the outside. Rows keep their order; each region's rows are in the
 * order given.
 */
export function raisedRegions<
  T extends RaisedLike & { plenum_mm: number; color: string },
>(rows: readonly T[]): RaisedRegion<T>[] {
  const outlines = rows.map(raisedOutline)
  const parent = rows.map((_, i) => i)
  const find = (i: number): number =>
    parent[i] === i ? i : (parent[i] = find(parent[i]))
  for (let i = 0; i < rows.length; i++)
    for (let j = i + 1; j < rows.length; j++) {
      if (
        rows[i].plenum_mm !== rows[j].plenum_mm ||
        (rows[i].color || "") !== (rows[j].color || "")
      )
        continue
      if (find(i) === find(j)) continue
      if (outlinesTouch(outlines[i], outlines[j])) parent[find(j)] = find(i)
    }
  const groups = new Map<number, number[]>()
  rows.forEach((_, i) => {
    const r = find(i)
    const g = groups.get(r)
    if (g) g.push(i)
    else groups.set(r, [i])
  })
  return [...groups.values()].map((idx) => {
    const members = idx.map((i) => rows[i])
    const rects = members.filter((m) => !isRaisedPolygon(m))
    const pieces = [
      ...(rects.length === 1
        ? [raisedOutline(rects[0])]
        : rectUnionPieces(rects)),
      ...idx.filter((i) => isRaisedPolygon(rows[i])).map((i) => outlines[i]),
    ].map(ccw)
    const outline =
      pieces.length === 1
        ? [[...pieces[0], pieces[0][0]]]
        : outerBoundary(pieces)
    return {
      rows: members,
      color: members[0].color || "",
      plenum_mm: members[0].plenum_mm,
      pieces,
      outline,
      bounds: outlineBounds(pieces.flat()),
    }
  })
}

/** The SVG path of outlines (or polylines with `closed` false), scaled. */
export function outlinePath(
  polys: readonly (readonly Pt[])[],
  scale: number,
  closed = true
): string {
  const f = (v: number) => Math.round(v * scale * 100) / 100
  return polys
    .filter((p) => p.length >= 2)
    .map(
      (p) =>
        `M${p.map(([x, y]) => `${f(x)} ${f(y)}`).join("L")}${closed ? "Z" : ""}`
    )
    .join("")
}

/** Where a region's caption starts (cell units): a corner of its biggest
 * piece drawn a little toward the middle - the lowest-left one, where the
 * canvas has always put a raised floor's name. */
export function regionCaptionAnchor(pieces: readonly Pt[][]): Pt {
  let best = pieces[0]
  for (const p of pieces)
    if (Math.abs(signedArea(p)) > Math.abs(signedArea(best))) best = p
  const box = outlineBounds(best)
  // An upright rectangle: its own bottom-left corner.
  if (
    best.length === 4 &&
    best.every(
      ([x, y]) =>
        (Math.abs(x - box.minX) < EPS || Math.abs(x - box.maxX) < EPS) &&
        (Math.abs(y - box.minY) < EPS || Math.abs(y - box.maxY) < EPS)
    )
  )
    return [box.minX, box.maxY]
  const cx = best.reduce((s, p) => s + p[0], 0) / best.length
  const cy = best.reduce((s, p) => s + p[1], 0) / best.length
  let pick: Pt = best[0]
  for (const p of best) if (p[1] - p[0] > pick[1] - pick[0]) pick = p
  return [pick[0] + (cx - pick[0]) * 0.15, pick[1] + (cy - pick[1]) * 0.15]
}

/** A polygon moved by (dx, dy), its points to 0.001 cell. */
export function translateOutline(
  points: readonly (readonly [number, number])[],
  dx: number,
  dy: number
): [number, number][] {
  const r = (v: number) => Math.round(v * 1000) / 1000
  return points.map((p) => [r(p[0] + dx), r(p[1] + dy)])
}

/** The whole cells a polygon covers - the server's `cell_box`. */
export function cellBox(poly: readonly (readonly [number, number])[]): {
  x: number
  y: number
  width: number
  height: number
} {
  const b = outlineBounds(poly.map((p) => [p[0], p[1]] as Pt))
  const x = Math.floor(b.minX + 1e-9)
  const y = Math.floor(b.minY + 1e-9)
  return {
    x,
    y,
    width: Math.max(1, Math.ceil(b.maxX - 1e-9) - x),
    height: Math.max(1, Math.ceil(b.maxY - 1e-9) - y),
  }
}
