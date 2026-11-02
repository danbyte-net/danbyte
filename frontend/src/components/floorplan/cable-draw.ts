import type {
  FloorPlanCableEnd,
  FloorPlanCableFar,
  FloorPlanCablePath,
  FloorPlanTile,
  FloorPlanTray,
  StatusMini,
  StoredCablePath,
} from "@/lib/api"
import { naturalCompare } from "@/lib/natural-sort"
import { cssColor } from "@/lib/utils"
import { TYPE_PALETTE } from "@/components/topology/edge-style"

import { routeCable, trayElevationMm } from "./cable-route"
import type { PlenumRect, Pt } from "./cable-route"

// How the 2D plan draws its cables, as pure functions the canvas
// (cable-layer.tsx) and the PDF's drawing (plan-svg.ts) share:
//
// - each cable's route, through its trays or as an orthogonal elbow, held
//   in a cache keyed on what the route depends on (its end tiles, its trays
//   and their elevations), so a pan or an unrelated edit routes nothing;
// - the lanes: every run that shares a tray segment (or a direct run
//   between the same two tiles) gets its own parallel offset inside the
//   tray, in one global order so lines keep their places along the run;
// - the bundles: a shared segment whose lanes would sit closer than a few
//   pixels draws as one thicker stroke with a count;
// - colour from data (status, jacket colour, or type in legend order), the
//   line style of each route state, and the length the route works out.
//
// Everything is in cell units, like tray.points; the canvas multiplies by
// CELL.

/** floor-canvas.tsx's CELL: plan pixels per grid cell. */
const CELL = 40

/** A tray's channel is this wide on the plan (plan px; tray-layer.tsx). */
const TRAY_WIDTH_PX = 10
/** Lanes sit at most this far apart (plan px), inside the tray. */
const LANE_GAP_MAX_PX = 3

// ── Routes ──────────────────────────────────────────────────────────────────

/** One straight piece of a route. `group` is the lane group it shares -
 * a tray's segment (`t:<tray>:<i>`) or a direct run's leg
 * (`d:<tile>|<tile>:<i>`) - and `normal` the side its lanes stack towards;
 * both null on a hop between a tile and a tray. */
export interface RouteSeg {
  a: Pt
  b: Pt
  group: string | null
  normal: Pt | null
}

export interface CableRoute {
  id: string
  /** The centreline, A to B. */
  points: Pt[]
  segs: RouteSeg[]
  /** The trays it rides, in the order it travels them. */
  trayIds: string[]
  /** Through trays (false: a direct elbow between the tiles). */
  routed: boolean
  /** Horizontal length, in cells. */
  runCells: number
  /** The vertical drops at A and B (mm): rack top to the first and last
   * tray's elevation, 0 for a direct run. */
  dropsMm: [number, number]
  /** Drawn from a route the server worked out - the cable's stored path,
   * or a preview - not routed here. */
  stored?: boolean
  /** A stored path that is out of date. */
  stale?: boolean
  /** The stored or previewed route's length (mm), by the tenant's rules. */
  lengthMm?: number
  /** Ends whose tile moved since the path was stored: where the path
   * ends, and the tile's centre now. */
  moved?: { at: Pt; now: Pt }[]
}

export interface RouteContext {
  trays: FloorPlanTray[]
  tiles: FloorPlanTile[]
  ceilingMm?: number
  areas?: PlenumRect[]
}

type Router = typeof routeCable

const EPS = 1e-6
const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1])

function tileCentre(t: FloorPlanTile): Pt {
  return [t.x + t.width / 2, t.y + t.height / 2]
}

/** The side lanes stack towards for a run along `d`: the same for both
 * travel directions, so two cables share it whichever way each goes. */
export function laneNormal(a: Pt, b: Pt): Pt {
  let dx = b[0] - a[0]
  let dy = b[1] - a[1]
  const len = Math.hypot(dx, dy) || 1
  dx /= len
  dy /= len
  if (dx < -EPS || (Math.abs(dx) <= EPS && dy < 0)) {
    dx = -dx
    dy = -dy
  }
  return [-dy, dx]
}

/** Drop repeated points and the middle of three in a line. */
function tidy(points: Pt[]): Pt[] {
  const out: Pt[] = []
  for (const p of points) {
    if (out.length && dist(out[out.length - 1], p) < EPS) continue
    out.push(p)
  }
  return out
}

/** An elbow from p to q: q itself when the two line up, else via a corner
 * - `xFirst` runs along x first. */
function elbow(p: Pt, q: Pt, xFirst: boolean): Pt[] {
  if (Math.abs(p[0] - q[0]) < EPS || Math.abs(p[1] - q[1]) < EPS) return [q]
  return [xFirst ? [q[0], p[1]] : [p[0], q[1]], q]
}

/** Is `p` on segment s→e (within eps)? Returns its position along it. */
function along(p: Pt, s: Pt, e: Pt): number | null {
  const dx = e[0] - s[0]
  const dy = e[1] - s[1]
  const len2 = dx * dx + dy * dy
  if (len2 < EPS) return null
  const t = ((p[0] - s[0]) * dx + (p[1] - s[1]) * dy) / len2
  if (t < -1e-4 || t > 1 + 1e-4) return null
  const px = s[0] + t * dx
  const py = s[1] + t * dy
  return Math.hypot(p[0] - px, p[1] - py) < 1e-4 ? t : null
}

/** Is `p` on the polyline (within a hundredth of a cell)? */
function onRun(p: readonly number[], pts: readonly Pt[]): boolean {
  for (let i = 0; i < pts.length - 1; i++) {
    const [sx, sy] = pts[i]
    const [ex, ey] = pts[i + 1]
    const dx = ex - sx
    const dy = ey - sy
    const len2 = dx * dx + dy * dy
    const t =
      len2 < 1e-9
        ? 0
        : Math.max(0, Math.min(1, ((p[0] - sx) * dx + (p[1] - sy) * dy) / len2))
    if (Math.hypot(p[0] - (sx + t * dx), p[1] - (sy + t * dy)) < 0.01)
      return true
  }
  return false
}

/** Route one cable: through its trays, else an orthogonal elbow. Null when
 * an end is not on the plan or both ends share a tile. */
export function routeOne(
  cp: FloorPlanCablePath,
  tileById: ReadonlyMap<string, FloorPlanTile>,
  trayById: ReadonlyMap<string, FloorPlanTray>,
  elevation: (tray: FloorPlanTray) => number | null,
  router: Router = routeCable
): CableRoute | null {
  // A stored path draws as stored, from its first leg, while its tiles are
  // on the plan - its own ends, which may differ from where the cable's
  // devices stand now (an out-of-date path).
  if (cp.path?.legs.length) {
    const leg = cp.path.legs[0]
    if (tileById.has(leg.from.tile) && tileById.has(leg.to.tile))
      return pathRoute(cp.id, cp.path, tileById, trayById)
  }
  const ta = cp.a_tiles[0] ? tileById.get(cp.a_tiles[0]) : undefined
  const tb = cp.b_tiles[0] ? tileById.get(cp.b_tiles[0]) : undefined
  if (!ta || !tb || ta.id === tb.id) return null
  const a = tileCentre(ta)
  const b = tileCentre(tb)
  const used = cp.tray_ids
    .map((id) => trayById.get(id))
    .filter((t): t is FloorPlanTray => !!t && t.points.length >= 2)
  const raw = used.length
    ? router(
        a,
        b,
        used.map((t) => t.points),
        undefined,
        used.map(elevation)
      )
    : [a, b]
  const routed = used.length > 0 && raw.length > 2

  if (!routed) {
    // A direct run: an elbow drawn from the lower tile id, so every cable
    // between the same two tiles takes the same one.
    const flip = ta.id > tb.id
    const [p, q] = flip ? [b, a] : [a, b]
    let pts = tidy([p, ...elbow(p, q, true)])
    if (flip) pts = pts.reverse()
    const key = flip ? `${tb.id}|${ta.id}` : `${ta.id}|${tb.id}`
    const segs: RouteSeg[] = []
    for (let i = 0; i < pts.length - 1; i++) {
      // The leg's index from the canonical end, so both directions agree.
      const leg = flip ? pts.length - 2 - i : i
      segs.push({
        a: pts[i],
        b: pts[i + 1],
        group: `d:${key}:${leg}`,
        normal: laneNormal(pts[i], pts[i + 1]),
      })
    }
    return finish(cp.id, pts, segs, [], false, [0, 0])
  }

  // Through trays: the hops between a tile and its tray square off, the
  // leg that meets the tray at right angles to it.
  const mid = raw.slice(1, -1)
  const first = mid[0]
  const second = mid[1] ?? b
  const last = mid[mid.length - 1]
  const beforeLast = mid[mid.length - 2] ?? a
  const horiz = (p: Pt, q: Pt) => Math.abs(p[1] - q[1]) < EPS
  const head = elbow(a, first, horiz(first, second)).slice(0, -1)
  const tail = elbow(last, b, !horiz(beforeLast, last))
  const pts = tidy([a, ...head, ...mid, ...tail])

  const segs: RouteSeg[] = []
  for (let i = 0; i < pts.length - 1; i++) {
    const p = pts[i]
    const q = pts[i + 1]
    let group: string | null = null
    let normal: Pt | null = null
    for (const tray of used) {
      const tp = tray.points as Pt[]
      for (let s = 0; s < tp.length - 1 && !group; s++) {
        if (along(p, tp[s], tp[s + 1]) == null) continue
        if (along(q, tp[s], tp[s + 1]) == null) continue
        group = `t:${tray.id}:${s}`
        normal = laneNormal(tp[s], tp[s + 1])
      }
      if (group) break
    }
    segs.push({ a: p, b: q, group, normal })
  }
  const trayIds: string[] = []
  for (const s of segs) {
    const id = s.group?.startsWith("t:") ? s.group.split(":")[1] : null
    if (id && trayIds[trayIds.length - 1] !== id) trayIds.push(id)
  }
  const drop = (trayId: string | undefined, topMm: number) => {
    const tray = trayId ? trayById.get(trayId) : undefined
    const elev = tray ? elevation(tray) : null
    return elev == null ? 0 : Math.abs(elev - topMm)
  }
  return finish(cp.id, pts, segs, trayIds, true, [
    drop(trayIds[0], cp.a_top_mm ?? 0),
    drop(trayIds[trayIds.length - 1], cp.b_top_mm ?? 0),
  ])
}

/**
 * A route the server worked out - a cable's stored path, or a preview - as
 * the layer draws it: its first leg's centreline, each stretch along a
 * tray in that tray's lanes, a direct run in the lanes of every run
 * between the same two tiles. `moved` lists the ends whose tile is no
 * longer where the path left it.
 */
export function pathRoute(
  id: string,
  path: StoredCablePath,
  tileById: ReadonlyMap<string, FloorPlanTile>,
  trayById: ReadonlyMap<string, FloorPlanTray>
): CableRoute | null {
  const leg = path.legs[0]
  if (!leg) return null
  const pts = tidy(leg.points.map((p) => [p[0], p[1]] as Pt))
  if (pts.length < 2) return null
  const trays = leg.trays
    .map((s) => trayById.get(s.id))
    .filter((t): t is FloorPlanTray => !!t)
  const flip = leg.from.tile > leg.to.tile
  const key = flip
    ? `${leg.to.tile}|${leg.from.tile}`
    : `${leg.from.tile}|${leg.to.tile}`
  const segs: RouteSeg[] = []
  for (let i = 0; i < pts.length - 1; i++) {
    const p = pts[i]
    const q = pts[i + 1]
    let group: string | null = null
    let normal: Pt | null = null
    for (const tray of trays) {
      const tp = tray.points as Pt[]
      for (let s = 0; s < tp.length - 1 && !group; s++) {
        if (along(p, tp[s], tp[s + 1]) == null) continue
        if (along(q, tp[s], tp[s + 1]) == null) continue
        group = `t:${tray.id}:${s}`
        normal = laneNormal(tp[s], tp[s + 1])
      }
      if (group) break
    }
    if (!group && path.kind === "direct") {
      group = `d:${key}:${flip ? pts.length - 2 - i : i}`
      normal = laneNormal(p, q)
    }
    segs.push({ a: p, b: q, group, normal })
  }
  const moved: { at: Pt; now: Pt }[] = []
  for (const end of [leg.from, leg.to]) {
    const t = tileById.get(end.tile)
    if (!t) continue
    const now = tileCentre(t)
    if (dist(now, end.at) > 1e-3) moved.push({ at: [...end.at], now })
  }
  // A tray it rides gone, or no longer where the route enters and leaves it.
  const trayChanged = leg.trays.some((s) => {
    const t = trayById.get(s.id)
    if (!t) return true
    const tp = t.points as Pt[]
    return !onRun(s.entry, tp) || !onRun(s.exit, tp)
  })
  const route = finish(
    id,
    pts,
    segs,
    leg.trays.map((s) => s.id),
    path.kind !== "direct",
    [path.drop_a_mm, path.drop_b_mm]
  )
  return {
    ...route,
    stored: true,
    stale: !!path.stale || moved.length > 0 || trayChanged,
    lengthMm: path.length_mm,
    moved,
  }
}

function finish(
  id: string,
  points: Pt[],
  segs: RouteSeg[],
  trayIds: string[],
  routed: boolean,
  dropsMm: [number, number]
): CableRoute {
  let run = 0
  for (const s of segs) run += dist(s.a, s.b)
  return { id, points, segs, trayIds, routed, runCells: run, dropsMm }
}

/**
 * Every cable's route, kept between calls: a cable is routed again only
 * when what its route depends on changed - its end tiles' places, its
 * trays' points and their elevations. Panning, zooming, a hover or an
 * edit elsewhere on the plan route nothing.
 */
export class CableRouteCache {
  private memo = new Map<string, { key: string; route: CableRoute | null }>()
  private router: Router

  constructor(router: Router = routeCable) {
    this.router = router
  }

  routes(
    cablePaths: readonly FloorPlanCablePath[],
    ctx: RouteContext
  ): Map<string, CableRoute> {
    const tileById = new Map(ctx.tiles.map((t) => [t.id, t]))
    const trayById = new Map(ctx.trays.map((t) => [t.id, t]))
    const elevations = new Map<string, number | null>()
    const elevation = (tray: FloorPlanTray) => {
      if (ctx.ceilingMm == null) return null
      let v = elevations.get(tray.id)
      if (v === undefined) {
        v = trayElevationMm(tray, ctx.ceilingMm, ctx.areas)
        elevations.set(tray.id, v)
      }
      return v
    }
    const traySig = new Map<string, string>()
    const sigOf = (id: string) => {
      let s = traySig.get(id)
      if (s === undefined) {
        const t = trayById.get(id)
        s = t ? `${JSON.stringify(t.points)}@${elevation(t)}` : "-"
        traySig.set(id, s)
      }
      return s
    }
    const tileSig = (id: string | undefined) => {
      const t = id ? tileById.get(id) : undefined
      return t ? `${t.id}@${t.x},${t.y},${t.width},${t.height}` : "-"
    }
    const out = new Map<string, CableRoute>()
    const seen = new Set<string>()
    for (const cp of cablePaths) {
      seen.add(cp.id)
      const leg = cp.path?.legs[0]
      const key = [
        tileSig(cp.a_tiles[0]),
        tileSig(cp.b_tiles[0]),
        cp.a_top_mm ?? 0,
        cp.b_top_mm ?? 0,
        ...cp.tray_ids.map((id) => `${id}=${sigOf(id)}`),
        // A stored path: its version and state, its tiles and trays.
        ...(cp.path && leg
          ? [
              `p:${cp.path.version ?? ""}:${cp.path.stale ? 1 : 0}`,
              tileSig(leg.from.tile),
              tileSig(leg.to.tile),
              ...leg.trays.map((s) => `${s.id}=${sigOf(s.id)}`),
            ]
          : []),
      ].join("|")
      let hit = this.memo.get(cp.id)
      if (!hit || hit.key !== key) {
        hit = {
          key,
          route: routeOne(cp, tileById, trayById, elevation, this.router),
        }
        this.memo.set(cp.id, hit)
      }
      if (hit.route) out.set(cp.id, hit.route)
    }
    for (const id of [...this.memo.keys()])
      if (!seen.has(id)) this.memo.delete(id)
    return out
  }
}

// ── Lanes and bundles ───────────────────────────────────────────────────────

/** Runs sharing one tray segment, or one leg of a direct run. */
export interface LaneGroup {
  key: string
  /** Cable ids, in lane order. */
  members: string[]
  /** The stretch the members share, on the centreline. */
  a: Pt
  b: Pt
  normal: Pt
  /** Lane spacing, in cells. */
  gap: number
}

/** A route's piece with its lane offset (cells, along the group's normal). */
export interface LaidSeg extends RouteSeg {
  offset: number
}

export interface CableLayout {
  groups: Map<string, LaneGroup>
  cables: Map<string, LaidSeg[]>
  /** Every routed cable, in lane order. */
  order: string[]
}

/** The lane order: by label, naturally, then id - one order everywhere, so
 * two cables keep their sides wherever they run together. */
export function laneOrder(
  cablePaths: readonly FloorPlanCablePath[],
  routes: ReadonlyMap<string, CableRoute>
): string[] {
  return cablePaths
    .filter((cp) => routes.has(cp.id))
    .sort((x, y) => naturalCompare(x.label, y.label) || (x.id < y.id ? -1 : 1))
    .map((cp) => cp.id)
}

/** Lay the routes out in lanes. Depends on the routes only - not the zoom,
 * which decides later which groups draw as bundles. */
export function layoutCables(
  routes: ReadonlyMap<string, CableRoute>,
  order: readonly string[]
): CableLayout {
  const rank = new Map(order.map((id, i) => [id, i]))
  const members = new Map<string, Set<string>>()
  const first = new Map<string, RouteSeg>()
  for (const id of order) {
    const r = routes.get(id)
    if (!r) continue
    for (const s of r.segs) {
      if (!s.group) continue
      let m = members.get(s.group)
      if (!m) {
        m = new Set()
        members.set(s.group, m)
        first.set(s.group, s)
      }
      m.add(id)
    }
  }
  const groups = new Map<string, LaneGroup>()
  for (const [key, set] of members) {
    const ids = [...set].sort((x, y) => rank.get(x)! - rank.get(y)!)
    const ref = first.get(key)!
    const normal = ref.normal ?? laneNormal(ref.a, ref.b)
    // The stretch every member shares a part of, along the run.
    const dir: Pt = [normal[1], -normal[0]]
    let lo = Infinity
    let hi = -Infinity
    for (const id of ids)
      for (const s of routes.get(id)!.segs)
        if (s.group === key)
          for (const p of [s.a, s.b]) {
            const t = (p[0] - ref.a[0]) * dir[0] + (p[1] - ref.a[1]) * dir[1]
            lo = Math.min(lo, t)
            hi = Math.max(hi, t)
          }
    const width = key.startsWith("t:") ? (TRAY_WIDTH_PX - 2) / CELL : Infinity
    const n = ids.length
    const gap = n > 1 ? Math.min(LANE_GAP_MAX_PX / CELL, width / (n - 1)) : 0
    groups.set(key, {
      key,
      members: ids,
      a: [ref.a[0] + dir[0] * lo, ref.a[1] + dir[1] * lo],
      b: [ref.a[0] + dir[0] * hi, ref.a[1] + dir[1] * hi],
      normal,
      gap,
    })
  }
  const cables = new Map<string, LaidSeg[]>()
  for (const id of order) {
    const r = routes.get(id)
    if (!r) continue
    cables.set(
      id,
      r.segs.map((s) => {
        const g = s.group ? groups.get(s.group) : undefined
        if (!g) return { ...s, offset: 0 }
        const lane = g.members.indexOf(id)
        return { ...s, offset: (lane - (g.members.length - 1) / 2) * g.gap }
      })
    )
  }
  return { groups, cables, order: [...order] }
}

/** Where each laid piece starts and ends once its lane is applied and the
 * corners are joined: a turn meets at the two lanes' crossing, a lane
 * change along a straight run steps across. */
export function laneSegments(segs: readonly LaidSeg[]): { a: Pt; b: Pt }[] {
  const off = segs.map((s) => {
    const n = s.normal ?? [0, 0]
    return {
      a: [s.a[0] + n[0] * s.offset, s.a[1] + n[1] * s.offset] as Pt,
      b: [s.b[0] + n[0] * s.offset, s.b[1] + n[1] * s.offset] as Pt,
    }
  })
  const out = off.map((o) => ({ a: o.a, b: o.b }))
  for (let i = 0; i < off.length - 1; i++) {
    const p = off[i]
    const q = off[i + 1]
    const d1: Pt = [p.b[0] - p.a[0], p.b[1] - p.a[1]]
    const d2: Pt = [q.b[0] - q.a[0], q.b[1] - q.a[1]]
    const cross = d1[0] * d2[1] - d1[1] * d2[0]
    const scale = Math.hypot(...d1) * Math.hypot(...d2)
    if (scale < EPS || Math.abs(cross) / scale < 1e-3) continue // a step
    const t =
      ((q.a[0] - p.a[0]) * d2[1] - (q.a[1] - p.a[1]) * d2[0]) / (cross || 1)
    const x: Pt = [p.a[0] + d1[0] * t, p.a[1] + d1[1] * t]
    out[i].b = x
    out[i + 1].a = x
  }
  return out
}

/** The polylines of a cable's lanes, leaving out the pieces `skip` says
 * (those drawn in a bundle): one polyline per unbroken stretch. */
export function lanePolylines(
  segs: readonly LaidSeg[],
  skip: (seg: LaidSeg) => boolean = () => false
): Pt[][] {
  const joined = laneSegments(segs)
  const out: Pt[][] = []
  let cur: Pt[] | null = null
  segs.forEach((s, i) => {
    if (skip(s)) {
      cur = null
      return
    }
    const { a, b } = joined[i]
    if (!cur) {
      cur = [a]
      out.push(cur)
    } else if (dist(cur[cur.length - 1], a) > EPS) cur.push(a)
    cur.push(b)
  })
  return out
}

/** Level of detail, by how large a cell is on screen. */
export type CableLod = "far" | "mid" | "near"

export function cableLod(pxPerCell: number): CableLod {
  if (pxPerCell < 16) return "far"
  if (pxPerCell < 48) return "mid"
  return "near"
}

/** On paper, a 1:200 A3 shows bundles; detail from 10 mm a cell. */
export function paperLod(mmPerCell: number): CableLod {
  return mmPerCell >= 10 ? "near" : "mid"
}

/** Lanes closer than this on screen merge; past it, a bundle (px). */
export const LANE_MIN_PX = 3

/** The groups drawn as a bundle: shared by two or more, not fanned out,
 * with bundling on, and either below near detail or with lanes closer
 * than `minGapCells`.
 *
 * From afar a tray's stretches are not bundles - the tray carries its
 * cables' count and their runs are not drawn - but a direct run's legs
 * are: the runs that ride no tray still draw from afar, and a stretch
 * they share draws as their bundle. (Leaving those out of the drawing
 * while their lanes skipped them once dropped whole legs from afar.) */
export function bundledGroups(
  layout: CableLayout,
  {
    lod,
    bundle,
    minGapCells,
    fanned,
  }: {
    lod: CableLod
    bundle: boolean
    minGapCells: number
    fanned?: ReadonlySet<string>
  }
): Set<string> {
  const out = new Set<string>()
  if (!bundle) return out
  for (const g of layout.groups.values()) {
    if (g.members.length < 2 || fanned?.has(g.key)) continue
    if (lod === "far" && g.key.startsWith("t:")) continue
    if (lod !== "near" || g.gap < minGapCells) out.add(g.key)
  }
  return out
}

/** Screen px between a bundle's edge and a traced member's own lane. */
const SPLIT_PX = 3

/**
 * A traced (or previewed) cable's lanes, split from its bundles: along
 * every stretch drawn as a bundle its lane moves out beside the bundle, on
 * its own side of it (the side its lane is on when the lanes are drawn),
 * so the one cable reads apart from the rest along its whole route.
 * Stretches drawn as lanes keep their lane. `pxPerCell`: a cell on screen.
 */
export function splitLanes(
  layout: CableLayout,
  id: string,
  bundled: ReadonlySet<string>,
  pxPerCell: number
): Pt[][] {
  const segs = layout.cables.get(id)
  if (!segs) return []
  const out = segs.map((s) => {
    if (!s.group || !bundled.has(s.group)) return s
    const g = layout.groups.get(s.group)!
    const lane = g.members.indexOf(id)
    const side = lane < (g.members.length - 1) / 2 ? -1 : 1
    const px = bundleWidth(g.members.length) / 2 + SPLIT_PX
    return { ...s, offset: (side * px) / Math.max(pxPerCell, 1e-6) }
  })
  return lanePolylines(out)
}

// ── Picking a cable ─────────────────────────────────────────────────────────

/** One row of the cable chooser (a bundle's, a tray's). */
export interface CableChoice {
  id: string
  label: string
  /** The cable's colour under the colour mode, or null. */
  color: string | null
  /** `A-end → B-end`, each as `device · port`. */
  ends: string
  status: StatusMini | null
}

/** The chooser's rows: the cables of `ids` drawn on this plan, in lane
 * order (by label, naturally, then id) - the order they lie in a tray. */
export function cableChoices(
  ids: readonly string[],
  cablePaths: readonly FloorPlanCablePath[],
  colorBy: CableColorBy,
  palette: ReadonlyMap<string, string>
): CableChoice[] {
  const want = new Set(ids)
  return cablePaths
    .filter((cp) => want.has(cp.id))
    .sort((x, y) => naturalCompare(x.label, y.label) || (x.id < y.id ? -1 : 1))
    .map((cp) => ({
      id: cp.id,
      label: cp.label,
      color: cableColor(cp, colorBy, palette),
      ends: `${endText(cp.a_points)} → ${endText(cp.b_points)}`,
      status: cp.status ?? null,
    }))
}

/** The rows matching a search: in the label or either end, any case. */
export function filterChoices(
  rows: readonly CableChoice[],
  query: string
): CableChoice[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...rows]
  return rows.filter(
    (r) => r.label.toLowerCase().includes(q) || r.ends.toLowerCase().includes(q)
  )
}

/** A bundle's stroke (screen px): thicker with more cables, capped. */
export function bundleWidth(n: number): number {
  return Math.min(7, 2.5 + Math.log2(Math.max(2, n)) * 1.25)
}

/** A polyline as a path with small rounded corners (`r` in the path's
 * own units, never more than half a leg). */
export function roundedPath(points: readonly Pt[], r: number): string {
  if (points.length === 0) return ""
  const f = (n: number) => +n.toFixed(2)
  let d = `M${f(points[0][0])} ${f(points[0][1])}`
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i - 1]
    const c = points[i]
    const n = points[i + 1]
    const l1 = dist(p, c)
    const l2 = dist(c, n)
    const rr = Math.min(r, l1 / 2, l2 / 2)
    if (rr < 0.01) {
      d += `L${f(c[0])} ${f(c[1])}`
      continue
    }
    const s: Pt = [
      c[0] + ((p[0] - c[0]) / l1) * rr,
      c[1] + ((p[1] - c[1]) / l1) * rr,
    ]
    const e: Pt = [
      c[0] + ((n[0] - c[0]) / l2) * rr,
      c[1] + ((n[1] - c[1]) / l2) * rr,
    ]
    d += `L${f(s[0])} ${f(s[1])}Q${f(c[0])} ${f(c[1])} ${f(e[0])} ${f(e[1])}`
  }
  const last = points[points.length - 1]
  return d + `L${f(last[0])} ${f(last[1])}`
}

/** The middle of a polyline's longest leg, and that leg's direction. */
export function longestLegMid(points: readonly Pt[]): { at: Pt; len: number } {
  let best = { at: points[0], len: 0 }
  for (let i = 0; i < points.length - 1; i++) {
    const len = dist(points[i], points[i + 1])
    if (len > best.len)
      best = {
        at: [
          (points[i][0] + points[i + 1][0]) / 2,
          (points[i][1] + points[i + 1][1]) / 2,
        ],
        len,
      }
  }
  return best
}

/** Do two runs share a stretch anywhere - could a bundle be drawn? */
export function hasSharedRuns(
  routes: ReadonlyMap<string, CableRoute>
): boolean {
  const seen = new Set<string>()
  for (const r of routes.values()) {
    const mine = new Set<string>()
    for (const s of r.segs) if (s.group) mine.add(s.group)
    for (const g of mine) {
      if (seen.has(g)) return true
      seen.add(g)
    }
  }
  return false
}

// ── Colour ──────────────────────────────────────────────────────────────────

export type CableColorBy = "status" | "jacket" | "type"
export const CABLE_COLOR_BY: CableColorBy[] = ["status", "jacket", "type"]
export const CABLE_COLOR_BY_LABEL: Record<CableColorBy, string> = {
  status: "Status",
  jacket: "Cable color",
  type: "Type",
}

export function readCableColorBy(v: unknown): CableColorBy {
  return CABLE_COLOR_BY.includes(v as CableColorBy)
    ? (v as CableColorBy)
    : "status"
}

/** A cable with nothing to colour it by: the muted foreground. */
export const CABLE_NONE = "var(--muted-foreground)"
/** The same on paper (the light theme's muted foreground). */
export const CABLE_NONE_PAPER = "#71717a"

const typeName = (cp: FloorPlanCablePath) => cp.type_display || cp.type

/** Colour by Type: the palette handed out in legend order - the most
 * common type first - so a plan's few types get the most distinct hues
 * and the legend reads top down. */
export function typePalette(
  cablePaths: readonly FloorPlanCablePath[]
): Map<string, string> {
  const counts = new Map<string, { n: number; name: string }>()
  for (const cp of cablePaths) {
    if (!cp.type) continue
    const c = counts.get(cp.type) ?? { n: 0, name: typeName(cp) }
    c.n++
    counts.set(cp.type, c)
  }
  const sorted = [...counts].sort(
    ([, x], [, y]) => y.n - x.n || naturalCompare(x.name, y.name)
  )
  return new Map(
    sorted.map(([type], i) => [type, TYPE_PALETTE[i % TYPE_PALETTE.length]])
  )
}

/** A cable's colour under the mode, or null when it has none (it then
 * draws in {@link CABLE_NONE}). */
export function cableColor(
  cp: FloorPlanCablePath,
  mode: CableColorBy,
  palette: ReadonlyMap<string, string>
): string | null {
  if (mode === "status") return cssColor(cp.status?.color) ?? null
  if (mode === "jacket") return cssColor(cp.color) ?? null
  return palette.get(cp.type) ?? null
}

/** A bundle's colour: the members' shared colour, or null when they
 * differ - a mixed bundle stays neutral. */
export function sharedColor(colors: readonly (string | null)[]): string | null {
  if (!colors.length) return null
  return colors.every((c) => c === colors[0]) ? colors[0] : null
}

// ── Line styles ─────────────────────────────────────────────────────────────

export type CableRouteState =
  "documented" | "planned" | "inferred" | "preview" | "stale"

export interface CableLineStyle {
  label: string
  /** Stroke width, screen px. */
  width: number
  opacity: number
  /** Dash, screen px. */
  dash?: string
  cap: "round" | "butt"
}

export const CABLE_LINE: Record<CableRouteState, CableLineStyle> = {
  documented: { label: "Documented", width: 2.5, opacity: 0.95, cap: "round" },
  planned: {
    label: "Planned",
    width: 2.5,
    opacity: 0.95,
    dash: "8 4",
    cap: "butt",
  },
  inferred: { label: "Inferred", width: 2, opacity: 0.6, cap: "round" },
  preview: {
    label: "Preview",
    width: 2,
    opacity: 1,
    dash: "0.5 3.5",
    cap: "round",
  },
  stale: { label: "Out of date", width: 2.5, opacity: 0.95, cap: "round" },
}

/** The order the legend lists the styles in. */
export const CABLE_STATES: CableRouteState[] = [
  "documented",
  "planned",
  "inferred",
  "preview",
  "stale",
]

/** How a cable's route draws. A route nobody stored is inferred - from
 * its trays, or straight between its tiles; a stored one is documented,
 * or stale once out of date; a cable in a planned status draws planned
 * whatever its route, unless its stored route is out of date. `stored` is
 * the cable's stored path on the plan, when there is one. (A preview - a
 * route computed, not saved - draws in its own layer, `preview`.) */
export function cableRouteState(
  cp: FloorPlanCablePath,
  stored?: { stale?: boolean } | null
): CableRouteState {
  if (stored?.stale) return "stale"
  if (cp.status?.is_planned) return "planned"
  if (stored) return "documented"
  return "inferred"
}

/** The state of a cable as drawn from its route: the route knows whether
 * it came from a stored path and whether that is out of date. */
export function drawnRouteState(
  cp: FloorPlanCablePath,
  route: CableRoute | undefined
): CableRouteState {
  return cableRouteState(cp, route?.stored ? { stale: route.stale } : null)
}

// ── Length ──────────────────────────────────────────────────────────────────

/** The route's length (m). A stored or previewed route's is the server's,
 * by the tenant's length rules; an inferred one's is run × cell size, plus
 * both drops, plus 10 % slack, to 0.1 m - the rules' defaults before the
 * round-up. */
export function routeLengthM(route: CableRoute, cellMm: number): number {
  if (route.lengthMm != null) return route.lengthMm / 1000
  const mm = route.runCells * cellMm + route.dropsMm[0] + route.dropsMm[1]
  return Math.round((mm * 1.1) / 100) / 10
}

const UNIT_M: Record<string, number> = {
  m: 1,
  cm: 0.01,
  ft: 0.3048,
  in: 0.0254,
}

/** The stored length in metres, or null. */
export function storedLengthM(cp: FloorPlanCablePath): number | null {
  if (cp.length == null) return null
  return cp.length * (UNIT_M[cp.length_unit || "m"] ?? 1)
}

export function formatStoredLength(cp: FloorPlanCablePath): string | null {
  if (cp.length == null) return null
  return `${+cp.length.toFixed(2)} ${cp.length_unit || "m"}`
}

export function formatMetres(m: number): string {
  return `${m.toFixed(1)} m`
}

// ── Ends ────────────────────────────────────────────────────────────────────

/** One end as text: `device · port`, Hidden for a device the reader may not
 * view, and how many more for a breakout. */
export function endText(points: readonly FloorPlanCableEnd[]): string {
  if (!points.length) return "-"
  const p = points[0]
  const one = p.hidden
    ? "Hidden"
    : [p.device_name, p.port].filter(Boolean).join(" · ") || "-"
  return points.length > 1 ? `${one} +${points.length - 1}` : one
}

// ── Ends off the plan, and the plan from afar ───────────────────────────────

/** A cable with one end on this plan: a short stub from that end's tile,
 * pointing away from the plan's middle, towards where the run leaves. */
export interface CableStub {
  id: string
  /** The end on this plan. */
  end: "A" | "B"
  tile: string
  /** Where the stub starts: the tile's edge along `dir` (cells). */
  from: Pt
  /** The unit direction it points. */
  dir: Pt
  /** The other end - on no tile here. */
  far: FloorPlanCableFar[]
}

/** A stub's length on screen (px) - the canvas - and on paper (mm). */
export const STUB_PX = 28
export const STUB_MM = 5
/** Stubs off one tile fan out this far apart (radians). */
const STUB_SPREAD = 0.4

/** The far end of a cable drawn as a stub, or null for any other cable. */
export function stubFar(
  cp: FloorPlanCablePath,
  stubs: readonly CableStub[]
): FloorPlanCableFar[] | null {
  return stubs.find((s) => s.id === cp.id)?.far ?? null
}

/**
 * The stubs: every cable not drawn as a run with tiles here at exactly one
 * end. `tiles` are the tiles shown - an end on a tile left out (Hidden) is
 * not on this plan. Each points from the plan's centre `centre` out through
 * its tile; those off one tile fan out round that direction.
 */
export function cableStubs(
  cablePaths: readonly FloorPlanCablePath[],
  routes: ReadonlyMap<string, unknown>,
  tiles: readonly FloorPlanTile[],
  centre: Pt
): CableStub[] {
  const byId = new Map(tiles.map((t) => [t.id, t]))
  const raw: { cp: FloorPlanCablePath; end: "A" | "B"; tile: FloorPlanTile }[] =
    []
  for (const cp of cablePaths) {
    if (routes.has(cp.id)) continue
    const a = cp.a_tiles.map((id) => byId.get(id)).find(Boolean)
    const b = cp.b_tiles.map((id) => byId.get(id)).find(Boolean)
    if (!a === !b) continue
    raw.push({ cp, end: a ? "A" : "B", tile: (a ?? b)! })
  }
  const perTile = new Map<string, number>()
  for (const r of raw) perTile.set(r.tile.id, (perTile.get(r.tile.id) ?? 0) + 1)
  const seen = new Map<string, number>()
  return raw.map(({ cp, end, tile }) => {
    const c = tileCentre(tile)
    let base = Math.atan2(c[1] - centre[1], c[0] - centre[0])
    if (dist(c, centre) < EPS) base = -Math.PI / 2
    const n = perTile.get(tile.id)!
    const i = seen.get(tile.id) ?? 0
    seen.set(tile.id, i + 1)
    const ang = base + (i - (n - 1) / 2) * STUB_SPREAD
    const dir: Pt = [Math.cos(ang), Math.sin(ang)]
    // Out to the tile's edge along dir.
    const hw = tile.width / 2
    const hh = tile.height / 2
    const t = Math.min(
      Math.abs(dir[0]) > EPS ? hw / Math.abs(dir[0]) : Infinity,
      Math.abs(dir[1]) > EPS ? hh / Math.abs(dir[1]) : Infinity
    )
    return {
      id: cp.id,
      end,
      tile: tile.id,
      from: [c[0] + dir[0] * t, c[1] + dir[1] * t],
      dir,
      far: (end === "A" ? cp.b_far : cp.a_far) ?? [],
    }
  })
}

/** The cables of the plan as the legend counts them: drawn as runs, with
 * one end here (a stub), and the rest - no end placed here. */
export interface CableCounts {
  drawn: number
  oneEnd: number
  notPlaced: number
}

export function cableCounts(
  cablePaths: readonly FloorPlanCablePath[],
  routes: ReadonlyMap<string, unknown>,
  stubs: readonly CableStub[]
): CableCounts {
  const drawn = cablePaths.filter((cp) => routes.has(cp.id)).length
  const oneEnd = new Set(stubs.map((s) => s.id)).size
  return { drawn, oneEnd, notPlaced: cablePaths.length - drawn - oneEnd }
}

/** The objects to place to bring the stubs' far ends here: those on this
 * plan's site, once each. */
export function stubPlaceIds(stubs: readonly CableStub[]): string[] {
  const ids = new Set<string>()
  for (const s of stubs)
    for (const f of s.far) if (!f.hidden && f.place) ids.add(f.place.id)
  return [...ids]
}

/** A stub's far end, for its popover: the device and port (Hidden when the
 * reader may not view it), and the floor of the stack it stands on. */
export function farEndLines(far: readonly FloorPlanCableFar[]): string[] {
  if (!far.length) return ["Far end not on this plan"]
  const lines = [`Far end not on this plan: ${endText(far)}`]
  const f = far[0]
  if (!f.hidden && f.floor_plan) lines.push(`On ${f.floor_plan.name}`)
  return lines
}

/** Below this on screen (px) a tile draws as a marker this size. */
export const MIN_TILE_PX = 8
/** A run shorter than this on screen (px) draws as a marker. */
export const SHORT_RUN_PX = 6

/** The marker's side for a tile `w` x `h` cells at `pxPerCell` - in cells -
 * or null when the tile is large enough on screen to read as itself. */
export function tileMarkerCells(
  w: number,
  h: number,
  pxPerCell: number
): number | null {
  if (Math.max(w, h) * pxPerCell >= MIN_TILE_PX) return null
  return MIN_TILE_PX / pxPerCell
}

/** Runs too short to see at this zoom, gathered where they overlap on
 * screen: each group's place, the direction of its first run, its cables. */
export interface ShortRunGroup {
  key: string
  at: Pt
  dir: Pt
  ids: string[]
}

export function shortRuns(
  routes: ReadonlyMap<string, CableRoute>,
  pxPerCell: number,
  minPx = SHORT_RUN_PX
): ShortRunGroup[] {
  const cellPx = MIN_TILE_PX * 1.5
  const groups = new Map<string, ShortRunGroup>()
  for (const [id, r] of routes) {
    if (!r.points.length) continue
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const [x, y] of r.points) {
      x0 = Math.min(x0, x)
      y0 = Math.min(y0, y)
      x1 = Math.max(x1, x)
      y1 = Math.max(y1, y)
    }
    if (Math.hypot(x1 - x0, y1 - y0) * pxPerCell >= minPx) continue
    const at: Pt = [(x0 + x1) / 2, (y0 + y1) / 2]
    const key = `${Math.round((at[0] * pxPerCell) / cellPx)},${Math.round(
      (at[1] * pxPerCell) / cellPx
    )}`
    const g = groups.get(key)
    if (g) {
      g.ids.push(id)
      continue
    }
    const a = r.points[0]
    const b = r.points[r.points.length - 1]
    const len = dist(a, b)
    groups.set(key, {
      key,
      at,
      dir: len > EPS ? [(b[0] - a[0]) / len, (b[1] - a[1]) / len] : [1, 0],
      ids: [id],
    })
  }
  return [...groups.values()]
}

// ── Legend ──────────────────────────────────────────────────────────────────

export interface CableLegendColor {
  label: string
  color: string
  /** The status, for its pill (Color by Status). */
  status?: StatusMini
}

export interface CableLegend {
  mode: CableColorBy
  title: string
  colors: CableLegendColor[]
  states: CableRouteState[]
  bundles: boolean
}

/** The key to the cables drawn: their colours under the mode, the line
 * styles in use, and whether any run is bundled. */
export function cableLegend(
  cablePaths: readonly FloorPlanCablePath[],
  mode: CableColorBy,
  palette: ReadonlyMap<string, string>,
  { bundles = false, noneColor = CABLE_NONE } = {}
): CableLegend {
  const colors: CableLegendColor[] = []
  let missing = false
  if (mode === "status") {
    const seen = new Map<string, StatusMini>()
    for (const cp of cablePaths)
      if (cp.status) seen.set(cp.status.id, cp.status)
      else missing = true
    for (const s of [...seen.values()].sort((x, y) =>
      naturalCompare(x.name, y.name)
    ))
      colors.push({
        label: s.name,
        color: cssColor(s.color) ?? noneColor,
        status: s,
      })
  } else if (mode === "jacket") {
    const seen = new Set<string>()
    for (const cp of cablePaths) {
      const c = cssColor(cp.color)
      if (c) seen.add(c.toLowerCase())
      else missing = true
    }
    for (const c of [...seen].sort()) colors.push({ label: c, color: c })
  } else {
    const names = new Map<string, string>()
    for (const cp of cablePaths)
      if (cp.type) names.set(cp.type, typeName(cp))
      else missing = true
    for (const [type, color] of palette)
      colors.push({ label: names.get(type) ?? type, color })
  }
  if (missing)
    colors.push({
      label:
        mode === "status"
          ? "No status"
          : mode === "jacket"
            ? "No color"
            : "No type",
      color: noneColor,
    })
  const present = new Set(cablePaths.map((cp) => cableRouteState(cp, cp.path)))
  return {
    mode,
    title: `Cables · ${CABLE_COLOR_BY_LABEL[mode]}`,
    colors,
    states: CABLE_STATES.filter((s) => present.has(s)),
    bundles,
  }
}

/** The cable legend as the PDF's sheet takes it (api/floor_plan_pdf.py):
 * a row per colour, then a line row per style. */
export function cableLegendEntries(legend: CableLegend): {
  title: string
  items: { label: string; color: string; line?: string }[]
} {
  const colors = legend.colors.slice(0, 16).map((c) => ({
    label: c.label,
    color: c.color.startsWith("#") ? c.color : CABLE_NONE_PAPER,
  }))
  const lines = legend.states.map((s) => ({
    label: CABLE_LINE[s].label,
    color: CABLE_NONE_PAPER,
    line: s === "planned" ? "dashed" : s === "inferred" ? "thin" : "solid",
  }))
  if (legend.bundles)
    lines.push({ label: "Bundle", color: CABLE_NONE_PAPER, line: "bundle" })
  return { title: legend.title, items: [...colors, ...lines].slice(0, 24) }
}
