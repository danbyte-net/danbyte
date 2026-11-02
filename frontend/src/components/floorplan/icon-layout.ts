import type { FloorPlanTile } from "@/lib/api"
import { KIND_ICON, tileIcon } from "@/components/object-icon"

import { tileName } from "./canvas-geometry"
import type { Pt } from "./cable-route"
import type { CellBox } from "./readable"
import { tileFill } from "./tile-paint"

// Icons when zoomed out, decluttered. Icon tiles that would overlap on
// screen (or paper) first spread: a few rounds of relaxation push them
// apart round their true centres, never further than CLUSTER_CAP_SIDES
// icon sides, and each one moved keeps a leader to where it really is.
// Only where that cannot work - a crowd over CLUSTER_MAX_SPREAD, or a
// spread that would move one too far or still overlap - do they fold into
// one cluster tile at their centroid, like markers on a map. Given the
// plan's (or a view's crop) bounds, the spread keeps them inside; it
// spills past the edge only where nothing fits inside.
//
// Everything here is in "units" (screen px or paper mm) at `scale` units
// per cell; the result keeps each item's displacement in units, so on the
// canvas it holds its on-screen size between two layouts while zooming.

/** The gap kept between two icons (units, as a share of the side). */
export const ICON_GAP_SIDES = 0.3
/** The farthest an icon spreads from its true centre, in icon sides. */
export const CLUSTER_CAP_SIDES = 2.5
/** A crowd larger than this clusters rather than spreads. */
export const CLUSTER_MAX_SPREAD = 6
/** Two icons clustered last time stay so until their true centres are
 * this much further apart than the spacing that clusters them. */
export const CLUSTER_EXIT = 1.35
/** A cluster tile is this much bigger than an icon. */
export const CLUSTER_SIDE = 1.15

/** One icon tile to lay out: its id and its true centre (cells). */
export interface IconItem {
  id: string
  c: Pt
}

/** A cluster: its members (tile ids, in reading order) and its anchor -
 * the members' centroid (cells). */
export interface IconCluster {
  id: string
  members: string[]
  anchor: Pt
}

export interface IconLayout {
  /** The scale it was laid out at (units per cell). */
  scale: number
  /** An item's or a cluster's displacement from its anchor (units); only
   * those moved. */
  offsets: ReadonlyMap<string, Pt>
  clusters: readonly IconCluster[]
  /** Tile id → its cluster. */
  clusterOf: ReadonlyMap<string, IconCluster>
}

export const EMPTY_ICON_LAYOUT: IconLayout = {
  scale: 0,
  offsets: new Map(),
  clusters: [],
  clusterOf: new Map(),
}

export interface IconLayoutOptions {
  /** An icon's side (units). */
  side: number
  gap?: number
  cap?: number
  maxSpread?: number
  /** The last layout: who was clustered with whom (hysteresis). */
  prev?: IconLayout | null
  /** Relaxation rounds per pass. */
  iterations?: number
  /** Where icons should stay (units, as the items' centres times
   * `scale`): the plan's grid or a live view's crop. Spread keeps every
   * icon inside, and spills past only when nothing fits inside. */
  bounds?: UnitBox | null
  /** Past the bounds when nothing fits inside (the canvas); false folds
   * into a cluster instead (paper, whose frame clips). */
  spill?: boolean
}

/** A box in units. */
export interface UnitBox {
  x: number
  y: number
  w: number
  h: number
}

interface Node {
  ids: string[]
  /** Anchor in cells and home in units. */
  anchor: Pt
  home: Pt
  p: Pt
  side: number
}

const cheb = (a: Pt, b: Pt) =>
  Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]))

/** Reading order: top to bottom, left to right, then id. */
function readingOrder(a: IconItem, b: IconItem): number {
  return a.c[1] - b.c[1] || a.c[0] - b.c[0] || (a.id < b.id ? -1 : 1)
}

class UnionFind {
  parent: number[]
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i)
  }
  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]]
      i = this.parent[i]
    }
    return i
  }
  union(a: number, b: number) {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb)
  }
}

/** Index pairs (i < j) whose points lie within `d` (Chebyshev) of each
 * other - a grid keeps it near-linear. */
function nearPairs(pts: readonly Pt[], d: number): [number, number][] {
  const out: [number, number][] = []
  if (!(d > 0)) return out
  const grid = new Map<string, number[]>()
  pts.forEach((p, i) => {
    const k = `${Math.floor(p[0] / d)},${Math.floor(p[1] / d)}`
    const l = grid.get(k)
    if (l) l.push(i)
    else grid.set(k, [i])
  })
  pts.forEach((p, i) => {
    const gx = Math.floor(p[0] / d)
    const gy = Math.floor(p[1] / d)
    for (let x = gx - 1; x <= gx + 1; x++)
      for (let y = gy - 1; y <= gy + 1; y++)
        for (const j of grid.get(`${x},${y}`) ?? [])
          if (j > i && cheb(p, pts[j]) < d) out.push([i, j])
  })
  return out
}

function makeNode(items: readonly IconItem[], scale: number, side: number) {
  const n = items.length
  const anchor: Pt = [
    items.reduce((s, it) => s + it.c[0], 0) / n,
    items.reduce((s, it) => s + it.c[1], 0) / n,
  ]
  const home: Pt = [anchor[0] * scale, anchor[1] * scale]
  return {
    ids: items.map((it) => it.id),
    anchor,
    home,
    p: [home[0], home[1]] as Pt,
    side: n > 1 ? side * CLUSTER_SIDE : side,
  }
}

/** Keep a node's box inside `b`, on an axis where it fits - one whose true
 * place is inside or by the edge (within a side); one well outside (a
 * close-up's neighbour) stays where it is. */
function keepInside(n: Node, b: UnitBox) {
  const h = n.side / 2
  const [hx, hy] = n.home
  if (
    hx < b.x - n.side ||
    hy < b.y - n.side ||
    hx > b.x + b.w + n.side ||
    hy > b.y + b.h + n.side
  )
    return
  if (b.w >= n.side) n.p[0] = Math.min(b.x + b.w - h, Math.max(b.x + h, n.p[0]))
  if (b.h >= n.side) n.p[1] = Math.min(b.y + b.h - h, Math.max(b.y + h, n.p[1]))
}

/** Push overlapping nodes apart along the axis they overlap least on -
 * each half the overlap, so they move no more than they must - and never
 * past `cap` from home; inside `bounds` when given. */
function relax(
  nodes: Node[],
  gap: number,
  cap: number,
  iterations: number,
  bounds: UnitBox | null = null
) {
  for (const [i, n] of nodes.entries()) {
    n.p = [n.home[0], n.home[1]]
    // Stacked on one spot: start round it, so the push has a direction.
    const twin = nodes.findIndex((o, j) => j < i && cheb(o.home, n.home) < 1e-6)
    if (twin >= 0) {
      const a = i * 2.39996
      n.p = [n.home[0] + Math.cos(a) * 0.01, n.home[1] + Math.sin(a) * 0.01]
    }
    if (bounds) keepInside(n, bounds)
  }
  const maxSide = Math.max(...nodes.map((n) => n.side))
  for (let it = 0; it < iterations; it++) {
    let moved = false
    for (const [i, j] of nearPairs(
      nodes.map((n) => n.p),
      maxSide + gap
    )) {
      const a = nodes[i]
      const b = nodes[j]
      const d = (a.side + b.side) / 2 + gap
      const dx = b.p[0] - a.p[0]
      const dy = b.p[1] - a.p[1]
      const px = d - Math.abs(dx)
      const py = d - Math.abs(dy)
      if (px <= 0 || py <= 0) continue
      moved = true
      if (px <= py) {
        const s = (px / 2 + 1e-3) * (dx >= 0 ? 1 : -1)
        a.p[0] -= s
        b.p[0] += s
      } else {
        const s = (py / 2 + 1e-3) * (dy >= 0 ? 1 : -1)
        a.p[1] -= s
        b.p[1] += s
      }
    }
    for (const n of nodes) {
      const ox = n.p[0] - n.home[0]
      const oy = n.p[1] - n.home[1]
      const l = Math.hypot(ox, oy)
      if (l > cap) {
        n.p[0] = n.home[0] + (ox / l) * cap
        n.p[1] = n.home[1] + (oy / l) * cap
      }
      if (bounds) keepInside(n, bounds)
    }
    if (!moved) break
  }
}

/** Nodes that still overlap another, or sit at the cap. */
function badNodes(nodes: readonly Node[], gap: number, cap: number) {
  const bad = new Set<number>()
  const maxSide = Math.max(...nodes.map((n) => n.side))
  for (const [i, j] of nearPairs(
    nodes.map((n) => n.p),
    maxSide + gap
  )) {
    const d = (nodes[i].side + nodes[j].side) / 2 + gap * 0.5
    if (cheb(nodes[i].p, nodes[j].p) < d - 1e-6) {
      bad.add(i)
      bad.add(j)
    }
  }
  nodes.forEach((n, i) => {
    if (Math.hypot(n.p[0] - n.home[0], n.p[1] - n.home[1]) > cap - 1e-3)
      bad.add(i)
  })
  return bad
}

/** Greedy map-marker clusters of a crowd: each seed, in reading order,
 * takes those still free within `r` of it. */
function greedy(items: IconItem[], scale: number, r: number): IconItem[][] {
  const left = [...items].sort(readingOrder)
  const out: IconItem[][] = []
  const taken = new Set<string>()
  for (const seed of left) {
    if (taken.has(seed.id)) continue
    const s: Pt = [seed.c[0] * scale, seed.c[1] * scale]
    const group = left.filter(
      (it) =>
        !taken.has(it.id) && cheb(s, [it.c[0] * scale, it.c[1] * scale]) < r
    )
    for (const it of group) taken.add(it.id)
    out.push(group)
  }
  return out
}

/**
 * Lay the icons out at `scale` units per cell: spread where there is room,
 * clustered where there is not. `pinned` (the selection) never joins a
 * cluster. Deterministic: the same items and options give the same
 * layout, whatever their order.
 */
export function layoutIcons(
  items: readonly IconItem[],
  scale: number,
  {
    side,
    gap = side * ICON_GAP_SIDES,
    cap = side * CLUSTER_CAP_SIDES,
    maxSpread = CLUSTER_MAX_SPREAD,
    prev = null,
    iterations = 40,
    bounds = null,
    spill = true,
  }: IconLayoutOptions,
  pinned: ReadonlySet<string> = new Set()
): IconLayout {
  // One icon alone only moves to come inside the bounds.
  if (!(scale > 0) || items.length < (bounds ? 1 : 2))
    return { ...EMPTY_ICON_LAYOUT, scale }
  const sorted = [...items].sort(readingOrder)
  const homes = sorted.map((it): Pt => [it.c[0] * scale, it.c[1] * scale])
  const spacing = side + gap
  // Who overlaps whom where they really are: the crowds. Last layout's
  // cluster mates hold together a little longer (hysteresis).
  const wasWith = (a: string, b: string) => {
    const ca = prev?.clusterOf.get(a)
    return !!ca && ca === prev?.clusterOf.get(b)
  }
  const uf = new UnionFind(sorted.length)
  for (const [i, j] of nearPairs(homes, spacing * CLUSTER_EXIT)) {
    const d = cheb(homes[i], homes[j])
    if (d < spacing || wasWith(sorted[i].id, sorted[j].id)) uf.union(i, j)
  }
  const crowds = new Map<number, number[]>()
  sorted.forEach((_, i) => {
    const r = uf.find(i)
    const l = crowds.get(r)
    if (l) l.push(i)
    else crowds.set(r, [i])
  })
  // Each crowd: spread when small; otherwise map-marker clusters. Last
  // layout's clusters within a crowd stay together.
  let groups: IconItem[][] = []
  for (const idx of crowds.values()) {
    const crowd = idx.map((i) => sorted[i])
    const free = crowd.filter((it) => pinned.has(it.id))
    const rest = crowd.filter((it) => !pinned.has(it.id))
    for (const it of free) groups.push([it])
    const held = new Map<string, IconItem[]>()
    const loose: IconItem[] = []
    for (const it of rest) {
      const c = prev?.clusterOf.get(it.id)
      if (c) held.set(c.id, [...(held.get(c.id) ?? []), it])
      else loose.push(it)
    }
    for (const g of held.values())
      if (g.length > 1) groups.push(g)
      else loose.push(...g)
    if (rest.length <= maxSpread) for (const it of loose) groups.push([it])
    else groups.push(...greedy(loose, scale, spacing * 1.5))
  }

  // Relax; what will not spread merges with what it collides with, and
  // round again.
  // Inside the bounds first; past the edge only where nothing fits inside.
  const spread = () => {
    const nodes = groups.map((g) => makeNode(g, scale, side))
    relax(nodes, gap, cap, iterations, bounds)
    const bad = badNodes(nodes, gap, cap)
    if (bad.size && bounds && spill) {
      const loose = groups.map((g) => makeNode(g, scale, side))
      relax(loose, gap, cap, iterations)
      const looseBad = badNodes(loose, gap, cap)
      if (!looseBad.size) return { nodes: loose, bad: looseBad }
    }
    return { nodes, bad }
  }
  for (let round = 0; round < 8; round++) {
    const { nodes, bad } = spread()
    if (!bad.size) return emit(nodes, scale)
    const pin = (i: number) =>
      groups[i].length === 1 && pinned.has(groups[i][0].id)
    const merge = new UnionFind(nodes.length)
    const maxSide = Math.max(...nodes.map((n) => n.side))
    // Collisions where they ended, then where they started.
    for (const pts of [nodes.map((n) => n.p), nodes.map((n) => n.home)])
      for (const [i, j] of nearPairs(pts, maxSide + gap)) {
        if (!bad.has(i) && !bad.has(j)) continue
        if (pin(i) || pin(j)) continue
        const d = (nodes[i].side + nodes[j].side) / 2 + gap * 0.5
        if (cheb(pts[i], pts[j]) < d) merge.union(i, j)
      }
    // One pushed past the cap with nothing on it: its nearest home, if
    // that is near - never a fold across the plan.
    const joined = new Set<number>()
    nodes.forEach((_, j) => {
      if (merge.find(j) !== j) {
        joined.add(j)
        joined.add(merge.find(j))
      }
    })
    for (const i of bad) {
      if (pin(i) || joined.has(i)) continue
      let best = -1
      let bd = Infinity
      nodes.forEach((n, j) => {
        if (j === i || pin(j)) return
        const d = cheb(n.home, nodes[i].home)
        if (d < bd) {
          bd = d
          best = j
        }
      })
      const reach = cap + (nodes[i].side + maxSide) / 2 + gap
      if (best >= 0 && bd <= reach) merge.union(i, best)
    }
    const next = new Map<number, IconItem[]>()
    groups.forEach((g, i) => {
      const r = merge.find(i)
      next.set(r, [...(next.get(r) ?? []), ...g])
    })
    if (next.size === groups.length) return emit(nodes, scale)
    groups = [...next.values()].map((g) => g.sort(readingOrder))
  }
  return emit(spread().nodes, scale)
}

function emit(nodes: readonly Node[], scale: number): IconLayout {
  const offsets = new Map<string, Pt>()
  const clusters: IconCluster[] = []
  const clusterOf = new Map<string, IconCluster>()
  for (const n of nodes) {
    const off: Pt = [n.p[0] - n.home[0], n.p[1] - n.home[1]]
    const moved = Math.hypot(off[0], off[1]) > 1e-3 * Math.max(1, n.side)
    if (n.ids.length === 1) {
      if (moved) offsets.set(n.ids[0], off)
      continue
    }
    const c: IconCluster = {
      id: `cluster:${n.ids[0]}`,
      members: n.ids,
      anchor: n.anchor,
    }
    clusters.push(c)
    if (moved) offsets.set(c.id, off)
    for (const id of n.ids) clusterOf.set(id, c)
  }
  return { scale, offsets, clusters, clusterOf }
}

/** A layout with `out` (selected, hovered, searched) pulled out of their
 * clusters: drawn on their own at their true place, and a cluster left
 * with one member no cluster. */
export function pullOut(
  layout: IconLayout,
  out: ReadonlySet<string>
): IconLayout {
  if (![...out].some((id) => layout.clusterOf.has(id))) return layout
  const offsets = new Map(layout.offsets)
  const clusters: IconCluster[] = []
  const clusterOf = new Map<string, IconCluster>()
  for (const c of layout.clusters) {
    const members = c.members.filter((id) => !out.has(id))
    if (members.length === c.members.length) {
      clusters.push(c)
      for (const id of members) clusterOf.set(id, c)
      continue
    }
    if (members.length === 1) {
      // The one left stays where the cluster was drawn.
      const o = layout.offsets.get(c.id)
      if (o) offsets.set(members[0], o)
      continue
    }
    if (!members.length) continue
    const kept = { ...c, members }
    clusters.push(kept)
    for (const id of members) clusterOf.set(id, kept)
  }
  return { ...layout, offsets, clusters, clusterOf }
}

/** Where an icon or a cluster draws (cells): its anchor moved by its
 * offset, at `perCell` units per cell now. */
export function drawnCentre(
  layout: IconLayout,
  id: string,
  anchor: Pt,
  perCell: number
): Pt {
  const o = layout.offsets.get(id)
  if (!o || !(perCell > 0)) return anchor
  return [anchor[0] + o[0] / perCell, anchor[1] + o[1] / perCell]
}

/** A square of `side` units centred on `c` (cells). */
export function squareAt(c: Pt, side: number, perCell: number): CellBox {
  const s = side / perCell
  return { x: c[0] - s / 2, y: c[1] - s / 2, w: s, h: s }
}

/** Where the screen-size overlays keep (cells): a live view's room - its
 * outline's box, within the grid - else the grid. */
export function keepBoxOf(
  gridW: number,
  gridH: number,
  outline?: readonly (readonly number[])[] | null
): CellBox {
  if (!outline || outline.length < 3) return { x: 0, y: 0, w: gridW, h: gridH }
  const x0 = Math.max(0, Math.min(...outline.map((p) => p[0])))
  const y0 = Math.max(0, Math.min(...outline.map((p) => p[1])))
  const x1 = Math.min(gridW, Math.max(...outline.map((p) => p[0])))
  const y1 = Math.min(gridH, Math.max(...outline.map((p) => p[1])))
  if (!(x1 > x0 && y1 > y0)) return { x: 0, y: 0, w: gridW, h: gridH }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** A cell box in units at `scale` units per cell. */
export function scaleBox(b: CellBox, scale: number): UnitBox {
  return { x: b.x * scale, y: b.y * scale, w: b.w * scale, h: b.h * scale }
}

/** The zoom bucket a layout is kept for: eight to a doubling, so the
 * layout holds while panning and between nearby zooms. */
export function zoomBucket(k: number): number {
  if (!(k > 0)) return k
  return 2 ** (Math.round(Math.log2(k) * 8) / 8)
}

// ── A cluster's face ────────────────────────────────────────────────────────

/** Worse first: the cluster wears its worst member's state. */
const CHECK_RANK: Record<string, number> = { down: 3, stale: 2, degraded: 1 }

/** The worst monitoring state of `checks`, or null when none alarms. */
export function worstCheck(
  checks: readonly (string | null | undefined)[]
): string | null {
  let worst: string | null = null
  for (const c of checks)
    if (c && (CHECK_RANK[c] ?? 0) > (worst ? CHECK_RANK[worst] : 0)) worst = c
  return worst
}

const KIND_PLURAL: Record<string, string> = {
  rack: "racks",
  cabinet: "cabinets",
  device: "devices",
}

/** A name's shared stem and its trailing number ("R-A01" → "R-A", 1, 2
 * digits), or null without one. */
function trailingNumber(name: string) {
  const m = /^(.*?)(\d+)$/.exec(name)
  if (!m) return null
  return { stem: m[1], n: Number(m[2]), digits: m[2].length }
}

/** A cluster's name: "R-A01–R-A04" when the names share a stem and run in
 * sequence, else the count - "4 racks", or "4 objects" when mixed. */
export function clusterName(tiles: readonly FloorPlanTile[]): string {
  const names = tiles.map((t) => tileName(t))
  const parts = names.map(trailingNumber)
  if (tiles.length > 1 && parts.every((p) => p)) {
    const ps = parts.map((p) => p!)
    const stem = ps[0].stem
    if (ps.every((p) => p.stem === stem)) {
      const order = ps
        .map((p, i) => ({ p, name: names[i] }))
        .sort((a, b) => a.p.n - b.p.n)
      if (order.every((o, i) => i === 0 || o.p.n === order[i - 1].p.n + 1))
        return `${order[0].name}–${order.at(-1)!.name}`
    }
  }
  const kinds = new Set(tiles.map((t) => t.linked?.kind ?? ""))
  const kind = kinds.size === 1 ? KIND_PLURAL[[...kinds][0]] : undefined
  return `${tiles.length} ${kind ?? "objects"}`
}

/** The generic icon of a mixed cluster. */
export const CLUSTER_ICON = "layers"
/** A mixed cluster's fill (zinc-500). */
export const CLUSTER_FILL = "#71717a"

export interface ClusterFace {
  name: string
  /** Shared by every member, else the stack. */
  icon: string
  fill: string
  /** The worst monitoring state, or null. */
  check: string | null
  count: number
}

/** How a cluster looks: the members' shared icon and colour (else the
 * stack, in zinc), its worst state, its count and its name. */
export function clusterFace(
  tiles: readonly FloorPlanTile[],
  checkOf: (t: FloorPlanTile) => string | null | undefined
): ClusterFace {
  const icons = new Set(tiles.map((t) => tileIcon(t)))
  const fills = new Set(tiles.map((t) => tileFill(t)))
  const icon =
    icons.size === 1
      ? [...icons][0] || KIND_ICON[tiles[0]?.linked?.kind ?? ""] || ""
      : CLUSTER_ICON
  return {
    name: clusterName(tiles),
    icon,
    fill: fills.size === 1 ? [...fills][0] : CLUSTER_FILL,
    check: worstCheck(tiles.map(checkOf)),
    count: tiles.length,
  }
}

/** The members' true extent (cells). */
export function clusterExtent(tiles: readonly FloorPlanTile[]): CellBox {
  const x0 = Math.min(...tiles.map((t) => t.x))
  const y0 = Math.min(...tiles.map((t) => t.y))
  const x1 = Math.max(...tiles.map((t) => t.x + t.width))
  const y1 = Math.max(...tiles.map((t) => t.y + t.height))
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** Members closer than this (cells) are stacked, not crowded. */
const STACKED_CELLS = 0.25
/** A cluster's click zooms no closer than this times its extent's fit. */
const FIT_REACH = 1.15

/**
 * Where a click on a cluster takes the view: its members' extent fitted
 * into the viewport (`vw` x `vh` px, `margin` round it), and closer if
 * that is what it takes for the members to stop overlapping as icons - the
 * closest two centres at least `spacingPx` apart - or turn back into tiles
 * (`tilePx` on their long side), whichever comes first; at most FIT_REACH
 * times the fit, so the extent stays in view. Capped at `maxK`. Plan px per cell:
 * `cell`.
 */
export function clusterFitView(
  tiles: readonly FloorPlanTile[],
  vw: number,
  vh: number,
  {
    cell,
    spacingPx,
    tilePx,
    maxK,
    margin = 80,
  }: {
    cell: number
    spacingPx: number
    tilePx: number
    maxK: number
    margin?: number
  }
): { k: number; x: number; y: number } {
  const e = clusterExtent(tiles)
  const w = Math.max(e.w * cell, 1)
  const h = Math.max(e.h * cell, 1)
  const fit = Math.min((vw - margin) / w, (vh - margin) / h)
  // The closest two members (Chebyshev, plan px). Objects stacked on one
  // spot (a device over its rack) never part by zooming - the spread
  // parts them - so they do not count.
  let near = Infinity
  for (let i = 0; i < tiles.length; i++)
    for (let j = i + 1; j < tiles.length; j++) {
      const a = tiles[i]
      const b = tiles[j]
      const d = Math.max(
        Math.abs(a.x + a.width / 2 - b.x - b.width / 2),
        Math.abs(a.y + a.height / 2 - b.y - b.height / 2)
      )
      if (d >= STACKED_CELLS) near = Math.min(near, d * cell)
    }
  const apart = Number.isFinite(near) ? spacingPx / near : fit
  // The largest member back as a tile: the first to turn.
  const largest = Math.max(
    ...tiles.map((t) => Math.max(t.width, t.height) * cell)
  )
  const asTiles = largest > 0 ? tilePx / largest : maxK
  // Fitted, and closer when that parts them - but never so close the
  // extent is lost: past FIT_REACH x the fit, a click on what is still
  // folded goes the rest of the way.
  const k = Math.min(
    maxK,
    Math.max(fit, Math.min(apart, asTiles, fit * FIT_REACH))
  )
  const cx = (e.x + e.w / 2) * cell
  const cy = (e.y + e.h / 2) * cell
  return { k, x: vw / 2 - cx * k, y: vh / 2 - cy * k }
}
