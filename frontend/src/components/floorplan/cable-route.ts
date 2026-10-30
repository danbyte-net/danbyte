// Routing a cable's trace along a network of trays.
//
// Trays are polylines on the floor-plan's half-cell lattice. A cable assigned
// to some trays should be traced *through* them: enter at the nearest tray
// point to device A, follow tray segments (across shared/branching junctions),
// exit nearest device B, and straight-line only the un-trayed ends. When a
// cable has no trays, or the trays don't connect its ends, it falls back to a
// straight A→B line.
//
// Trays at different heights stay apart: where two runs cross mid-segment
// they join only within LEVEL_JOIN_MM of each other, so an overhead ladder
// over an underfloor basket is no junction. A vertex snapped onto another
// tray (a drop) always joins. The server's api/pathfinding.py is the twin;
// cable-route.cases.json holds the cases both must agree on.
//
// All coordinates are in cell units (the same units tray.points use).

export type Pt = [number, number]

/** Crossing runs this close in elevation (mm) join; pathfinding.py's
 * LEVEL_JOIN_MM. */
export const LEVEL_JOIN_MM = 300
/** Overhead trays hang this far below the ceiling when no elevation is set. */
const OVERHEAD_DROP_MM = 300
/** Plenum depth under a raised floor when no area records one (mm). */
const DEFAULT_PLENUM_MM = 300

/** A raised-floor rect for {@link trayElevationMm}: cell units + plenum. */
export interface PlenumRect {
  x: number
  y: number
  width: number
  height: number
  plenum_mm: number
}

/** A tray's resolved elevation (mm) - its own `elevation_mm`, else from its
 * level: overhead → ceiling − 300, underfloor → −(deepest raised floor under
 * it, else 300), floor → 0. pathfinding.py's tray_elevation_mm +
 * underfloor_plenum_mm. */
export function trayElevationMm(
  tray: {
    level: string
    elevation_mm: number | null
    points: [number, number][]
  },
  ceilingMm: number,
  areas: PlenumRect[] = []
): number {
  if (tray.elevation_mm != null) return tray.elevation_mm
  if (tray.level === "underfloor") {
    let best = 0
    for (const [px, py] of tray.points)
      for (const a of areas)
        if (
          a.x <= px &&
          px <= a.x + a.width &&
          a.y <= py &&
          py <= a.y + a.height &&
          a.plenum_mm > best
        )
          best = a.plenum_mm
    return -(best || DEFAULT_PLENUM_MM)
  }
  if (tray.level === "floor") return 0
  return ceilingMm - OVERHEAD_DROP_MM
}

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1])

/** Nearest point on segment [s,e] to p, plus its distance. */
function projectSegment(p: Pt, s: Pt, e: Pt): { pt: Pt; t: number; d: number } {
  const dx = e[0] - s[0]
  const dy = e[1] - s[1]
  const len2 = dx * dx + dy * dy || 1e-9
  let t = ((p[0] - s[0]) * dx + (p[1] - s[1]) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  const pt: Pt = [s[0] + t * dx, s[1] + t * dy]
  return { pt, t, d: dist(p, pt) }
}

/** Intersection of segments [a,b] and [c,d], or null if they don't cross. */
function segmentIntersect(
  a: Pt,
  b: Pt,
  c: Pt,
  d: Pt
): { p: Pt; t: number; u: number } | null {
  const rx = b[0] - a[0]
  const ry = b[1] - a[1]
  const sx = d[0] - c[0]
  const sy = d[1] - c[1]
  const denom = rx * sy - ry * sx
  if (Math.abs(denom) < 1e-9) return null // parallel / collinear
  const t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / denom
  const u = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / denom
  if (t < -1e-6 || t > 1 + 1e-6 || u < -1e-6 || u > 1 + 1e-6) return null
  return { p: [a[0] + t * rx, a[1] + t * ry], t, u }
}

/** Nearest point on a polyline to p, with the segment index + local t. */
function projectPolyline(
  p: Pt,
  poly: Pt[]
): { pt: Pt; d: number; seg: number; t: number } {
  let best = { pt: poly[0], d: Infinity, seg: 0, t: 0 }
  for (let i = 0; i < poly.length - 1; i++) {
    const r = projectSegment(p, poly[i], poly[i + 1])
    if (r.d < best.d) best = { pt: r.pt, d: r.d, seg: i, t: r.t }
  }
  return best
}

/**
 * Route A→B through the given trays. Returns an ordered list of points; a
 * straight `[a, b]` when there are no usable trays or B is unreachable.
 * `elevations` (mm, one per tray; see {@link trayElevationMm}) keeps trays at
 * different heights from joining where they cross; null for a tray, or no
 * list, joins it at every crossing.
 */
export function routeCable(
  a: Pt,
  b: Pt,
  trayPolys: Pt[][],
  snap = 0.75,
  elevations?: (number | null)[]
): Pt[] {
  const keep = trayPolys.flatMap((t, i) => (t.length >= 2 ? [i] : []))
  const trays = keep.map((i) => trayPolys[i])
  if (trays.length === 0) return [a, b]
  // A node's level: trays at one elevation share nodes, others never do.
  const level = keep.map((i) => (elevations ? (elevations[i] ?? null) : 0))
  const joins = (ti: number, tj: number) => {
    const li = level[ti]
    const lj = level[tj]
    return li === null || lj === null || Math.abs(li - lj) <= LEVEL_JOIN_MM
  }

  // ── Node registry (spatial merge so coincident points of one level share
  // a node; `undefined` matches any level - the cable's own ends) ──────────
  const nodes: Pt[] = []
  const nodeLevel: (number | null | undefined)[] = []
  const mergeDist = snap * 0.5
  function nodeAt(p: Pt, lv?: number | null): number {
    for (let i = 0; i < nodes.length; i++)
      if (
        (lv === undefined || nodeLevel[i] === lv) &&
        dist(nodes[i], p) <= mergeDist
      )
        return i
    nodes.push(p)
    nodeLevel.push(lv)
    return nodes.length - 1
  }
  const adj = new Map<number, Map<number, number>>()
  function edge(u: number, v: number, w: number) {
    if (u === v) return
    for (const [x, y] of [
      [u, v],
      [v, u],
    ] as const) {
      let m = adj.get(x)
      if (!m) {
        m = new Map()
        adj.set(x, m)
      }
      const cur = m.get(y)
      if (cur === undefined || w < cur) m.set(y, w)
    }
  }

  // Arc-length position of each vertex, per tray.
  const arcs = trays.map((poly) => {
    const arc = [0]
    for (let i = 1; i < poly.length; i++)
      arc.push(arc[i - 1] + dist(poly[i - 1], poly[i]))
    return arc
  })
  const posOnTray = (ti: number, seg: number, t: number) =>
    arcs[ti][seg] + t * dist(trays[ti][seg], trays[ti][seg + 1])

  // Breakpoints per tray: start with vertices.
  const breakpoints: { pos: number; p: Pt }[][] = trays.map((poly, ti) =>
    poly.map((p, i) => ({ pos: arcs[ti][i], p }))
  )

  // Cross-tray vertex projections → junctions and T-splits. If a vertex of one
  // tray lands on (near) another tray, add it as a breakpoint there and link.
  for (let ti = 0; ti < trays.length; ti++) {
    for (const v of trays[ti]) {
      for (let tj = 0; tj < trays.length; tj++) {
        if (tj === ti) continue
        const pr = projectPolyline(v, trays[tj])
        if (pr.d <= snap) {
          breakpoints[tj].push({ pos: posOnTray(tj, pr.seg, pr.t), p: pr.pt })
          edge(nodeAt(v, level[ti]), nodeAt(pr.pt, level[tj]), pr.d)
        }
      }
    }
  }

  // Segment crossings → junctions where two trays actually intersect mid-run
  // (neither has a vertex there). Split both trays at the crossing so a cable
  // can turn from one onto the other - only at one level: a run passing over
  // or under another is not a junction.
  for (let ti = 0; ti < trays.length; ti++) {
    for (let tj = ti + 1; tj < trays.length; tj++) {
      if (!joins(ti, tj)) continue
      for (let si = 0; si < trays[ti].length - 1; si++) {
        for (let sj = 0; sj < trays[tj].length - 1; sj++) {
          const x = segmentIntersect(
            trays[ti][si],
            trays[ti][si + 1],
            trays[tj][sj],
            trays[tj][sj + 1]
          )
          if (!x) continue
          breakpoints[ti].push({ pos: posOnTray(ti, si, x.t), p: x.p })
          breakpoints[tj].push({ pos: posOnTray(tj, sj, x.u), p: x.p })
          // Close enough to join, but not one level: link them.
          if (level[ti] !== level[tj])
            edge(nodeAt(x.p, level[ti]), nodeAt(x.p, level[tj]), 0)
        }
      }
    }
  }

  // Entry/exit: project A and B onto their nearest tray (unbounded) so the
  // trace always enters the network at the closest tray point.
  function entryPoint(p: Pt): { pt: Pt; ti: number } {
    let best = { d: Infinity, pt: p, ti: 0, seg: 0, t: 0 }
    trays.forEach((poly, ti) => {
      const pr = projectPolyline(p, poly)
      if (pr.d < best.d) best = { d: pr.d, pt: pr.pt, ti, seg: pr.seg, t: pr.t }
    })
    breakpoints[best.ti].push({
      pos: posOnTray(best.ti, best.seg, best.t),
      p: best.pt,
    })
    return { pt: best.pt, ti: best.ti }
  }
  const entryA = entryPoint(a)
  const entryB = entryPoint(b)

  // Chain each tray's breakpoints in arc order (this splits segments at
  // junctions and entry points, weighting by real distance along the tray).
  for (let ti = 0; ti < trays.length; ti++) {
    const bps = breakpoints[ti].sort((x, y) => x.pos - y.pos)
    for (let i = 0; i < bps.length - 1; i++) {
      edge(
        nodeAt(bps[i].p, level[ti]),
        nodeAt(bps[i + 1].p, level[ti]),
        Math.abs(bps[i + 1].pos - bps[i].pos)
      )
    }
  }

  // Connect the device endpoints to their tray entry points.
  const A = nodeAt(a)
  const B = nodeAt(b)
  edge(A, nodeAt(entryA.pt, level[entryA.ti]), dist(a, entryA.pt))
  edge(B, nodeAt(entryB.pt, level[entryB.ti]), dist(b, entryB.pt))

  // ── Dijkstra A→B ─────────────────────────────────────────────────────────
  const best = new Array<number>(nodes.length).fill(Infinity)
  const prev = new Array<number>(nodes.length).fill(-1)
  const done = new Array<boolean>(nodes.length).fill(false)
  best[A] = 0
  for (;;) {
    let u = -1
    let bd = Infinity
    for (let i = 0; i < nodes.length; i++)
      if (!done[i] && best[i] < bd) {
        bd = best[i]
        u = i
      }
    if (u === -1 || u === B) break
    done[u] = true
    const m = adj.get(u)
    if (!m) continue
    for (const [v, w] of m)
      if (best[u] + w < best[v]) {
        best[v] = best[u] + w
        prev[v] = u
      }
  }
  if (best[B] === Infinity) return [a, b]

  const path: Pt[] = []
  for (let u = B; u !== -1; u = prev[u]) path.push(nodes[u])
  path.reverse()
  return path
}
