import dagre from "@dagrejs/dagre"
import type { Edge, Node } from "@xyflow/react"

import { stencilSize } from "./stencil-node"
import type { StencilData } from "./stencil-node"

// Lay nodes out left-to-right with dagre and write positions back. Node
// height follows the stencil card (header + one row per cabled port) so
// port-anchored edges land on their rows without overlap. `positions`
// (from a saved view or a user drag) win over the computed layout.
// Fixed tier spacing when the Level organiser forces a role order.
const LEVEL_GAP_LR = 460
const LEVEL_GAP_TB = 280
const CROSS_GAP = 120 // intra-tier peer spacing — wide enough that a
// vertical cable’s label between tiers isn’t hidden behind the next node, and
// that fanned-out cable bundles have room between neighbouring cards.

// Natural order so fw-01 precedes fw-02 precedes fw-10.
const natural = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })

export interface LayoutResult {
  nodes: Node[]
  /** `${source}>${target}` → interior bend points (flow coords) that bend a
   * cable around the cards between its ends. Computed from the FINAL node
   * positions, so it works for the auto layout, role tiers, AND pinned/saved
   * views. Empty for edges where a straight line is already clear. */
  waypoints: Map<string, [number, number][]>
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** A cable's route through one clear "channel" — the main-axis coordinate `m`
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
    // Cards overlap/touch on the main axis — fall back to the centre span.
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

/** Node-avoiding routes for every edge, from the laid-out node rectangles.
 * Cables sharing a channel are FANNED OUT — each gets its own parallel line so
 * a bundle doesn't collapse onto one shared run. */
function computeWaypoints(
  laid: Node[],
  edges: Edge[],
  sizeOf: (id: string) => { width: number; height: number },
  tb: boolean
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
  for (const e of edges) {
    const a = rect.get(e.source)
    const b = rect.get(e.target)
    if (!a || !b) continue
    const obstacles = all
      .filter(([id]) => id !== e.source && id !== e.target)
      .map(([, r]) => r)
    const ch = channelRoute(a, b, obstacles, tb)
    if (ch)
      routes.push({ key: `${e.source}>${e.target}`, ch, staggered: false })
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
  return wp
}

/** Recompute node-avoiding routes for live (e.g. just-dragged) node positions.
 * Sizes come from each node's stencil data, so no dagre pass is needed. */
export function edgeWaypoints(
  nodes: Node[],
  edges: Edge[],
  direction: "LR" | "TB"
): Map<string, [number, number][]> {
  return computeWaypoints(
    nodes,
    edges,
    (id) => {
      const n = nodes.find((x) => x.id === id)
      return n ? stencilSize(n.data as StencilData) : { width: 0, height: 0 }
    },
    direction === "TB"
  )
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
  mainOffsets?: number[]
): LayoutResult {
  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({
    rankdir: direction,
    nodesep: 64,
    ranksep: 220,
    ranker: "network-simplex",
    align: "UL",
  })
  for (const n of nodes) {
    // Card dimensions follow its per-side port split (see stencilSize); the
    // rank axis is set by `direction` on the graph above, not the node size.
    const { width, height } = stencilSize(n.data as StencilData)
    g.setNode(n.id, { width, height })
  }
  for (const e of edges) {
    g.setEdge(e.source, e.target, { weight: 1, minlen: 1 })
  }
  dagre.layout(g)
  const tb = direction === "TB"
  const sizeOf = (id: string) => g.node(id)

  // Role tiers active: place each tier explicitly — main axis by tier index,
  // cross axis by natural name order with real per-node spacing, so peers
  // never overlap and sort 01, 02, 10. (Manually-pinned nodes still win.)
  if (levels) {
    const mainGap = tb ? LEVEL_GAP_TB : LEVEL_GAP_LR
    // Neighbours — for panel gap detection + cross-axis ordering.
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
    // nearest device tier on each side — so a `srv → pp-cu-3a → pp-cu-3b →
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
            else nextF.push(nb) // another panel — keep walking the run
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
    // A panel gap is widened only as much as its sub-lanes NEED — so if the
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
    // Lay a set of ids along the cross axis at a fixed main coord, centred on 0.
    const layLane = (ids: string[], main: number) => {
      let span = -CROSS_GAP
      for (const id of ids) span += crossSize(id) + CROSS_GAP
      let cur = -span / 2
      for (const id of ids) {
        placed.set(id, tb ? { x: cur, y: main } : { x: main, y: cur })
        cur += crossSize(id) + CROSS_GAP
      }
    }

    // Device tiers — natural name order (fw-01 before fw-02 before fw-10).
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
      // Even slots across the (now wide-enough) gap, in depth order — so lanes
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
      // Still unplaced (isolated panel) — keep its dagre position.
      const g0 = g.node(n.id)
      return {
        ...n,
        position: { x: g0.x - g0.width / 2, y: g0.y - g0.height / 2 },
      }
    })
    return { nodes: laid, waypoints: computeWaypoints(laid, edges, sizeOf, tb) }
  }

  const laid = nodes.map((n) => {
    const pinned = positions?.[n.id]
    if (pinned) return { ...n, position: { x: pinned[0], y: pinned[1] } }
    const p = g.node(n.id)
    // Centre-anchor using dagre's own computed w/h (varies per node).
    return { ...n, position: { x: p.x - p.width / 2, y: p.y - p.height / 2 } }
  })
  return { nodes: laid, waypoints: computeWaypoints(laid, edges, sizeOf, tb) }
}
