import dagre from "@dagrejs/dagre"
import type { Edge, Node } from "@xyflow/react"

import { stencilSize } from "./stencil-node"
import type { StencilData } from "./stencil-node"
import { flatHeight, flatWidth } from "./flat-node"
import { GROUP_H, GROUP_W } from "./group-node"

// Lay nodes out left-to-right with dagre and write positions back. Node
// height follows the stencil card (header + one row per cabled port) so
// port-anchored edges land on their rows without overlap. `positions`
// (from a saved view or a user drag) win over the computed layout.
// Fixed tier spacing when the Level organiser forces a role order.
const LEVEL_GAP_LR = 340
const LEVEL_GAP_TB = 210
const CROSS_GAP = 64 // intra-tier peer spacing - wide enough that a
// vertical cable’s label between tiers isn’t hidden behind the next node, and
// that fanned-out cable bundles have room between neighbouring cards.

// Natural order so fw-01 precedes fw-02 precedes fw-10.
const natural = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })

export interface LayoutResult {
  nodes: Node[]
  /** edge id → interior bend points (flow coords) that bend a cable around
   * the cards between its ends. Computed from the FINAL node positions, so
   * it works for the auto layout, role tiers, AND pinned/saved views. Empty
   * for edges where a straight line is already clear. */
  waypoints: Map<string, [number, number][]>
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** A cable's route through one clear "channel" - the main-axis coordinate `m`
 * its perpendicular run sits at, plus the two cross endpoints and the gap
 * bounds `m` must stay within. `blocked` means `m` had to dodge a card. */
interface Channel {
  m: number
  aCross: number
  bCross: number
  blocked: boolean
  gapLo: number
  gapHi: number
}

/**
 * The channel an orthogonal "Z" route takes from a to b. `m` sits in the GAP
 * between the two cards' FACING edges (never inside a card), so a cable always
 * leaves its port outward and never doubles back up into its own card. Returns
 * `null` when the two are on the same tier / no clear channel exists.
 * `tb` = tree mode (main axis is y); otherwise main axis is x.
 */
function channelRoute(
  a: Rect,
  b: Rect,
  obstacles: Rect[],
  tb: boolean
): Channel | null {
  const aLo = tb ? a.y : a.x
  const aHi = tb ? a.y + a.h : a.x + a.w
  const bLo = tb ? b.y : b.x
  const bHi = tb ? b.y + b.h : b.x + b.w
  const aMain = (aLo + aHi) / 2
  const bMain = (bLo + bHi) / 2
  const aCross = tb ? a.x + a.w / 2 : a.y + a.h / 2
  const bCross = tb ? b.x + b.w / 2 : b.y + b.h / 2
  if (Math.abs(aMain - bMain) < 1) return null // same tier
  // The gap between the facing edges (source-exit edge → target-entry edge).
  let gapLo: number
  let gapHi: number
  if (bMain > aMain) {
    gapLo = aHi
    gapHi = bLo
  } else {
    gapLo = bHi
    gapHi = aLo
  }
  if (gapHi - gapLo < 8) {
    // Cards overlap/touch on the main axis - fall back to the centre span.
    gapLo = Math.min(aMain, bMain)
    gapHi = Math.max(aMain, bMain)
  }
  const M = 12 // clearance around a card
  const mainRunHits = (cross: number, m1: number, m2: number) => {
    const lo = Math.min(m1, m2)
    const hi = Math.max(m1, m2)
    return obstacles.some((o) => {
      const c1 = tb ? o.x : o.y
      const c2 = tb ? o.x + o.w : o.y + o.h
      const n1 = tb ? o.y : o.x
      const n2 = tb ? o.y + o.h : o.x + o.w
      return cross > c1 - M && cross < c2 + M && hi > n1 - M && lo < n2 + M
    })
  }
  const crossRunHits = (main: number, c1: number, c2: number) => {
    const lo = Math.min(c1, c2)
    const hi = Math.max(c1, c2)
    return obstacles.some((o) => {
      const oc1 = tb ? o.x : o.y
      const oc2 = tb ? o.x + o.w : o.y + o.h
      const n1 = tb ? o.y : o.x
      const n2 = tb ? o.y + o.h : o.x + o.w
      return main > n1 - M && main < n2 + M && hi > oc1 - M && lo < oc2 + M
    })
  }
  const clear = (m: number) =>
    !mainRunHits(aCross, aMain, m) &&
    !crossRunHits(m, aCross, bCross) &&
    !mainRunHits(bCross, bMain, m)
  const mid = (gapLo + gapHi) / 2
  if (clear(mid))
    return { m: mid, aCross, bCross, blocked: false, gapLo, gapHi }
  const span = gapHi - gapLo
  for (let step = 16; step < span; step += 16) {
    for (const m of [mid + step, mid - step]) {
      if (m <= gapLo + 4 || m >= gapHi - 4) continue
      if (clear(m)) return { m, aCross, bCross, blocked: true, gapLo, gapHi }
    }
  }
  return null
}

// ── Density-adaptive banding ────────────────────────────────────────────────
// One lane per cable crossing a tier gap. The gap between two ranks must be
// wide enough for every cable to have its own line (plus stub clearance) -
// fixed distances collapse the moment a device carries dozens of links.
const LANE_PITCH = 10
const GAP_HEADROOM = 44
const BAND_TOL = 40 // main-axis start positions within this cluster into one band

interface Bands {
  bandOf: Map<string, number>
  list: { lo: number; hi: number }[]
}

/** Cluster rectangles into main-axis bands (rank rows/columns). */
function bandize(rect: Map<string, Rect>, tb: boolean): Bands {
  const items = [...rect.entries()]
    .map(([id, r]) => ({
      id,
      lo: tb ? r.y : r.x,
      hi: tb ? r.y + r.h : r.x + r.w,
    }))
    .sort((a, b) => a.lo - b.lo)
  const bandOf = new Map<string, number>()
  const list: { lo: number; hi: number }[] = []
  for (const it of items) {
    const cur = list[list.length - 1]
    if (!cur || it.lo > cur.lo + BAND_TOL) list.push({ lo: it.lo, hi: it.hi })
    else cur.hi = Math.max(cur.hi, it.hi)
    bandOf.set(it.id, list.length - 1)
  }
  return { bandOf, list }
}

/** Widen every inter-band gap to fit its cable lanes (never shrink - Level
 * distances and panel lanes keep whatever extra room they already made).
 * Pinned (user-dragged / saved) nodes are left exactly where they are. */
function respaceBands(
  laid: Node[],
  edges: Edge[],
  sizeOf: (id: string) => { width: number; height: number },
  tb: boolean,
  pinned?: Set<string>
): Node[] {
  const rect = new Map<string, Rect>()
  for (const n of laid) {
    if (pinned?.has(n.id)) continue
    const s = sizeOf(n.id)
    rect.set(n.id, { x: n.position.x, y: n.position.y, w: s.width, h: s.height })
  }
  if (rect.size < 2) return laid
  const { bandOf, list } = bandize(rect, tb)
  if (list.length < 2) return laid
  // Lane demand per gap: only cables that actually occupy a lane - parallel
  // runs between one pair, and long spans routed through the gap. A fan of
  // singleton cables draws plain direct lines and needs no lane space.
  const lanes = new Array(list.length - 1).fill(0)
  const pairCount = new Map<string, { g: number; n: number }>()
  for (const e of edges) {
    const a = bandOf.get(e.source)
    const b = bandOf.get(e.target)
    if (a === undefined || b === undefined || a === b) continue
    if (Math.abs(a - b) === 1) {
      const pk = [e.source, e.target].sort().join("|")
      const ent = pairCount.get(pk) ?? { g: Math.min(a, b), n: 0 }
      ent.n += 1
      pairCount.set(pk, ent)
    } else {
      for (let g = Math.min(a, b); g < Math.max(a, b); g++) lanes[g] += 1
    }
  }
  for (const { g, n } of pairCount.values()) if (n > 1) lanes[g] += n
  // Cumulative shift so every gap meets its minimum.
  const shift = new Array(list.length).fill(0)
  for (let g = 0; g < list.length - 1; g++) {
    const current = list[g + 1].lo + shift[g + 1] - (list[g].hi + shift[g])
    const required = GAP_HEADROOM + lanes[g] * LANE_PITCH
    const extra = Math.max(0, required - current)
    for (let b = g + 1; b < list.length; b++) shift[b] += extra
  }
  if (shift.every((s) => s === 0)) return laid
  return laid.map((n) => {
    const band = bandOf.get(n.id)
    if (band === undefined || !shift[band]) return n
    return {
      ...n,
      position: tb
        ? { x: n.position.x, y: n.position.y + shift[band] }
        : { x: n.position.x + shift[band], y: n.position.y },
    }
  })
}

/** Node-avoiding routes for every edge, from the laid-out node rectangles.
 * Cables sharing a channel are FANNED OUT - each gets its own parallel line so
 * a bundle doesn't collapse onto one shared run. */
function computeWaypoints(
  laid: Node[],
  edges: Edge[],
  sizeOf: (id: string) => { width: number; height: number },
  tb: boolean,
  lanes = true
): Map<string, [number, number][]> {
  const rect = new Map<string, Rect>()
  for (const n of laid) {
    const s = sizeOf(n.id)
    rect.set(n.id, {
      x: n.position.x,
      y: n.position.y,
      w: s.width,
      h: s.height,
    })
  }
  const all = [...rect.entries()]
  type R = { key: string; ch: Channel; staggered: boolean }
  const routes: R[] = []
  // Detour routes (no channel existed - endpoints aligned with a card dead
  // between them): fixed waypoints around the side, not fan-out managed.
  const detours = new Map<string, [number, number][]>()
  // Deterministic lanes (adjacent-band edges): one line per cable.
  const laned = new Map<string, [number, number][]>()

  const cross = (r: Rect) => (tb ? r.x + r.w / 2 : r.y + r.h / 2)
  const { bandOf, list: bandList } = bandize(rect, tb)
  // Bucket adjacent-band edges per gap; everything else keeps the scanned
  // channel route (+ side detour) - lanes only make sense between two
  // consecutive ranks, which is where the dense combs live.
  type LaneEdge = { key: string; pair: string; a: Rect; b: Rect; mid: number }
  const gapBuckets = new Map<number, LaneEdge[]>()
  const scanned: Edge[] = []
  for (const e of edges) {
    const a = rect.get(e.source)
    const b = rect.get(e.target)
    if (!a || !b) continue
    const ba = bandOf.get(e.source)
    const bb = bandOf.get(e.target)
    if (ba !== undefined && bb !== undefined && Math.abs(ba - bb) === 1) {
      const g = Math.min(ba, bb)
      const item = {
        key: e.id,
        pair: [e.source, e.target].sort().join("|"),
        a,
        b,
        mid: (cross(a) + cross(b)) / 2,
      }
      ;(gapBuckets.get(g) ?? gapBuckets.set(g, []).get(g)!).push(item)
      continue
    }
    if (ba !== undefined && bb !== undefined && ba === bb) continue
    scanned.push(e)
  }
  for (const [g, bucket] of gapBuckets) {
    const gapLo = bandList[g].hi + 10
    const gapHi = bandList[g + 1].lo - 10
    const avail = Math.max(gapHi - gapLo, 8)
    // Cards squatting inside this gap (panel lanes)? Fall back to the
    // obstacle-scanned router for its edges - lanes assume a clear gap.
    const dirty = [...bandOf.entries()].some(([id, bd]) => {
      void bd
      const r = rect.get(id)!
      const lo = tb ? r.y : r.x
      const hi = tb ? r.y + r.h : r.x + r.w
      return lo > gapLo && hi < gapHi
    })
    if (dirty) {
      for (const it of bucket)
        scanned.push(edges.find((e) => e.id === it.key)!)
      continue
    }
    // Lanes are for cables that genuinely run PARALLEL - several between the
    // same two cards. A hub fanning out to many distinct leaves is drawn
    // plain: its stub order matches the leaf order (portOrder), so direct
    // lines don't cross, and forcing each onto a full-width lane turns the
    // fan into a solid wall of lines.
    const byPair = new Map<string, LaneEdge[]>()
    for (const it of bucket) {
      ;(byPair.get(it.pair) ?? byPair.set(it.pair, []).get(it.pair)!).push(it)
    }
    // A plain single cable still may not draw THROUGH a card sitting in its
    // corridor - hand those to the scanned router.
    for (const group of byPair.values()) {
      if (lanes && group.length > 1) continue
      for (const it of group) {
        const obstacles = all
          .filter(([id2]) => {
            const r = rect.get(id2)!
            return r !== it.a && r !== it.b
          })
          .map(([, r]) => r)
        if (corridorBlocked(it.a, it.b, obstacles, tb))
          scanned.push(edges.find((e) => e.id === it.key)!)
      }
    }
    const parallel = lanes
      ? [...byPair.values()].filter((g2) => g2.length > 1)
      : []
    const total = parallel.reduce((s, g2) => s + g2.length, 0)
    if (!total) continue
    parallel.sort(
      (x, y) =>
        x.reduce((s, it) => s + it.mid, 0) / x.length -
        y.reduce((s, it) => s + it.mid, 0) / y.length
    )
    const pitch = Math.max(4, Math.min(LANE_PITCH, avail / Math.max(total, 1)))
    const start = (gapLo + gapHi) / 2 - ((total - 1) / 2) * pitch
    let lane = 0
    for (const group of parallel) {
      group.sort((x, y) => x.mid - y.mid)
      for (const it of group) {
        const m = Math.min(gapHi, Math.max(gapLo, start + lane * pitch))
        lane += 1
        const aC = cross(it.a)
        const bC = cross(it.b)
        laned.set(
          it.key,
          tb
            ? [
                [aC, m],
                [bC, m],
              ]
            : [
                [m, aC],
                [m, bC],
              ]
        )
      }
    }
  }

  for (const e of scanned) {
    const a = rect.get(e.source)
    const b = rect.get(e.target)
    if (!a || !b) continue
    const obstacles = all
      .filter(([id]) => id !== e.source && id !== e.target)
      .map(([, r]) => r)
    const ch = channelRoute(a, b, obstacles, tb)
    if (ch) {
      routes.push({ key: e.id, ch, staggered: false })
      continue
    }
    const det = sideDetour(a, b, obstacles, tb)
    if (det) detours.set(e.id, det)
  }
  // Fan out bundles: cables whose channels fall in the same band AND overlap on
  // the cross axis are spread apart so each reads as its own line.
  const BAND = 28
  const STAGGER = 15
  const buckets = new Map<number, R[]>()
  for (const r of routes) {
    const k = Math.round(r.ch.m / BAND)
    ;(buckets.get(k) ?? buckets.set(k, []).get(k)!).push(r)
  }
  for (const group of buckets.values()) {
    if (group.length < 3) continue
    group.sort(
      (x, y) => x.ch.aCross + x.ch.bCross - (y.ch.aCross + y.ch.bCross)
    )
    const centre = (group.length - 1) / 2
    group.forEach((r, i) => {
      // Clamp the fan-out into the gap so it can't push a cable back into a
      // card (the channel must stay between the two facing edges).
      const raw = r.ch.m + (i - centre) * STAGGER
      r.ch.m = Math.max(r.ch.gapLo + 3, Math.min(r.ch.gapHi - 3, raw))
      r.staggered = true
    })
  }
  const wp = new Map<string, [number, number][]>()
  for (const { key, ch, staggered } of routes) {
    // A single clear cable keeps its plain smoothstep; only bent-around-a-card
    // or fanned-out cables need explicit waypoints.
    if (!ch.blocked && !staggered) continue
    const p1: [number, number] = tb ? [ch.aCross, ch.m] : [ch.m, ch.aCross]
    const p2: [number, number] = tb ? [ch.bCross, ch.m] : [ch.m, ch.bCross]
    wp.set(key, [p1, p2])
  }
  for (const [key, pts] of laned) wp.set(key, pts)
  for (const [key, pts] of detours) wp.set(key, pts)
  return wp
}

/**
 * Around-the-side route for the case the channel search can't solve: source
 * and target aligned on the cross axis with a card sitting DEAD BETWEEN them
 * (three stacked sites, say) - a straight line would run through the middle
 * card and hide the cable. Returns two waypoints sharing the CROSS coordinate
 * just past the blocking cards, which RoutedEdge renders as source → out to
 * the side → along → back into the target.
 */
/** Any card sitting in the straight corridor between a and b? */
function corridorBlocked(
  a: Rect,
  b: Rect,
  obstacles: Rect[],
  tb: boolean
): boolean {
  const mainLo = tb
    ? Math.min(a.y + a.h, b.y + b.h)
    : Math.min(a.x + a.w, b.x + b.w)
  const mainHi = tb ? Math.max(a.y, b.y) : Math.max(a.x, b.x)
  if (mainHi - mainLo < 8) return false
  const aCross = tb ? a.x + a.w / 2 : a.y + a.h / 2
  const bCross = tb ? b.x + b.w / 2 : b.y + b.h / 2
  const laneLo = Math.min(aCross, bCross) - 12
  const laneHi = Math.max(aCross, bCross) + 12
  return obstacles.some((o) => {
    const m1 = tb ? o.y : o.x
    const m2 = tb ? o.y + o.h : o.x + o.w
    const c1 = tb ? o.x : o.y
    const c2 = tb ? o.x + o.w : o.y + o.h
    return m2 > mainLo && m1 < mainHi && c2 > laneLo && c1 < laneHi
  })
}

function sideDetour(
  a: Rect,
  b: Rect,
  obstacles: Rect[],
  tb: boolean
): [number, number][] | null {
  const mainLo = tb
    ? Math.min(a.y + a.h, b.y + b.h)
    : Math.min(a.x + a.w, b.x + b.w)
  const mainHi = tb ? Math.max(a.y, b.y) : Math.max(a.x, b.x)
  if (mainHi - mainLo < 8) return null // same tier - nothing to route around
  const aCross = tb ? a.x + a.w / 2 : a.y + a.h / 2
  const bCross = tb ? b.x + b.w / 2 : b.y + b.h / 2
  const laneLo = Math.min(aCross, bCross) - 12
  const laneHi = Math.max(aCross, bCross) + 12
  // Cards inside the corridor the straight line would cross.
  const between = obstacles.filter((o) => {
    const m1 = tb ? o.y : o.x
    const m2 = tb ? o.y + o.h : o.x + o.w
    const c1 = tb ? o.x : o.y
    const c2 = tb ? o.x + o.w : o.y + o.h
    return m2 > mainLo && m1 < mainHi && c2 > laneLo && c1 < laneHi
  })
  if (!between.length) return null
  const CLEAR = 36
  const left = Math.min(...between.map((o) => (tb ? o.x : o.y))) - CLEAR
  const right =
    Math.max(...between.map((o) => (tb ? o.x + o.w : o.y + o.h))) + CLEAR
  const mid = (aCross + bCross) / 2
  const detour = Math.abs(mid - left) <= Math.abs(right - mid) ? left : right
  const aMain = tb ? a.y + a.h / 2 : a.x + a.w / 2
  const bMain = tb ? b.y + b.h / 2 : b.x + b.w / 2
  return tb
    ? [
        [detour, aMain],
        [detour, bMain],
      ]
    : [
        [aMain, detour],
        [bMain, detour],
      ]
}

/** Recompute node-avoiding routes for live (e.g. just-dragged) node positions.
 * Sizes come from each node's stencil data, so no dagre pass is needed. */
export function edgeWaypoints(
  nodes: Node[],
  edges: Edge[],
  direction: "LR" | "TB",
  /** false = obstacle avoidance only, no parallel-run lanes (hierarchy:
   * aligned parallel cables are already separated by their chips). */
  lanes = true
): Map<string, [number, number][]> {
  return computeWaypoints(
    nodes,
    edges,
    (id) => {
      const n = nodes.find((x) => x.id === id)
      if (!n) return { width: 0, height: 0 }
      // Fixed-size card types size themselves; stencil cards by their ports.
      if (n.type === "flat") {
        const d = n.data as Parameters<typeof flatHeight>[0] & { name?: string }
        return { width: flatWidth(d), height: flatHeight(d) }
      }
      if (n.type === "sitegroup") return { width: GROUP_W, height: GROUP_H }
      if (n.type === "hier") {
        const d = n.data as { name?: string; portSpan?: number }
        return { width: hierarchyWidth(d), height: hierHeight(d.portSpan ?? 0) }
      }
      return stencilSize(n.data as StencilData)
    },
    direction === "TB",
    lanes
  )
}

/**
 * Cable routes for the hierarchy view, anchored to the PORTS rather than the
 * cards. The generic router reasons about card centres, which is right for
 * stencil cards but wrong here: a hierarchy card is as tall as its whole port
 * list, so a channel at its centre drags an aligned cable hundreds of pixels
 * off its own port and the run stops reading as a connection at all.
 *
 * A cable gets waypoints only when a card genuinely sits in its corridor AND
 * there is a clear vertical street to cross in - it then leaves its port
 * level, crosses the street, and arrives at its peer's port level. Anything
 * else stays straight, which is the entire point of aligning the ports.
 */
export function hierarchyWaypoints(
  nodes: Node[],
  edges: Edge[],
  portPos: Map<string, Record<string, HierPortPos>>
): Map<string, [number, number][]> {
  const rect = new Map<string, Rect>()
  for (const n of nodes) {
    const d = n.data as { name?: string; portSpan?: number }
    rect.set(n.id, {
      x: n.position.x,
      y: n.position.y,
      w: hierarchyWidth(d),
      h: hierHeight(d.portSpan ?? 0),
    })
  }
  /** Where a port's cable actually leaves its card. */
  const anchor = (id: string, port: string): [number, number] | null => {
    const r = rect.get(id)
    const p = portPos.get(id)?.[port]
    if (!r || !p) return null
    return [p.side === "R" ? r.x + r.w : r.x, r.y + p.off]
  }
  const MIN_STREET = 26
  const PAD = 3
  const out = new Map<string, [number, number][]>()
  for (const e of edges) {
    const d = e.data as
      | { sem?: string; baseS?: string; baseT?: string }
      | undefined
    if (d?.sem !== "cable" || !d.baseS || !d.baseT) continue
    const a = anchor(e.source, d.baseS)
    const b = anchor(e.target, d.baseT)
    if (!a || !b) continue
    const lo = Math.min(a[0], b[0])
    const hi = Math.max(a[0], b[0])
    if (hi - lo < 40) continue
    const others: Rect[] = []
    for (const [id, r] of rect) {
      if (id !== e.source && id !== e.target) others.push(r)
    }
    const hits = (x0: number, x1: number, y0: number, y1: number) =>
      others.some(
        (r) =>
          r.x < Math.max(x0, x1) - PAD &&
          r.x + r.w > Math.min(x0, x1) + PAD &&
          r.y < Math.max(y0, y1) - PAD &&
          r.y + r.h > Math.min(y0, y1) + PAD
      )
    // Nothing in the way at all: the straight line the aligned ports were
    // laid out for.
    if (!hits(a[0], b[0], a[1], b[1])) continue
    // The cable has to change level anyway, so pick WHERE to do it: a
    // vertical street clear of cards, with both horizontal legs clear too.
    // Streets are the x-gaps left by the cards standing across the run.
    const spans = others
      .filter(
        (r) =>
          r.x + r.w > lo &&
          r.x < hi &&
          r.y + r.h > Math.min(a[1], b[1]) - PAD &&
          r.y < Math.max(a[1], b[1]) + PAD
      )
      .map((r) => [Math.max(lo, r.x), Math.min(hi, r.x + r.w)])
      .sort((p, q) => p[0] - q[0])
    const candidates: number[] = []
    let edge = lo
    for (const [s0, s1] of spans) {
      if (s0 - edge >= MIN_STREET) candidates.push((edge + s0) / 2)
      edge = Math.max(edge, s1)
    }
    if (hi - edge >= MIN_STREET) candidates.push((edge + hi) / 2)
    const mid = (lo + hi) / 2
    candidates.sort((p, q) => Math.abs(p - mid) - Math.abs(q - mid))
    // Keep only a street whose whole path is actually clear - otherwise the
    // cable would just meet the next card instead of the first one.
    const x = candidates.find(
      (cx) =>
        !hits(a[0], cx, a[1], a[1]) &&
        !hits(cx, b[0], b[1], b[1]) &&
        !hits(cx, cx, a[1], b[1])
    )
    // No clear street (two ports aligned behind a card, say): leave the cable
    // straight. Passing behind one card still reads as a connection; a detour
    // around a full-height card does not.
    if (x === undefined) continue
    out.set(e.id, [
      [x, a[1]],
      [x, b[1]],
    ])
  }
  return out
}

// ── Hierarchy (port-aligned) layout ─────────────────────────────────────────
// The NetBox-style renderer: tall cards whose port chips sit at the height
// of their PEER's port, so cables run near-straight. dagre gives ranks;
// relaxation sweeps pull ports (and their cards) toward their peers.
export const HIER_PORT_PITCH = 18
export const HIER_HEADER = 30
export const HIER_PAD = 12
export const HIER_MIN_SPAN = 60
const HIER_NODE_GAP = 36

export interface HierPortPos {
  side: "L" | "R"
  off: number
}

export function hierHeight(span: number): number {
  return HIER_HEADER + 2 * HIER_PAD + Math.max(HIER_MIN_SPAN, span)
}

export function hierarchyWidth(d: { name?: string }): number {
  return Math.max(190, Math.min(300, 70 + (d.name?.length ?? 0) * 6.6))
}

export interface HierResult {
  nodes: Node[]
  portPos: Map<string, Record<string, HierPortPos>>
  span: Map<string, number>
  sides: Map<string, Record<string, "L" | "R">>
}

export function layoutHierarchy(
  nodes: Node[],
  edges: Edge[],
  widthOf: (n: Node) => number,
  positions?: Record<string, [number, number]>
): HierResult {
  const pinned = positions ? new Set(Object.keys(positions)) : undefined
  // Port lists per node from the cable edges (base port names ride on the
  // edge handles at this stage).
  type P = { name: string; peer: string; peerPort: string }
  const ports = new Map<string, P[]>()
  const addPort = (id: string, name: string, peer: string, peerPort: string) => {
    const list = ports.get(id) ?? ports.set(id, []).get(id)!
    if (!list.some((x) => x.name === name)) list.push({ name, peer, peerPort })
  }
  for (const e of edges) {
    const s = e.sourceHandle ? String(e.sourceHandle) : null
    const t = e.targetHandle ? String(e.targetHandle) : null
    if (!s || !t) continue
    addPort(e.source, s, e.target, t)
    addPort(e.target, t, e.source, s)
  }

  // Provisional dagre pass for ranks (x) and an initial vertical order.
  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({
    rankdir: "LR",
    nodesep: 40,
    edgesep: 12,
    ranksep: 170,
    ranker: "network-simplex",
    align: "UL",
  })
  const provH = (id: string) =>
    hierHeight((ports.get(id)?.length ?? 0) * HIER_PORT_PITCH)
  for (const n of nodes) g.setNode(n.id, { width: widthOf(n), height: provH(n.id) })
  for (const e of edges) g.setEdge(e.source, e.target, { weight: 1, minlen: 1 })
  dagre.layout(g)

  const x = new Map<string, number>()
  const top = new Map<string, number>()
  for (const n of nodes) {
    const pin = positions?.[n.id]
    if (pin) {
      x.set(n.id, pin[0])
      top.set(n.id, pin[1])
      continue
    }
    const d = g.node(n.id)
    x.set(n.id, d.x - d.width / 2)
    top.set(n.id, d.y - d.height / 2)
  }

  // Port sides from rank positions; absolute port centers, initialised
  // stacked in peer order.
  const sides = new Map<string, Record<string, "L" | "R">>()
  const portY = new Map<string, number>() // "node:port" → absolute y
  for (const [id, list] of ports) {
    const sd: Record<string, "L" | "R"> = {}
    for (const pt of list)
      sd[pt.name] = (x.get(pt.peer) ?? 0) >= (x.get(id) ?? 0) ? "R" : "L"
    sides.set(id, sd)
    list.sort(
      (a, b) => (top.get(a.peer) ?? 0) - (top.get(b.peer) ?? 0)
    )
    list.forEach((pt, i) =>
      portY.set(`${id}:${pt.name}`, (top.get(id) ?? 0) + HIER_HEADER + HIER_PAD + i * HIER_PORT_PITCH)
    )
  }

  const span = new Map<string, number>()
  const place = (id: string) => {
    // Stack this node's ports at their targets (peer port y), min pitch
    // apart; the card follows its ports.
    const list = ports.get(id)
    if (!list || !list.length) return
    const targets = list
      .map((pt) => ({
        pt,
        t: portY.get(`${pt.peer}:${pt.peerPort}`) ?? top.get(pt.peer) ?? 0,
      }))
      .sort((a, b) => a.t - b.t)
    let prev = -Infinity
    const abs: { pt: P; y: number }[] = []
    for (const { pt, t } of targets) {
      const y = Math.max(t, prev + HIER_PORT_PITCH)
      abs.push({ pt, y })
      prev = y
    }
    const first = abs[0].y
    const last = abs[abs.length - 1].y
    if (!pinned?.has(id)) top.set(id, first - HIER_HEADER - HIER_PAD)
    const base = top.get(id)!
    // Pinned cards keep their position - ports re-stack inside from the top.
    let off = base + HIER_HEADER + HIER_PAD
    for (const { pt, y } of abs) {
      const yy = pinned?.has(id) ? off : y
      portY.set(`${id}:${pt.name}`, yy)
      off += HIER_PORT_PITCH
    }
    span.set(id, last - first)
  }

  const order = [...nodes].sort((a, b) => (x.get(a.id) ?? 0) - (x.get(b.id) ?? 0))
  for (let sweep = 0; sweep < 3; sweep++) {
    const seq = sweep % 2 === 0 ? order : [...order].reverse()
    for (const n of seq) place(n.id)
    // Intra-rank collision resolve: push overlapping cards down, ports along.
    const ranks = new Map<number, Node[]>()
    for (const n of nodes) {
      const r = Math.round((x.get(n.id) ?? 0) / 40)
      ;(ranks.get(r) ?? ranks.set(r, []).get(r)!).push(n)
    }
    for (const group of ranks.values()) {
      group.sort((a, b) => (top.get(a.id) ?? 0) - (top.get(b.id) ?? 0))
      let bottom = -Infinity
      for (const n of group) {
        if (pinned?.has(n.id)) {
          bottom = Math.max(bottom, (top.get(n.id) ?? 0) + hierHeight(span.get(n.id) ?? 0))
          continue
        }
        let t = top.get(n.id) ?? 0
        if (t < bottom + HIER_NODE_GAP) {
          const delta = bottom + HIER_NODE_GAP - t
          t += delta
          top.set(n.id, t)
          for (const pt of ports.get(n.id) ?? [])
            portY.set(`${n.id}:${pt.name}`, (portY.get(`${n.id}:${pt.name}`) ?? 0) + delta)
        }
        bottom = t + hierHeight(span.get(n.id) ?? 0)
      }
    }
  }

  // Final convergence: cards are settled - now ONLY the ports move, chasing
  // their peers until pairs meet face to face (the sweeps above move cards
  // and collide, which leaves residual offsets even with room to spare).
  for (let f = 0; f < 3; f++) {
    const seq = f % 2 === 0 ? order : [...order].reverse()
    for (const n of seq) {
      const list = ports.get(n.id)
      if (!list?.length) continue
      const base = (top.get(n.id) ?? 0) + HIER_HEADER + HIER_PAD
      const targets = list
        .map((pt) => ({
          pt,
          t:
            portY.get(`${pt.peer}:${pt.peerPort}`) ??
            top.get(pt.peer) ??
            0,
        }))
        .sort((a2, b2) => a2.t - b2.t)
      let prev = base - HIER_PORT_PITCH
      for (const { pt, t } of targets) {
        const y = Math.max(base, t, prev + HIER_PORT_PITCH)
        portY.set(`${n.id}:${pt.name}`, y)
        prev = y
      }
      span.set(n.id, prev - base)
    }
  }

  const portPos = new Map<string, Record<string, HierPortPos>>()
  for (const [id, list] of ports) {
    const base = top.get(id) ?? 0
    const rec: Record<string, HierPortPos> = {}
    for (const pt of list)
      rec[pt.name] = {
        side: sides.get(id)![pt.name],
        off: (portY.get(`${id}:${pt.name}`) ?? base) - base,
      }
    portPos.set(id, rec)
  }
  let laid = nodes.map((n) => ({
    ...n,
    position: { x: x.get(n.id) ?? 0, y: top.get(n.id) ?? 0 },
  }))
  laid = packComponents(
    laid,
    edges,
    (n) => ({ width: widthOf(n), height: hierHeight(span.get(n.id) ?? 0) }),
    pinned
  )
  return { nodes: laid, portPos, span, sides }
}

/** Re-align hierarchy port chips to the CURRENT card positions after a
 * drag - every card stays where the user put it; only the chips re-stack
 * toward their peers (both sides of every moved cable). */
export function realignHierPorts(
  nodes: Node[],
  edges: Edge[]
): {
  portPos: Map<string, Record<string, HierPortPos>>
  span: Map<string, number>
  sides: Map<string, Record<string, "L" | "R">>
} {
  type P = { name: string; peer: string; peerPort: string }
  const ports = new Map<string, P[]>()
  const add = (id: string, name: string, peer: string, peerPort: string) => {
    const list = ports.get(id) ?? ports.set(id, []).get(id)!
    if (!list.some((x) => x.name === name)) list.push({ name, peer, peerPort })
  }
  for (const e of edges) {
    const d = e.data as { baseS?: string; baseT?: string } | undefined
    if (!d?.baseS || !d?.baseT) continue
    add(e.source, d.baseS, e.target, d.baseT)
    add(e.target, d.baseT, e.source, d.baseS)
  }
  const pos = new Map(nodes.map((n) => [n.id, n.position]))
  const sides = new Map<string, Record<string, "L" | "R">>()
  const portY = new Map<string, number>()
  for (const [id, list] of ports) {
    const sd: Record<string, "L" | "R"> = {}
    for (const pt of list)
      sd[pt.name] =
        (pos.get(pt.peer)?.x ?? 0) >= (pos.get(id)?.x ?? 0) ? "R" : "L"
    sides.set(id, sd)
    list.forEach((pt, i) =>
      portY.set(
        `${id}:${pt.name}`,
        (pos.get(id)?.y ?? 0) + HIER_HEADER + HIER_PAD + i * HIER_PORT_PITCH
      )
    )
  }
  const span = new Map<string, number>()
  for (let sweep = 0; sweep < 2; sweep++) {
    for (const [id, list] of ports) {
      const base = (pos.get(id)?.y ?? 0) + HIER_HEADER + HIER_PAD
      const targets = list
        .map((pt) => ({
          pt,
          t: portY.get(`${pt.peer}:${pt.peerPort}`) ?? pos.get(pt.peer)?.y ?? 0,
        }))
        .sort((a2, b2) => a2.t - b2.t)
      let prev = base - HIER_PORT_PITCH
      for (const { pt, t } of targets) {
        const y = Math.max(base, t, prev + HIER_PORT_PITCH)
        portY.set(`${id}:${pt.name}`, y)
        prev = y
      }
      span.set(id, prev - base)
    }
  }
  const portPos = new Map<string, Record<string, HierPortPos>>()
  for (const [id, list] of ports) {
    const base = pos.get(id)?.y ?? 0
    const rec: Record<string, HierPortPos> = {}
    for (const pt of list)
      rec[pt.name] = {
        side: sides.get(id)![pt.name],
        off: (portY.get(`${id}:${pt.name}`) ?? base) - base,
      }
    portPos.set(id, rec)
  }
  return { portPos, span, sides }
}

// ── Component packing ───────────────────────────────────────────────────────
// Dagre strings disconnected islands along one axis, leaving half the canvas
// empty and the rest sprawling. Pack the islands into rows instead, aiming
// for a roughly viewport-shaped composition.
const PACK_PAD = 90

function packComponents(
  laid: Node[],
  edges: Edge[],
  boxOf: (n: Node) => { width: number; height: number } | null,
  pinned?: Set<string>
): Node[] {
  // Union-find over every edge (leaf edges included - a grid moves with
  // its hub).
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    let r = x
    while (parent.get(r) !== r) r = parent.get(r)!
    parent.set(x, r)
    return r
  }
  for (const n of laid) parent.set(n.id, n.id)
  for (const e of edges) {
    if (!parent.has(e.source) || !parent.has(e.target)) continue
    parent.set(find(e.source), find(e.target))
  }
  const comps = new Map<string, Node[]>()
  for (const n of laid) {
    const r = find(n.id)
    ;(comps.get(r) ?? comps.set(r, []).get(r)!).push(n)
  }
  if (comps.size < 2) return laid
  type Box = {
    nodes: Node[]
    x: number
    y: number
    w: number
    h: number
    frozen: boolean
  }
  const boxes: Box[] = []
  for (const members of comps.values()) {
    let x1 = Infinity
    let y1 = Infinity
    let x2 = -Infinity
    let y2 = -Infinity
    let frozen = false
    for (const n of members) {
      if (pinned?.has(n.id)) frozen = true
      const s = boxOf(n)
      if (!s) continue // grid leaf - covered by its hub's inflated box
      x1 = Math.min(x1, n.position.x)
      y1 = Math.min(y1, n.position.y)
      x2 = Math.max(x2, n.position.x + s.width)
      y2 = Math.max(y2, n.position.y + s.height)
    }
    if (!isFinite(x1)) continue
    boxes.push({ nodes: members, x: x1, y: y1, w: x2 - x1, h: y2 - y1, frozen })
  }
  // A pinned node anywhere freezes the whole packing - the user owns the
  // arrangement.
  if (boxes.some((b) => b.frozen)) return laid
  const area = boxes.reduce((s, b) => s + (b.w + PACK_PAD) * (b.h + PACK_PAD), 0)
  const rowW = Math.max(1800, Math.sqrt(area * 1.8), ...boxes.map((b) => b.w))
  boxes.sort((a2, b2) => b2.h - a2.h)
  const moved = new Map<string, { dx: number; dy: number }>()
  let cx = 0
  let cy = 0
  let rowH = 0
  for (const b of boxes) {
    if (cx > 0 && cx + b.w > rowW) {
      cx = 0
      cy += rowH + PACK_PAD
      rowH = 0
    }
    const dx = cx - b.x
    const dy = cy - b.y
    for (const n of b.nodes) moved.set(n.id, { dx, dy })
    cx += b.w + PACK_PAD
    rowH = Math.max(rowH, b.h)
  }
  return laid.map((n) => {
    const d = moved.get(n.id)
    return d
      ? {
          ...n,
          position: { x: n.position.x + d.dx, y: n.position.y + d.dy },
        }
      : n
  })
}

// ── Leaf grids ──────────────────────────────────────────────────────────────
// A hub with many single-cable neighbours (an aggregation switch and its 96
// blades) must not string them out along one endless rank. Its leaves leave
// the rank system entirely and stack in a compact grid beside the hub -
// the visio/NetBox look - with each cable dropping down a per-column
// "street" on its own small lane. Structural layouts only; Levels places
// every role by its tier.
const LEAF_GRID_MIN = 2
const STREET_W = 22
const GRID_GAP = 36
const CELL_GAP = 10

interface LeafClusters {
  byHub: Map<string, string[]>
  leafSet: Set<string>
  leafEdgeIds: Set<string>
  edgeOf: Map<string, string>
}

function findLeafClusters(
  edges: Edge[],
  pinnedIds?: Set<string>
): LeafClusters {
  const deg = new Map<string, number>()
  for (const e of edges) {
    deg.set(e.source, (deg.get(e.source) ?? 0) + 1)
    deg.set(e.target, (deg.get(e.target) ?? 0) + 1)
  }
  const nbrOf = new Map<string, { hub: string; edgeId: string }>()
  for (const e of edges) {
    if (deg.get(e.source) === 1)
      nbrOf.set(e.source, { hub: e.target, edgeId: e.id })
    if (deg.get(e.target) === 1)
      nbrOf.set(e.target, { hub: e.source, edgeId: e.id })
  }
  const byHub = new Map<string, string[]>()
  const edgeOf = new Map<string, string>()
  for (const [leaf, { hub, edgeId }] of nbrOf) {
    if (pinnedIds?.has(leaf)) continue
    if (deg.get(hub) === 1) continue // two-node island - nothing to stack
    ;(byHub.get(hub) ?? byHub.set(hub, []).get(hub)!).push(leaf)
    edgeOf.set(leaf, edgeId)
  }
  const leafSet = new Set<string>()
  const leafEdgeIds = new Set<string>()
  for (const [hub, leaves] of [...byHub]) {
    if (leaves.length < LEAF_GRID_MIN || pinnedIds?.has(hub)) {
      byHub.delete(hub)
      continue
    }
    leaves.sort(natural)
    for (const l of leaves) {
      leafSet.add(l)
      leafEdgeIds.add(edgeOf.get(l)!)
    }
  }
  for (const l of edgeOf.keys()) if (!leafSet.has(l)) edgeOf.delete(l)
  return { byHub, leafSet, leafEdgeIds, edgeOf }
}

export function layoutNodes(
  nodes: Node[],
  edges: Edge[],
  positions?: Record<string, [number, number]>,
  direction: "LR" | "TB" = "LR",
  /** node id → role tier; when present, overrides the main-axis so nodes
   * stack strictly by role (left→right in LR, top→bottom in TB). */
  levels?: Map<string, number>,
  /** main-axis coordinate per tier index (from the Level distances); when
   * absent, tiers use a uniform gap. */
  mainOffsets?: number[],
  /** Node dimensions; defaults to the stencil card. The Flat view passes a
   * fixed-size function so its chips lay out tight. */
  sizeOfNode?: (n: Node) => { width: number; height: number }
): LayoutResult {
  const sizer =
    sizeOfNode ?? ((n: Node) => stencilSize(n.data as StencilData))
  // A custom sizer means small fixed chips (the Flat view) - tighten the
  // gaps so hundreds of nodes stay compact; stencil cards keep the roomy
  // spacing their port-anchored cables need.
  const compact = !!sizeOfNode
  const tbDir = direction === "TB"
  const pinnedIds = positions
    ? new Set(Object.keys(positions))
    : undefined
  // Leaf grids (structural mode only - Levels owns every tier placement).
  const clusters: LeafClusters = levels
    ? {
        byHub: new Map(),
        leafSet: new Set(),
        leafEdgeIds: new Set(),
        edgeOf: new Map(),
      }
    : findLeafClusters(edges, pinnedIds)
  const byId = new Map(nodes.map((n) => [n.id, n]))
  // Grid geometry per hub, shared by size inflation and placement.
  const gridMeta = new Map<
    string,
    {
      crossPitch: number
      mainPitch: number
      across: number
      deep: number
      crossExtent: number
      mainExtent: number
    }
  >()
  for (const [hubId, leaves] of clusters.byHub) {
    let crossCell = 0
    let mainCell = 0
    for (const lid of leaves) {
      const s = sizer(byId.get(lid)!)
      crossCell = Math.max(crossCell, tbDir ? s.width : s.height)
      mainCell = Math.max(mainCell, tbDir ? s.height : s.width)
    }
    const crossPitch = crossCell + CELL_GAP + STREET_W
    const mainPitch = mainCell + CELL_GAP
    // Columns match the hub bar's own width (a dense hub renders as a long
    // faceplate), so cables drop nearly straight; small hubs fall back to a
    // ~2.5:1 grid that hugs the card.
    const hubCard0 = sizer(byId.get(hubId)!)
    const barCross = tbDir ? hubCard0.width : hubCard0.height
    const across = Math.max(
      1,
      Math.min(
        leaves.length,
        Math.max(
          Math.round(barCross / crossPitch),
          Math.ceil(Math.sqrt((2.5 * leaves.length * mainPitch) / crossPitch))
        )
      )
    )
    const deep = Math.ceil(leaves.length / across)
    gridMeta.set(hubId, {
      crossPitch,
      mainPitch,
      across,
      deep,
      crossExtent: across * crossPitch,
      mainExtent: deep * mainPitch,
    })
  }
  // Hubs reserve room for their grid, so ranks and siblings keep clear.
  const inflated = new Map<string, { width: number; height: number }>()
  for (const [hubId, meta] of gridMeta) {
    const card = sizer(byId.get(hubId)!)
    inflated.set(
      hubId,
      tbDir
        ? {
            width: Math.max(card.width, meta.crossExtent),
            height: card.height + GRID_GAP + meta.mainExtent,
          }
        : {
            width: card.width + GRID_GAP + meta.mainExtent,
            height: Math.max(card.height, meta.crossExtent),
          }
    )
  }
  const sizeFor = (n: Node) => inflated.get(n.id) ?? sizer(n)
  const mainEdges = edges.filter((e) => !clusters.leafEdgeIds.has(e.id))

  // Place a laid hub's leaves in its grid + route their street cables.
  const placeLeafGrids = (
    laidArr: Node[]
  ): { out: Node[]; streets: Map<string, [number, number][]> } => {
    const streets = new Map<string, [number, number][]>()
    if (!clusters.byHub.size) return { out: laidArr, streets }
    const laidById = new Map(laidArr.map((n) => [n.id, n]))
    const pos = new Map<string, { x: number; y: number }>()
    for (const [hubId, leaves] of clusters.byHub) {
      const hub = laidById.get(hubId)
      if (!hub) continue
      const meta = gridMeta.get(hubId)!
      const card = sizer(hub)
      const originCross = tbDir ? hub.position.x : hub.position.y
      const originMain =
        (tbDir
          ? hub.position.y + card.height
          : hub.position.x + card.width) + GRID_GAP
      const laneStep = Math.max(
        2,
        Math.min(4, (STREET_W - 10) / Math.max(meta.deep, 1))
      )
      leaves.forEach((lid, i) => {
        const street = Math.floor(i / meta.deep)
        const row = i % meta.deep
        const crossPos = originCross + street * meta.crossPitch + STREET_W
        const mainPos = originMain + row * meta.mainPitch
        pos.set(
          lid,
          tbDir ? { x: crossPos, y: mainPos } : { x: mainPos, y: crossPos }
        )
        const laneCross =
          originCross + street * meta.crossPitch + 4 + row * laneStep
        streets.set(
          clusters.edgeOf.get(lid)!,
          tbDir
            ? [
                [laneCross, 0],
                [laneCross, 100],
              ]
            : [
                [0, laneCross],
                [100, laneCross],
              ]
        )
      })
    }
    return {
      out: laidArr.map((n) => {
        const p2 = pos.get(n.id)
        return p2 ? { ...n, position: p2 } : n
      }),
      streets,
    }
  }
  // A card's cable comb needs shoulder room: scale sibling separation with
  // the densest card's port count instead of a blind constant.
  const maxFan = nodes.reduce(
    (m, n) =>
      Math.max(
        m,
        ((n.data as { ports?: unknown[] }).ports?.length ?? 0)
      ),
    0
  )
  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({
    rankdir: direction,
    // More cross-axis room between siblings + an explicit edge gap so parallel
    // cables get their own lane and are less likely to overlap or be forced to
    // route under a neighbouring card.
    nodesep: compact ? 28 : Math.min(56 + Math.max(0, maxFan - 8) * 3, 240),
    edgesep: compact ? 10 : 18,
    ranksep: compact ? 90 : 130,
    ranker: "network-simplex",
    align: "UL",
  })
  for (const n of nodes) {
    // Card dimensions follow its per-side port split (see stencilSize); the
    // rank axis is set by `direction` on the graph above, not the node size.
    // Grid leaves skip the rank system; their hub reserves their room.
    if (clusters.leafSet.has(n.id)) continue
    const { width, height } = sizeFor(n)
    g.setNode(n.id, { width, height })
  }
  for (const e of mainEdges) {
    g.setEdge(e.source, e.target, { weight: 1, minlen: 1 })
  }
  dagre.layout(g)
  const tb = direction === "TB"
  const sizeOf = (id: string) => g.node(id)

  // Role tiers active: place each tier explicitly - main axis by tier index,
  // cross axis by natural name order with real per-node spacing, so peers
  // never overlap and sort 01, 02, 10. (Manually-pinned nodes still win.)
  if (levels) {
    const mainGap = tb ? LEVEL_GAP_TB : LEVEL_GAP_LR
    // Neighbours - for panel gap detection + cross-axis ordering.
    const nbr = new Map<string, string[]>()
    for (const e of edges) {
      ;(nbr.get(e.source) ?? nbr.set(e.source, []).get(e.source)!).push(
        e.target
      )
      ;(nbr.get(e.target) ?? nbr.set(e.target, []).get(e.target)!).push(
        e.source
      )
    }

    // ── Panel placement from the cable trace ─────────────────────────────
    // A panel (untiered) is seated in a lane BETWEEN the device tiers it links,
    // found by walking the cable chain (BFS through panel→panel hops) to the
    // nearest device tier on each side - so a `srv → pp-cu-3a → pp-cu-3b →
    // access` run puts BOTH cu panels in their own lanes between access and
    // srv, never on a device row. Panel chains that never reach a device float.
    const panelNodes = nodes.filter(
      (n) => !positions?.[n.id] && levels.get(n.id) === undefined
    )
    // Nearest device tiers reachable from a panel, with hop counts each side.
    const panelReach = (pid: string) => {
      const seen = new Set([pid])
      let frontier = [pid]
      const hits: { tier: number; hop: number }[] = []
      for (let hop = 1; hop <= 8 && frontier.length; hop++) {
        const nextF: string[] = []
        for (const cur of frontier)
          for (const nb of nbr.get(cur) ?? []) {
            if (seen.has(nb)) continue
            seen.add(nb)
            const t = levels.get(nb)
            if (t !== undefined) hits.push({ tier: t, hop })
            else nextF.push(nb) // another panel - keep walking the run
          }
        frontier = nextF
      }
      if (!hits.length) return null
      const lo = Math.min(...hits.map((h) => h.tier))
      const hi = Math.max(...hits.map((h) => h.tier))
      const hopAt = (t: number) =>
        Math.min(...hits.filter((h) => h.tier === t).map((h) => h.hop))
      return { lo, hi, hopsLo: hopAt(lo), hopsHi: hopAt(hi) }
    }
    // panel id → { lo tier, frac in [0,1] toward hi } (its depth in the run).
    const panelPlace = new Map<string, { lo: number; frac: number }>()
    const floaters: Node[] = []
    for (const p of panelNodes) {
      const r = panelReach(p.id)
      if (!r) {
        floaters.push(p)
        continue
      }
      const frac = r.lo === r.hi ? 0.5 : r.hopsLo / (r.hopsLo + r.hopsHi)
      panelPlace.set(p.id, { lo: r.lo, frac })
    }
    // Distinct sub-lane fractions per lower-tier gap (each becomes one lane).
    const fracsByGap = new Map<number, number[]>()
    for (const { lo, frac } of panelPlace.values()) {
      const arr = fracsByGap.get(lo) ?? []
      if (!arr.some((f) => Math.abs(f - frac) < 0.02)) arr.push(frac)
      arr.sort((a, b) => a - b)
      fracsByGap.set(lo, arr)
    }

    // Base tier coord from the Level distances (mainOffsets).
    const baseMain = (lvl: number) => {
      if (!mainOffsets) return lvl * mainGap
      if (lvl < mainOffsets.length) return mainOffsets[lvl]
      const lastIdx = mainOffsets.length - 1
      return mainOffsets[lastIdx] + (lvl - lastIdx) * mainGap
    }
    // A panel gap is widened only as much as its sub-lanes NEED - so if the
    // Level distance already makes the device gap big, the panels spread across
    // that big gap (big device spacing → big panel spacing); a tight distance
    // still gets a minimum so panels never overlap.
    //
    // The lane pitch must follow the ACTUAL panel card size on the main axis:
    // a patch panel with left/right ports is COL_W+COL_W+CENTER_W = 306px wide,
    // so the old fixed 250px lane clipped every one of them ("no room"). Reserve
    // the widest panel in the gap + clearance instead. Floor keeps tiny panels tidy.
    const PANEL_CLEAR = tb ? 44 : 70
    const mainSizeOf = (id: string) => {
      const d = g.node(id)
      return d ? (tb ? d.height : d.width) : 0
    }
    const lanePitch = (gp: number) => {
      let pitch = tb ? 120 : 250
      for (const [pid, pl] of panelPlace)
        if (pl.lo === gp) pitch = Math.max(pitch, mainSizeOf(pid) + PANEL_CLEAR)
      return pitch
    }
    const extraFor = (gp: number) => {
      const lc = fracsByGap.get(gp)?.length ?? 0
      if (!lc) return 0
      const distGap = baseMain(gp + 1) - baseMain(gp)
      return Math.max(0, (lc + 1) * lanePitch(gp) - distGap)
    }
    const mainAt = (lvl: number) => {
      let extra = 0
      for (const [gp] of fracsByGap) if (gp < lvl) extra += extraFor(gp)
      return baseMain(lvl) + extra
    }

    const placed = new Map<string, { x: number; y: number }>()
    const crossSize = (id: string) => {
      const d = g.node(id)
      return tb ? d.width : d.height
    }
    // Extra shoulder room for cards with big cable combs.
    const fanExtra = (id: string) => {
      const n = nodes.find((x) => x.id === id)
      const ports = (n?.data as { ports?: unknown[] } | undefined)?.ports
      return Math.max(0, (ports?.length ?? 0) - 8) * 8
    }
    // Lay a set of ids along the cross axis at a fixed main coord, centred on 0.
    const layLane = (ids: string[], main: number) => {
      let span = -CROSS_GAP
      for (const id of ids) span += crossSize(id) + CROSS_GAP + fanExtra(id)
      let cur = -span / 2
      for (const id of ids) {
        placed.set(id, tb ? { x: cur, y: main } : { x: main, y: cur })
        cur += crossSize(id) + CROSS_GAP + fanExtra(id)
      }
    }

    // Device tiers - natural name order (fw-01 before fw-02 before fw-10).
    const tiers = new Map<number, Node[]>()
    for (const n of nodes) {
      if (positions?.[n.id]) continue
      const lvl = levels.get(n.id)
      if (lvl === undefined) continue
      ;(tiers.get(lvl) ?? tiers.set(lvl, []).get(lvl)!).push(n)
    }
    for (const [lvl, group] of tiers) {
      group.sort((a, b) =>
        natural(
          String((a.data as { name?: string }).name ?? a.id),
          String((b.data as { name?: string }).name ?? b.id)
        )
      )
      layLane(
        group.map((n) => n.id),
        mainAt(lvl)
      )
    }

    // Panel sub-lanes: group by (gap, sub-lane index) and place each lane at
    // its fractional depth in the gap, ordered along the cross axis by the mean
    // position of its placed device neighbours (so it sits under what it serves).
    const crossOf = (id: string) => {
      const p = placed.get(id)
      return p ? (tb ? p.x : p.y) : undefined
    }
    const laneOf = new Map<string, string[]>() // "lo:idx" → panel ids
    for (const [pid, { lo, frac }] of panelPlace) {
      const fracs = fracsByGap.get(lo) ?? []
      const idx = fracs.findIndex((f) => Math.abs(f - frac) < 0.02)
      const key = `${lo}:${idx}`
      ;(laneOf.get(key) ?? laneOf.set(key, []).get(key)!).push(pid)
    }
    for (const [key, ids] of laneOf) {
      const [lo, idx] = key.split(":").map(Number)
      const laneCount = fracsByGap.get(lo)?.length ?? 1
      // Even slots across the (now wide-enough) gap, in depth order - so lanes
      // sit ≥ one pitch apart and can't collide even when two panels' run depths
      // land close together. A single panel (laneCount 1) still lands mid-gap.
      const slot = (idx + 1) / (laneCount + 1)
      const main = mainAt(lo) + slot * (mainAt(lo + 1) - mainAt(lo))
      const meanCross = (id: string) => {
        const cs = (nbr.get(id) ?? [])
          .map(crossOf)
          .filter((v): v is number => v !== undefined)
        return cs.length ? cs.reduce((s, v) => s + v, 0) / cs.length : 0
      }
      ids.sort((a, b) => meanCross(a) - meanCross(b))
      layLane(ids, main)
    }

    // Panel→panel chains that never reach a device → float to neighbour mean.
    const posAt = (id: string) =>
      placed.get(id) ??
      (positions?.[id]
        ? { x: positions[id][0], y: positions[id][1] }
        : undefined)
    for (let pass = 0; pass < 4; pass++) {
      for (const n of floaters) {
        if (placed.has(n.id)) continue
        const pts = (nbr.get(n.id) ?? [])
          .map(posAt)
          .filter((p): p is { x: number; y: number } => !!p)
        if (!pts.length) continue
        placed.set(n.id, {
          x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
          y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
        })
      }
    }

    const laid = nodes.map((n) => {
      const pinned = positions?.[n.id]
      if (pinned) return { ...n, position: { x: pinned[0], y: pinned[1] } }
      const p = placed.get(n.id)
      if (p) return { ...n, position: p }
      // Still unplaced (isolated panel) - keep its dagre position.
      const g0 = g.node(n.id)
      return {
        ...n,
        position: { x: g0.x - g0.width / 2, y: g0.y - g0.height / 2 },
      }
    })
    const pinnedIds = positions ? new Set(Object.keys(positions)) : undefined
    const spaced = respaceBands(laid, edges, sizeOf, tb, pinnedIds)
    return {
      nodes: spaced,
      waypoints: computeWaypoints(spaced, edges, sizeOf, tb),
    }
  }

  const laid = nodes.map((n) => {
    const pinned = positions?.[n.id]
    if (pinned) return { ...n, position: { x: pinned[0], y: pinned[1] } }
    const p = g.node(n.id)
    if (!p) return n // grid leaf - placed relative to its hub below
    // Centre-anchor using dagre's own computed w/h (varies per node).
    return { ...n, position: { x: p.x - p.width / 2, y: p.y - p.height / 2 } }
  })
  const exempt = new Set([
    ...(pinnedIds ?? []),
    ...clusters.leafSet,
  ])
  const spaced = respaceBands(laid, mainEdges, sizeOf, tb, exempt)
  // Pack disconnected islands into a viewport-shaped arrangement; grid
  // leaves ride with their hub (its inflated box covers them, and they are
  // placed relative to it afterwards).
  const packed = packComponents(
    spaced,
    edges,
    (n) => (clusters.leafSet.has(n.id) ? null : sizeFor(n)),
    pinnedIds
  )
  const { out, streets } = placeLeafGrids(packed)
  const wp = computeWaypoints(
    out.filter((n) => !clusters.leafSet.has(n.id)),
    mainEdges,
    sizeOf,
    tb
  )
  for (const [k, v] of streets) wp.set(k, v)
  return { nodes: out, waypoints: wp }
}
