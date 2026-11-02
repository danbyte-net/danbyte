import type { Pt } from "./cable-route"
import { boxesHit, textSize } from "./plan-labels"
import type { Box } from "./plan-labels"

// Callouts: a tile whose plain name will not sit cleanly by it - no room,
// or so close to another tile that the name could be either's - is named
// in a small box set off in free space instead, preferably outside its room
// (or its group of tiles), with a thin leader back to the tile. The boxes
// along one side of a room line up in the order of their tiles, so the
// leaders never cross; they never cover each other, a tile or a label
// placed before them. The layout depends on the tiles and the zoom only,
// never on the view, so a pan never moves a box.
//
// Units: as the label pass - screen px at the settled zoom.

/** A line under a callout's name: an attribute of its object, a status
 * or role with its badge colour. */
export interface CalloutLine {
  key: string
  label: string
  value: string
  /** A status or role: drawn as its badge ("" for one with no colour). */
  color?: string
}

export type CalloutSide = "top" | "bottom" | "left" | "right"

/** A tile to name in a callout. */
export interface CalloutItem {
  id: string
  /** The tile as drawn (units). */
  anchor: Box
  /** The box's size (units). */
  size: { w: number; h: number }
  /** The room (or group of tiles) it belongs to, and that room's box
   * (units): its callouts go round it. */
  group: string
  container: Box
}

/** A callout placed: its box, the side of its room it sits on, and its
 * leader - from the box's edge to the tile's (units). */
export interface PlacedCallout {
  id: string
  box: Box
  side: CalloutSide
  leader: [Pt, Pt]
}

/** Callout type: the name's font (px), the lines' font, the padding. */
export const CALLOUT_FONT_PX = 11
export const CALLOUT_LINE_FONT_PX = 10
export const CALLOUT_PAD_X = 6
export const CALLOUT_PAD_Y = 4
/** A line's height (px), a badge line's a little taller. */
export const CALLOUT_LINE_PX = 15
/** A callout shows its name and at most this many lines. */
export const CALLOUT_MAX_LINES = 3
/** Room between the room's edge and the first row of boxes (px). */
const ROW_GAP = 10
/** Between two boxes in a row (px). */
const BOX_GAP = 6
/** How many rows out a box may go looking for a free place. */
const MAX_STEPS = 8
/** A room's left or right side counts as this much farther than it is. */
const SIDE_WEIGHT = 2

/** A line's value as shown: a long one clipped. */
export function calloutValue(v: string, max = 28): string {
  return v.length > max ? `${v.slice(0, max - 1)}…` : v
}

/** A callout's size (px) for its name and its lines. */
export function calloutSize(
  name: string,
  lines: readonly CalloutLine[]
): { w: number; h: number } {
  let w = textSize(name, CALLOUT_FONT_PX).w
  for (const l of lines.slice(0, CALLOUT_MAX_LINES)) {
    const t = textSize(calloutValue(l.value), CALLOUT_LINE_FONT_PX).w
    // A badge: its own padding round the text.
    w = Math.max(w, l.color !== undefined ? t + 8 : t)
  }
  const n = Math.min(lines.length, CALLOUT_MAX_LINES)
  return {
    w: Math.ceil(w + CALLOUT_PAD_X * 2),
    h: Math.ceil(
      CALLOUT_FONT_PX * 1.3 + n * CALLOUT_LINE_PX + CALLOUT_PAD_Y * 2
    ),
  }
}

const cx = (b: Box) => b.x + b.w / 2
const cy = (b: Box) => b.y + b.h / 2
const clamp = (v: number, lo: number, hi: number) =>
  lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v))

/** Which sides of its room a tile's callout may go on, nearest first; on
 * a tie top, bottom, left, right. A side with no room inside `bounds` for
 * the box comes after those with room. */
export function sidesFor(
  item: CalloutItem,
  bounds?: Box | null
): CalloutSide[] {
  const c = item.container
  const a = item.anchor
  // Above or below first: a row reads along a line of boxes; a side only
  // for a tile much nearer it (the boxes stack there, one per line).
  const d: [CalloutSide, number][] = [
    ["top", cy(a) - c.y],
    ["bottom", c.y + c.h - cy(a)],
    ["left", (cx(a) - c.x) * SIDE_WEIGHT],
    ["right", (c.x + c.w - cx(a)) * SIDE_WEIGHT],
  ]
  const room = (s: CalloutSide) => {
    if (!bounds) return true
    const { w, h } = item.size
    if (s === "top") return c.y - ROW_GAP - h >= bounds.y
    if (s === "bottom") return c.y + c.h + ROW_GAP + h <= bounds.y + bounds.h
    if (s === "left") return c.x - ROW_GAP - w >= bounds.x
    return c.x + c.w + ROW_GAP + w <= bounds.x + bounds.w
  }
  return d
    .map(([s, v], i) => ({ s, v, i, ok: room(s) }))
    .sort((p, q) => Number(q.ok) - Number(p.ok) || p.v - q.v || p.i - q.i)
    .map((x) => x.s)
}

/**
 * Lay out boxes of `sizes` (along one axis) as near their `ideal` centres
 * as they can be without overlapping, `gap` apart, in the order given -
 * the least squared shift (blocks of touching boxes pooled).
 * Returns each box's start.
 */
export function packRow(
  ideal: readonly number[],
  sizes: readonly number[],
  gap: number
): number[] {
  interface Block {
    first: number
    last: number
    sum: number
    n: number
    len: number
  }
  const blocks: Block[] = []
  // Each box's offset in its block, from the block's start.
  const offset: number[] = []
  for (let i = 0; i < ideal.length; i++) {
    offset[i] = 0
    blocks.push({
      first: i,
      last: i,
      sum: ideal[i] - sizes[i] / 2,
      n: 1,
      len: sizes[i],
    })
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1]
      const p = blocks[blocks.length - 2]
      if (p.sum / p.n + p.len + gap <= b.sum / b.n + 1e-9) break
      // Pool: b's boxes sit after p's.
      const shift = p.len + gap
      for (let j = b.first; j <= b.last; j++) offset[j] += shift
      p.sum += b.sum - shift * b.n
      p.n += b.n
      p.len += gap + b.len
      p.last = b.last
      blocks.pop()
    }
  }
  const out: number[] = []
  for (const b of blocks)
    for (let j = b.first; j <= b.last; j++) out[j] = b.sum / b.n + offset[j]
  return out
}

/** Does the segment p→q cross the box (units)? */
export function segmentHitsBox(p: Pt, q: Pt, b: Box): boolean {
  // Liang-Barsky clip.
  let t0 = 0
  let t1 = 1
  const dx = q[0] - p[0]
  const dy = q[1] - p[1]
  const edges: [number, number][] = [
    [-dx, p[0] - b.x],
    [dx, b.x + b.w - p[0]],
    [-dy, p[1] - b.y],
    [dy, b.y + b.h - p[1]],
  ]
  for (const [pp, qq] of edges) {
    if (Math.abs(pp) < 1e-12) {
      if (qq < 0) return false
      continue
    }
    const r = qq / pp
    if (pp < 0) t0 = Math.max(t0, r)
    else t1 = Math.min(t1, r)
    if (t0 > t1) return false
  }
  return t1 - t0 > 1e-6
}

/** Do the segments a and b cross (touching ends do not)? */
export function segmentsCross(a: [Pt, Pt], b: [Pt, Pt]): boolean {
  const o = (p: Pt, q: Pt, r: Pt) =>
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
  const d1 = o(b[0], b[1], a[0])
  const d2 = o(b[0], b[1], a[1])
  const d3 = o(a[0], a[1], b[0])
  const d4 = o(a[0], a[1], b[1])
  return d1 * d2 < -1e-9 && d3 * d4 < -1e-9
}

/** A leader as small boxes along it (units), for the labels placed after
 * the callouts to keep off. */
export function leaderBoxes(l: [Pt, Pt], every = 8, half = 2): Box[] {
  const [p, q] = l
  const len = Math.hypot(q[0] - p[0], q[1] - p[1])
  const n = Math.max(1, Math.ceil(len / every))
  const out: Box[] = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const x = p[0] + (q[0] - p[0]) * t
    const y = p[1] + (q[1] - p[1]) * t
    out.push({ x: x - half, y: y - half, w: half * 2, h: half * 2 })
  }
  return out
}

/** The leader from a box on `side` to its tile `a` (units). */
export function leaderFor(box: Box, a: Box, side: CalloutSide): [Pt, Pt] {
  const r = 4
  switch (side) {
    case "top": {
      const x = clamp(cx(a), box.x + r, box.x + box.w - r)
      return [
        [x, box.y + box.h],
        [cx(a), a.y],
      ]
    }
    case "bottom": {
      const x = clamp(cx(a), box.x + r, box.x + box.w - r)
      return [
        [x, box.y],
        [cx(a), a.y + a.h],
      ]
    }
    case "left": {
      const y = clamp(cy(a), box.y + r, box.y + box.h - r)
      return [
        [box.x + box.w, y],
        [a.x, cy(a)],
      ]
    }
    case "right": {
      const y = clamp(cy(a), box.y + r, box.y + box.h - r)
      return [
        [box.x, y],
        [a.x + a.w, cy(a)],
      ]
    }
  }
}

const horizontal = (s: CalloutSide) => s === "top" || s === "bottom"

/** A box on `side` of `c` at distance `d` from it, `along` its start on
 * the side's axis. */
function boxAt(
  c: Box,
  side: CalloutSide,
  d: number,
  along: number,
  size: { w: number; h: number }
): Box {
  const { w, h } = size
  switch (side) {
    case "top":
      return { x: along, y: c.y - d - h, w, h }
    case "bottom":
      return { x: along, y: c.y + c.h + d, w, h }
    case "left":
      return { x: c.x - d - w, y: along, w, h }
    case "right":
      return { x: c.x + c.w + d, y: along, w, h }
  }
}

/**
 * Place the callouts. `free(box)` says a box is clear of what was placed
 * before (tiles, icons, labels); each box placed is taken for the rest.
 * Groups go in key order, a group's tiles to the nearest side of their
 * room, each side's boxes in one row in the order of their tiles; a row
 * that hits something moves out, and a box that still hits something on
 * its own row goes out alone. A tile with no free place anywhere is left
 * out (its name hides, as a plain name with nowhere to go does).
 */
export function layoutCallouts(
  items: readonly CalloutItem[],
  opts: {
    free: (b: Box) => boolean
    bounds?: Box | null
    /** Callout boxes placed before (an earlier round): no leader through
     * one. */
    prior?: readonly Box[]
    /** The tiles as drawn: a leader keeps off them where it can (a
     * second try lets it cross one rather than leave a name out). */
    bodies?: { near: (b: Box, r: number) => { box: Box }[] }
  }
): Map<string, PlacedCallout> {
  const out = new Map<string, PlacedCallout>()
  const taken: Box[] = [...(opts.prior ?? [])]
  const leaders: [Pt, Pt][] = []
  const clear = (b: Box) => opts.free(b) && !taken.some((t) => boxesHit(t, b))
  // A leader through a box placed already, or a box over a leader.
  let strict = !!opts.bodies
  const leaderOk = (l: [Pt, Pt], anchor: Box) => {
    if (taken.some((t) => segmentHitsBox(l[0], l[1], t))) return false
    if (!strict || !opts.bodies) return true
    const span = {
      x: Math.min(l[0][0], l[1][0]),
      y: Math.min(l[0][1], l[1][1]),
      w: Math.abs(l[1][0] - l[0][0]),
      h: Math.abs(l[1][1] - l[0][1]),
    }
    return !opts.bodies
      .near(span, 0)
      .some(
        (o) => !boxesHit(o.box, anchor) && segmentHitsBox(l[0], l[1], o.box)
      )
  }
  const boxOk = (b: Box) => !leaders.some((l) => segmentHitsBox(l[0], l[1], b))
  const take = (it: CalloutItem, box: Box, side: CalloutSide) => {
    const leader = leaderFor(box, it.anchor, side)
    taken.push(box)
    leaders.push(leader)
    out.set(it.id, { id: it.id, box, side, leader })
  }

  const groups = new Map<string, CalloutItem[]>()
  for (const it of items) {
    const g = groups.get(it.group)
    if (g) g.push(it)
    else groups.set(it.group, [it])
  }
  const placeGroup = (list: readonly CalloutItem[]) => {
    const bySide = new Map<CalloutSide, CalloutItem[]>()
    const prefs = new Map<string, CalloutSide[]>()
    for (const it of list) {
      const sides = sidesFor(it, opts.bounds)
      prefs.set(it.id, sides)
      const s = sides[0]
      const l = bySide.get(s)
      if (l) l.push(it)
      else bySide.set(s, [it])
    }
    const left: CalloutItem[] = []
    for (const side of ["top", "bottom", "left", "right"] as const) {
      const row = bySide.get(side)
      if (!row) continue
      const h = horizontal(side)
      row.sort(
        (p, q) =>
          (h ? cx(p.anchor) - cx(q.anchor) : cy(p.anchor) - cy(q.anchor)) ||
          (h ? cy(p.anchor) - cy(q.anchor) : cx(p.anchor) - cx(q.anchor)) ||
          (p.id < q.id ? -1 : p.id > q.id ? 1 : 0)
      )
      const starts = packRow(
        row.map((it) => (h ? cx(it.anchor) : cy(it.anchor))),
        row.map((it) => (h ? it.size.w : it.size.h)),
        BOX_GAP
      )
      const c = row[0].container
      const step = h
        ? Math.max(...row.map((it) => it.size.h)) + BOX_GAP
        : Math.max(...row.map((it) => it.size.w)) / 2 + BOX_GAP
      // The whole row, out a step at a time until it is clear.
      let placed = false
      for (let k = 0; k <= MAX_STEPS && !placed; k++) {
        const d = ROW_GAP + k * step
        const boxes = row.map((it, i) => boxAt(c, side, d, starts[i], it.size))
        if (!boxes.every((b) => clear(b) && boxOk(b))) continue
        const ls = boxes.map((b, i) => leaderFor(b, row[i].anchor, side))
        if (!ls.every((l, i) => leaderOk(l, row[i].anchor))) continue
        // No leader through a box of its own row.
        if (
          ls.some((l, i) =>
            boxes.some((b, j) => j !== i && segmentHitsBox(l[0], l[1], b))
          )
        )
          continue
        row.forEach((it, i) => take(it, boxes[i], side))
        placed = true
      }
      if (placed) continue
      // Box by box: each out until it is clear.
      row.forEach((it, i) => {
        for (let k = 0; k <= MAX_STEPS; k++) {
          const b = boxAt(c, side, ROW_GAP + k * step, starts[i], it.size)
          if (!clear(b) || !boxOk(b)) continue
          const l = leaderFor(b, it.anchor, side)
          if (!leaderOk(l, it.anchor)) continue
          take(it, b, side)
          return
        }
        left.push(it)
      })
    }
    // What found no place on its side: the other sides, alone.
    for (const it of left) {
      for (const side of prefs.get(it.id)!.slice(1)) {
        const h = horizontal(side)
        const s = h
          ? cx(it.anchor) - it.size.w / 2
          : cy(it.anchor) - it.size.h / 2
        const step = h ? it.size.h + BOX_GAP : it.size.w / 2 + BOX_GAP
        let done = false
        for (let k = 0; k <= MAX_STEPS && !done; k++) {
          const b = boxAt(it.container, side, ROW_GAP + k * step, s, it.size)
          if (!clear(b) || !boxOk(b)) continue
          const l = leaderFor(b, it.anchor, side)
          if (!leaderOk(l, it.anchor)) continue
          take(it, b, side)
          done = true
        }
        if (done) break
      }
    }
  }
  const keys = [...groups.keys()].sort()
  for (const key of keys) placeGroup(groups.get(key)!)
  if (strict) {
    // Again for the rest, a leader free to cross a tile.
    strict = false
    for (const key of keys) {
      const rest = groups.get(key)!.filter((it) => !out.has(it.id))
      if (rest.length) placeGroup(rest)
    }
  }
  return out
}

/** Callout tiles grouped by room: the smallest room (cells) holding each
 * tile's centre; tiles in no room grouped with those near them (within
 * `join` units), the group's box round them. Returns each tile's group
 * key and its box (units). */
export function calloutGroups(
  tiles: readonly { id: string; anchor: Box; home?: Box }[],
  rooms: readonly { id: string; box: Box }[],
  join: number,
  pad: number
): Map<string, { group: string; container: Box }> {
  const out = new Map<string, { group: string; container: Box }>()
  const loose: { id: string; anchor: Box }[] = []
  for (const t of tiles) {
    const x = cx(t.home ?? t.anchor)
    const y = cy(t.home ?? t.anchor)
    let best: { id: string; box: Box } | null = null
    for (const r of rooms) {
      const b = r.box
      if (x < b.x || x > b.x + b.w || y < b.y || y > b.y + b.h) continue
      if (
        !best ||
        b.w * b.h < best.box.w * best.box.h ||
        (b.w * b.h === best.box.w * best.box.h && r.id < best.id)
      )
        best = r
    }
    if (best) out.set(t.id, { group: `room:${best.id}`, container: best.box })
    else loose.push(t)
  }
  // A room's icons can spread past its walls from afar: its callouts go
  // round the room and its tiles as drawn.
  const byRoom = new Map<string, Box>()
  for (const t of tiles) {
    const g = out.get(t.id)
    if (!g) continue
    const b = byRoom.get(g.group) ?? g.container
    const a = t.anchor
    const x0 = Math.min(b.x, a.x - pad)
    const y0 = Math.min(b.y, a.y - pad)
    const x1 = Math.max(b.x + b.w, a.x + a.w + pad)
    const y1 = Math.max(b.y + b.h, a.y + a.h + pad)
    byRoom.set(g.group, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 })
  }
  for (const [id, g] of out)
    out.set(id, { ...g, container: byRoom.get(g.group)! })
  // Loose tiles: joined with their neighbours (union-find).
  const parent = loose.map((_, i) => i)
  const find = (i: number): number =>
    parent[i] === i ? i : (parent[i] = find(parent[i]))
  const near = (a: Box, b: Box) =>
    a.x - join < b.x + b.w &&
    b.x - join < a.x + a.w &&
    a.y - join < b.y + b.h &&
    b.y - join < a.y + a.h
  for (let i = 0; i < loose.length; i++)
    for (let j = i + 1; j < loose.length; j++)
      if (near(loose[i].anchor, loose[j].anchor)) {
        const a = find(i)
        const b = find(j)
        if (a !== b) parent[Math.max(a, b)] = Math.min(a, b)
      }
  const sets = new Map<number, { id: string; anchor: Box }[]>()
  loose.forEach((t, i) => {
    const r = find(i)
    const s = sets.get(r)
    if (s) s.push(t)
    else sets.set(r, [t])
  })
  for (const members of sets.values()) {
    const x0 = Math.min(...members.map((m) => m.anchor.x)) - pad
    const y0 = Math.min(...members.map((m) => m.anchor.y)) - pad
    const x1 = Math.max(...members.map((m) => m.anchor.x + m.anchor.w)) + pad
    const y1 = Math.max(...members.map((m) => m.anchor.y + m.anchor.h)) + pad
    const key = `near:${[...members.map((m) => m.id)].sort()[0]}`
    for (const m of members)
      out.set(m.id, {
        group: key,
        container: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
      })
  }
  return out
}

/** Boxes with ids, bucketed in a grid: which lie within `r` of a box. */
export class BoxIndex {
  private grid = new Map<string, number[]>()
  private list: { id: string; box: Box }[] = []
  constructor(private cell = 64) {}

  private span(b: Box, r = 0): [number, number, number, number] {
    const c = this.cell
    return [
      Math.floor((b.x - r) / c),
      Math.floor((b.x + b.w + r) / c),
      Math.floor((b.y - r) / c),
      Math.floor((b.y + b.h + r) / c),
    ]
  }

  add(id: string, box: Box): void {
    const i = this.list.push({ id, box }) - 1
    const [x0, x1, y0, y1] = this.span(box)
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 400) {
      this.grid.set("*", [...(this.grid.get("*") ?? []), i])
      return
    }
    for (let gx = x0; gx <= x1; gx++)
      for (let gy = y0; gy <= y1; gy++) {
        const k = `${gx},${gy}`
        const l = this.grid.get(k)
        if (l) l.push(i)
        else this.grid.set(k, [i])
      }
  }

  /** The boxes within `r` of `b` (any part), but `skip`'s. */
  near(b: Box, r: number, skip?: string): { id: string; box: Box }[] {
    const seen = new Set<number>(this.grid.get("*") ?? [])
    const [x0, x1, y0, y1] = this.span(b, r)
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 400)
      this.list.forEach((_, i) => seen.add(i))
    else
      for (let gx = x0; gx <= x1; gx++)
        for (let gy = y0; gy <= y1; gy++)
          for (const i of this.grid.get(`${gx},${gy}`) ?? []) seen.add(i)
    const out: { id: string; box: Box }[] = []
    for (const i of [...seen].sort((p, q) => p - q)) {
      const o = this.list[i]
      if (o.id !== skip && boxGap(o.box, b) <= r) out.push(o)
    }
    return out
  }
}

/** The distance between two boxes (0 when they touch or overlap). */
export function boxGap(a: Box, b: Box): number {
  const dx = Math.max(0, b.x - (a.x + a.w), a.x - (b.x + b.w))
  const dy = Math.max(0, b.y - (a.y + a.h), a.y - (b.y + b.h))
  return Math.hypot(dx, dy)
}
