import type { Pt } from "./cable-route"
import { boxesHit, textSize } from "./plan-labels"
import type { Box } from "./plan-labels"

// Callouts: a tile whose plain name will not sit cleanly by it - no room,
// or so close to another tile that the name could be either's - is named
// in a small box set off in free space instead, with a leader back to the
// tile: a straight line from the middle of the box's edge facing the tile
// to the tile's edge, aimed at its centre. A row of tiles in a room gets a
// tidy row of boxes beside the room when that keeps every leader short;
// otherwise each box takes the nearest free spot round its own tile. No
// leader is longer than `maxLeader`, none crosses another, a box or a
// tile; the boxes never cover each other, a tile or a label placed before
// them. The layout depends on the tiles and the zoom only, never on the
// view, so a pan never moves a box.
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
/** The accent down a box's left edge, in its tile's colour (px). */
export const CALLOUT_ACCENT_PX = 3
/** How far the tab on a box's edge reaches out towards its tile (px):
 * the leader starts at its tip. */
export const CALLOUT_TAB_PX = 5
/** A line's height (px), a badge line's a little taller. */
export const CALLOUT_LINE_PX = 15
/** A callout shows its name and at most this many lines. */
export const CALLOUT_MAX_LINES = 3
/** The longest leader (px): four icons (READABLE_SYMBOL_PX) - a box
 * farther off reads as no one's. A last try allows twice this. */
export const CALLOUT_MAX_LEADER = 112
/** Room between the room's edge and the first row of boxes (px). */
const ROW_GAP = 10
/** Between two boxes in a row (px). */
const BOX_GAP = 6
/** How many rows out a box may go looking for a free place. */
const MAX_STEPS = 8
/** A box by its own tile: at least this far off it, out in these steps. */
const NEAR_GAP = 18
const NEAR_STEP = 6
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
    w: Math.ceil(w + CALLOUT_PAD_X * 2 + CALLOUT_ACCENT_PX),
    h: Math.ceil(
      CALLOUT_FONT_PX * 1.3 + n * CALLOUT_LINE_PX + CALLOUT_PAD_Y * 2
    ),
  }
}

const cx = (b: Box) => b.x + b.w / 2
const cy = (b: Box) => b.y + b.h / 2

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

/** Where a box's leader starts: the tip of the tab at the middle of the
 * edge facing its tile (a box above its tile, `side` top, leaves from its
 * bottom). */
export function leaderStart(box: Box, side: CalloutSide): Pt {
  const t = CALLOUT_TAB_PX
  switch (side) {
    case "top":
      return [cx(box), box.y + box.h + t]
    case "bottom":
      return [cx(box), box.y - t]
    case "left":
      return [box.x + box.w + t, cy(box)]
    case "right":
      return [box.x - t, cy(box)]
  }
}

/** Where the line from `p` to the centre of `a` meets `a`'s edge (`p`
 * itself when it is inside). */
export function tileEnd(p: Pt, a: Box): Pt {
  const dx = cx(a) - p[0]
  const dy = cy(a) - p[1]
  const sx = Math.abs(dx) > 1e-9 ? a.w / 2 / Math.abs(dx) : Infinity
  const sy = Math.abs(dy) > 1e-9 ? a.h / 2 / Math.abs(dy) : Infinity
  const f = Math.min(sx, sy)
  if (f >= 1) return [p[0], p[1]]
  return [cx(a) - dx * f, cy(a) - dy * f]
}

/** The leader from a box on `side` of its tile `a` (units): the middle of
 * the box's facing edge to the tile's edge, aimed at its centre. */
export function leaderFor(box: Box, a: Box, side: CalloutSide): [Pt, Pt] {
  const p = leaderStart(box, side)
  return [p, tileEnd(p, a)]
}

const leaderLength = (l: [Pt, Pt]) =>
  Math.hypot(l[1][0] - l[0][0], l[1][1] - l[0][1])

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

/** A box on `side` of tile `a`, `d` from it, shifted `off` along the
 * side (its centre from the tile's). */
function boxBy(
  a: Box,
  side: CalloutSide,
  d: number,
  off: number,
  size: { w: number; h: number }
): Box {
  const { w, h } = size
  switch (side) {
    case "top":
      return { x: cx(a) + off - w / 2, y: a.y - d - h, w, h }
    case "bottom":
      return { x: cx(a) + off - w / 2, y: a.y + a.h + d, w, h }
    case "left":
      return { x: a.x - d - w, y: cy(a) + off - h / 2, w, h }
    case "right":
      return { x: a.x + a.w + d, y: cy(a) + off - h / 2, w, h }
  }
}

/** The places round a tile its box may take, shortest leader first: on
 * each side, straight out or shifted along it, out a step at a time -
 * none with a leader past `max`. Ties go top, bottom, left, right, then
 * the smaller shift. */
export function nearSpots(
  it: CalloutItem,
  max: number
): { box: Box; side: CalloutSide; leader: [Pt, Pt]; len: number }[] {
  const out: {
    box: Box
    side: CalloutSide
    leader: [Pt, Pt]
    len: number
    rank: number
  }[] = []
  const sides = ["top", "bottom", "left", "right"] as const
  sides.forEach((side, si) => {
    const along = horizontal(side) ? it.size.w : it.size.h
    const offs = [0, 0.35, -0.35, 0.7, -0.7].map((f) => f * along)
    for (let k = 0; k < 40; k++) {
      const d = NEAR_GAP + k * NEAR_STEP
      if (d > max) break
      offs.forEach((off, oi) => {
        const box = boxBy(it.anchor, side, d, off, it.size)
        const leader = leaderFor(box, it.anchor, side)
        const len = leaderLength(leader)
        if (len > max) return
        out.push({ box, side, leader, len, rank: si * 10 + oi })
      })
    }
  })
  out.sort((p, q) => p.len - q.len || p.rank - q.rank)
  return out
}

/**
 * Place the callouts. `free(box)` says a box is clear of what was placed
 * before (tiles, icons, labels); each box placed is taken for the rest.
 * Groups go in key order. A group's tiles first try one row per side of
 * their room (the nearest side), in the order of their tiles, out a step
 * at a time - kept only when no leader runs past `maxLeader`. A tile its
 * row could not seat takes the free spot nearest it. A tile with no free
 * place within reach is left out (its name hides, as a plain name with
 * nowhere to go does).
 */
export function layoutCallouts(
  items: readonly CalloutItem[],
  opts: {
    free: (b: Box) => boolean
    bounds?: Box | null
    /** Callout boxes placed before (an earlier round): no leader through
     * one. */
    prior?: readonly Box[]
    /** Their leaders: none crossed. */
    priorLeaders?: readonly [Pt, Pt][]
    /** The tiles as drawn: a leader keeps off them where it can (a
     * second try lets it cross one rather than leave a name out). */
    bodies?: { near: (b: Box, r: number) => { id: string; box: Box }[] }
    /** The longest leader (units); a last try allows twice as long. */
    maxLeader?: number
  }
): Map<string, PlacedCallout> {
  const out = new Map<string, PlacedCallout>()
  const taken: Box[] = [...(opts.prior ?? [])]
  const leaders: [Pt, Pt][] = [...(opts.priorLeaders ?? [])]
  const bounds = opts.bounds
  const inBounds = (b: Box) =>
    !bounds ||
    (b.x >= bounds.x &&
      b.y >= bounds.y &&
      b.x + b.w <= bounds.x + bounds.w &&
      b.y + b.h <= bounds.y + bounds.h)
  const clear = (b: Box) =>
    inBounds(b) && opts.free(b) && !taken.some((t) => boxesHit(t, b))
  let strict = !!opts.bodies
  let cap = opts.maxLeader ?? Infinity
  // A leader through a box placed already, across another leader or (on
  // the strict try) across another tile.
  const leaderOk = (l: [Pt, Pt], it: CalloutItem) => {
    if (leaderLength(l) > cap + 1e-6) return false
    if (taken.some((t) => segmentHitsBox(l[0], l[1], t))) return false
    if (leaders.some((o) => segmentsCross(l, o))) return false
    if (!strict || !opts.bodies) return true
    const span = {
      x: Math.min(l[0][0], l[1][0]),
      y: Math.min(l[0][1], l[1][1]),
      w: Math.abs(l[1][0] - l[0][0]),
      h: Math.abs(l[1][1] - l[0][1]),
    }
    return !opts.bodies
      .near(span, 0)
      .some((o) => o.id !== it.id && segmentHitsBox(l[0], l[1], o.box))
  }
  const boxOk = (b: Box) => !leaders.some((l) => segmentHitsBox(l[0], l[1], b))
  const take = (
    it: CalloutItem,
    box: Box,
    side: CalloutSide,
    leader: [Pt, Pt]
  ) => {
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
  // A row by the room, per side: all of it or none.
  const placeRows = (list: readonly CalloutItem[]) => {
    const bySide = new Map<CalloutSide, CalloutItem[]>()
    for (const it of list) {
      const s = sidesFor(it, bounds)[0]
      const l = bySide.get(s)
      if (l) l.push(it)
      else bySide.set(s, [it])
    }
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
      for (let k = 0; k <= MAX_STEPS; k++) {
        const d = ROW_GAP + k * step
        const boxes = row.map((it, i) => boxAt(c, side, d, starts[i], it.size))
        const ls = boxes.map((b, i) => leaderFor(b, row[i].anchor, side))
        // Too long already: a row farther out is no nearer.
        if (ls.some((l) => leaderLength(l) > cap)) break
        if (!boxes.every((b) => clear(b) && boxOk(b))) continue
        if (!ls.every((l, i) => leaderOk(l, row[i]))) continue
        // No leader through a box of its own row, nor across another's.
        if (
          ls.some(
            (l, i) =>
              boxes.some((b, j) => j !== i && segmentHitsBox(l[0], l[1], b)) ||
              ls.some((o, j) => j > i && segmentsCross(l, o))
          )
        )
          continue
        row.forEach((it, i) => take(it, boxes[i], side, ls[i]))
        break
      }
    }
  }
  // The rest, one by one, at the free spot nearest the tile.
  const placeNear = (list: readonly CalloutItem[]) => {
    const rest = list
      .filter((it) => !out.has(it.id))
      .sort(
        (p, q) =>
          cy(p.anchor) - cy(q.anchor) ||
          cx(p.anchor) - cx(q.anchor) ||
          (p.id < q.id ? -1 : p.id > q.id ? 1 : 0)
      )
    // A spot is free: a little air round its box (two never read as
    // one), no leader through it, its own leader clear.
    const fits = (it: CalloutItem, s: ReturnType<typeof nearSpots>[number]) =>
      clear({
        x: s.box.x - BOX_GAP / 2,
        y: s.box.y - BOX_GAP / 2,
        w: s.box.w + BOX_GAP,
        h: s.box.h + BOX_GAP,
      }) &&
      boxOk(s.box) &&
      leaderOk(s.leader, it)
    const spots = new Map(rest.map((it) => [it.id, nearSpots(it, cap)]))
    // The tile with the fewest free spots goes first (a few at a time, in
    // a crowd: in order), so a crowded tile is not boxed in by its
    // neighbours' choices.
    const FEW = 400
    while (rest.length) {
      let pick = 0
      if (rest.length <= 40) {
        let fewest = Infinity
        rest.forEach((it, i) => {
          let n = 0
          for (const s of spots.get(it.id)!)
            if (fits(it, s) && ++n >= FEW) break
          if (n < fewest) {
            fewest = n
            pick = i
          }
        })
      }
      const it = rest.splice(pick, 1)[0]
      const s = spots.get(it.id)!.find((x) => fits(it, x))
      if (s) take(it, s.box, s.side, s.leader)
    }
  }
  const keys = [...groups.keys()].sort()
  for (const key of keys) {
    // Tiles in no room (out on a site map): each by its own tile.
    if (!key.startsWith("near:")) placeRows(groups.get(key)!)
    placeNear(groups.get(key)!)
  }
  // Again for the rest: a leader twice as long, then (as long, then
  // twice) free to cross a tile - a long line reads better than one over
  // another tile.
  const base = cap
  const again = (c: number, s: boolean) => {
    cap = c
    strict = s
    for (const key of keys) placeNear(groups.get(key)!)
  }
  const tries: [number, boolean][] = [
    [base * 2, strict],
    ...(strict
      ? ([
          [base, false],
          [base * 2, false],
        ] as [number, boolean][])
      : []),
  ]
  for (const [c, s] of tries) if (Number.isFinite(c) || !s) again(c, s)
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

/** Tiles near each other (their drawn boxes within `join` units, chained)
 * as clusters: each tile's cluster number - the same for a whole
 * cluster, whatever the order. */
export function calloutClusters(
  tiles: readonly { id: string; box: Box }[],
  join: number
): Map<string, number> {
  const index = new BoxIndex(Math.max(16, join * 2))
  const at = new Map<string, number>()
  tiles.forEach((t, i) => {
    index.add(t.id, t.box)
    at.set(t.id, i)
  })
  const parent = tiles.map((_, i) => i)
  const find = (i: number): number =>
    parent[i] === i ? i : (parent[i] = find(parent[i]))
  tiles.forEach((t, i) => {
    for (const o of index.near(t.box, join, t.id)) {
      const a = find(i)
      const b = find(at.get(o.id)!)
      if (a !== b) parent[Math.max(a, b)] = Math.min(a, b)
    }
  })
  // Numbered by the cluster's first id: the same in any input order.
  const first = new Map<number, string>()
  tiles.forEach((t, i) => {
    const r = find(i)
    const f = first.get(r)
    if (f === undefined || t.id < f) first.set(r, t.id)
  })
  const names = [...new Set(first.values())].sort()
  const out = new Map<string, number>()
  tiles.forEach((t, i) => out.set(t.id, names.indexOf(first.get(find(i))!)))
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
