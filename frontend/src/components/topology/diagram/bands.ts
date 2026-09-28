import { ZONE_COLORS } from "../view-positions"
import type { Zone } from "../view-positions"
import { resolveLevels } from "../levels-param"
import type { Centre, RowSlot, RowsAt } from "./placement"
import type { Pt, Rect } from "./types"

// Layer bands on the Diagram: labelled rows stacked top to bottom ("Spine",
// "Leaf", "Compute"), and side bands beside them spanning several rows
// ("WAN", "Data Center fabric"). They live in the view document with the
// zones (`zones_by_style.diagram`, `kind: "band"`), never in the layout:
// Arrange writes card positions and bands together, and everything after
// that is geometry.
//
// Membership is geometric. A card belongs to the row its centre is in;
// nothing stores who is in which band, so what the map shows, what a drag
// carries and what draw.io nests can never disagree. A row's `rule` (the
// roles or device types it was generated from) is only used to find it
// again when Arrange runs a second time.
//
// Pure and deterministic: positions are card CENTRES (as the Diagram keeps
// them), boxes are top-left rectangles (as the canvas reports them).

export type Region = Zone
export type BandBy = "role" | "device_type"

/** Band geometry, in canvas px. */
export const BAND = {
  /** The title strip across the top of a row: the label sits centred in it
   * and it is the grip. Cards are placed below it. */
  TITLE: 32,
  /** Clear space inside a row: beside its cards, under its title (room
   * for the port names at the top of its cards) and under its cards. */
  PAD_X: 40,
  PAD_TOP: 24,
  PAD_BOTTOM: 32,
  /** Between two cards in a row. */
  GAP_X: 48,
  /** Between two lines of cards when a row wraps. */
  LINE_GAP: 40,
  /** Between two rows of a stack. */
  GAP: 24,
  /** A row wraps onto another line past this many cards… */
  MAX_PER_LINE: 12,
  /** …or this width of cards. */
  MAX_LINE_W: 2400,
  /** A side band as drawn by Add, and the gap beside the rows. */
  SIDE_W: 72,
  SIDE_GAP: 16,
  /** A row as drawn by Add. */
  NEW_H: 160,
  NEW_W: 960,
  /** The smallest a band may be resized to. */
  MIN_W: 48,
  MIN_H: 64,
} as const

/** A card as Arrange sees it: where it is now, and what groups it. */
export interface ArrangeCard {
  /** Node id (`dev:<uuid>`). */
  id: string
  /** Its box on the canvas now (top-left, measured size). */
  box: Rect
  role?: { id?: string | null; name: string } | null
  type?: { id?: string | null; name?: string | null } | null
}

export interface ArrangeInput {
  cards: readonly ArrangeCard[]
  by: BandBy
  /** The Levels organiser: role names top to bottom, and the roles bonded
   * to the level above. Used for `by: "role"` only. */
  levels?: { order: readonly string[]; bonds: readonly string[] }
  /** The regions on the map now: generated rows are replaced (a row whose
   * rule matches keeps its id, name and colour), side bands follow the
   * rows they spanned, zones stay. */
  regions?: readonly Region[]
  /** The axis the layout ranks along - `y` top to bottom (the default),
   * `x` for a side-to-side layout. With no rows yet, groups stack in their
   * mean order along it and each row keeps its cards in their order across
   * it; once there are rows, their stack is the order. */
  axis?: "x" | "y"
  /** Id for a new band (tests pass a counter). */
  newId?: (key: string) => string
}

export interface BandEdit {
  regions: Region[]
  /** New centres of the cards that moved with their band. */
  moves: Record<string, Centre>
}

// ── Reading regions ──────────────────────────────────────────────────────

export const isBand = (r: Pick<Region, "kind">) => r.kind === "band"
export const isRow = (r: Pick<Region, "kind" | "orient">) =>
  r.kind === "band" && r.orient !== "v"
export const isSide = (r: Pick<Region, "kind" | "orient">) =>
  r.kind === "band" && r.orient === "v"

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null

const swatch = (c: unknown): string | null => {
  if (typeof c !== "string") return null
  const lc = c.toLowerCase()
  return (ZONE_COLORS as readonly string[]).includes(lc) ? lc : null
}

/**
 * A saved region list as the map can use it: malformed entries dropped,
 * geometry rounded and at least a band's minimum, a band's colour one of
 * the swatches or neutral (null), ids unique. Zones keep their colour as
 * saved (the zone renderer falls back to the first swatch itself).
 */
export function normalizeRegions(raw: unknown): Region[] {
  if (!Array.isArray(raw)) return []
  const out: Region[] = []
  const ids = new Set<string>()
  for (const r of raw as unknown[]) {
    if (!r || typeof r !== "object") continue
    const o = r as Record<string, unknown>
    const id = typeof o.id === "string" && o.id ? o.id : null
    const [x, y, w, h] = [num(o.x), num(o.y), num(o.w), num(o.h)]
    if (!id || ids.has(id) || x === null || y === null || !w || !h) continue
    ids.add(id)
    const band = o.kind === "band"
    const label = typeof o.label === "string" ? o.label : ""
    const region: Region = {
      id,
      label,
      x: Math.round(x),
      y: Math.round(y),
      w: Math.round(Math.max(band ? BAND.MIN_W : 8, w)),
      h: Math.round(Math.max(band ? BAND.MIN_H : 8, h)),
      color: band
        ? swatch(o.color)
        : typeof o.color === "string"
          ? o.color
          : ZONE_COLORS[0],
    }
    if (band) {
      region.kind = "band"
      region.orient = o.orient === "v" ? "v" : "h"
      const rule = o.rule as { by?: unknown; ids?: unknown } | null | undefined
      const by = rule?.by
      if ((by === "role" || by === "device_type") && Array.isArray(rule?.ids))
        region.rule = {
          by,
          ids: (rule.ids as unknown[]).filter(
            (v): v is string => typeof v === "string"
          ),
        }
    } else if (o.kind === "zone") region.kind = "zone"
    out.push(region)
  }
  return out
}

/** Back to front: side bands, then rows, then zones - each kind in list
 * order. How the canvas, the SVG and draw.io stack them. */
export function paintOrder<T extends Pick<Region, "kind" | "orient">>(
  regions: readonly T[]
): T[] {
  const rank = (r: T) => (isSide(r) ? 0 : isRow(r) ? 1 : 2)
  return regions
    .map((r, i) => ({ r, i }))
    .sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i)
    .map(({ r }) => r)
}

const centreOf = (b: Rect): Pt => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 })
const inside = (r: Rect, p: Pt) =>
  p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h
const area = (r: Rect) => r.w * r.h

/** The row a point is in: the smallest one holding it (rows do not
 * normally overlap; when they do, the tighter one wins, as in draw.io). */
export function rowAt(regions: readonly Region[], p: Pt): Region | null {
  let best: Region | null = null
  for (const r of regions)
    if (isRow(r) && inside(r, p) && (!best || area(r) < area(best))) best = r
  return best
}

/** Each row's cards: the ones whose centre it holds. Keyed by band id;
 * every row has an entry, empty when nothing is in it. */
export function membersOf(
  regions: readonly Region[],
  boxes: Readonly<Record<string, Rect>>
): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const r of regions) if (isRow(r)) out.set(r.id, [])
  if (!out.size) return out
  for (const [id, b] of Object.entries(boxes)) {
    const row = rowAt(regions, centreOf(b))
    if (row) out.get(row.id)!.push(id)
  }
  return out
}

/** Where a card dropped at a point goes when that point is in a row: the
 * row's inside, below its title and within its padding. For
 * placement.ts's `rowsAt`. */
export function rowsAt(regions: readonly Region[]): RowsAt {
  const rows = regions.filter(isRow)
  return (p: Pt): RowSlot | null => {
    if (!rows.length) return null
    const r = rowAt(rows, p)
    if (!r) return null
    const top = r.y + BAND.TITLE
    const padX = Math.min(BAND.PAD_X, r.w / 4)
    return {
      x: r.x + padX,
      y: top,
      w: Math.max(0, r.w - 2 * padX),
      h: Math.max(0, r.y + r.h - top),
    }
  }
}

// ── Arrange ──────────────────────────────────────────────────────────────

/** FNV-1a, as base 36: a short, stable id for a generated band. */
function hash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

const ruleKey = (by: BandBy, ids: readonly string[]) =>
  `${by}:${[...ids].sort().join(",")}`

const byName = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true })

interface Group {
  key: string
  label: string
  ids: string[]
  cards: ArrangeCard[]
  /** Levels tier, when the Levels order places it. */
  tier: number | null
  /** No role / no type: always the last row. */
  none: boolean
}

function groupsOf(input: ArrangeInput, axis: "x" | "y"): Group[] {
  const { cards, by } = input
  const groups = new Map<string, Group>()
  // Levels: a tier of bonded roles is one row ("Spine + Border").
  const tiers =
    by === "role" && input.levels?.order.length
      ? resolveLevels([...input.levels.order], [...input.levels.bonds])
      : []
  const tierOf = new Map<string, number>()
  tiers.forEach((names, i) => names.forEach((n) => tierOf.set(n, i)))
  for (const c of cards) {
    let key: string
    let label: string
    let id: string | null = null
    let tier: number | null = null
    if (by === "role") {
      const name = c.role?.name ?? null
      id = c.role?.id ?? null
      tier = name !== null ? (tierOf.get(name) ?? null) : null
      key =
        tier !== null
          ? `tier:${tier}`
          : name !== null
            ? `role:${id ?? name}`
            : "none"
      label = tier !== null ? tiers[tier].join(" + ") : (name ?? "No role")
    } else {
      id = c.type?.id ?? null
      const name = c.type?.name ?? null
      key = id ? `type:${id}` : name ? `type:${name}` : "none"
      label = name ?? "No type"
    }
    let g = groups.get(key)
    if (!g) {
      g = { key, label, ids: [], cards: [], tier, none: key === "none" }
      groups.set(key, g)
    }
    g.cards.push(c)
    if (id && !g.ids.includes(id)) g.ids.push(id)
  }
  const rank = (g: Group) =>
    g.cards.reduce(
      (s, c) =>
        s + (axis === "x" ? c.box.x + c.box.w / 2 : c.box.y + c.box.h / 2),
      0
    ) / g.cards.length
  // Levels order first; then by where the layout ranked them (the core
  // first); no role / no type last.
  return [...groups.values()].sort(
    (a, b) =>
      Number(a.none) - Number(b.none) ||
      (a.tier ?? Infinity) - (b.tier ?? Infinity) ||
      rank(a) - rank(b) ||
      byName(a.label, b.label)
  )
}

/** A row's cards in lines: wrapped past MAX_PER_LINE cards or MAX_LINE_W
 * px of cards. */
function linesOf(cards: ArrangeCard[]): ArrangeCard[][] {
  const lines: ArrangeCard[][] = []
  let cur: ArrangeCard[] = []
  let w = 0
  for (const c of cards) {
    const add = (cur.length ? BAND.GAP_X : 0) + c.box.w
    if (
      cur.length &&
      (cur.length >= BAND.MAX_PER_LINE || w + add > BAND.MAX_LINE_W)
    ) {
      lines.push(cur)
      cur = []
      w = 0
    }
    w += (cur.length ? BAND.GAP_X : 0) + c.box.w
    cur.push(c)
  }
  if (cur.length) lines.push(cur)
  return lines
}

const lineWidth = (line: ArrangeCard[]) =>
  line.reduce((s, c) => s + c.box.w, 0) + BAND.GAP_X * (line.length - 1)
const lineHeight = (line: ArrangeCard[]) =>
  Math.max(...line.map((c) => c.box.h))

/** The box around a set of rects; null for none. */
function bounds(rects: readonly Rect[]): Rect | null {
  if (!rects.length) return null
  const x = Math.min(...rects.map((r) => r.x))
  const y = Math.min(...rects.map((r) => r.y))
  return {
    x,
    y,
    w: Math.max(...rects.map((r) => r.x + r.w)) - x,
    h: Math.max(...rects.map((r) => r.y + r.h)) - y,
  }
}

/**
 * Bands by role (or device type): one row per group, stacked top to
 * bottom - the Levels order when it is set, else the order the layout
 * ranked them in (mean centre along its rank axis), or the stack's own
 * order on a second run - each row's cards side by side in the order they
 * stand now, wrapped onto more lines when a row gets long. Every row is as
 * wide as the widest; its lines are centred in it.
 *
 * Returns the new centre of every card it was given and the new region
 * list: generated rows replaced (one whose rule matches keeps its id,
 * name and colour), hand-drawn rows dropped (the caller asks first), side
 * bands re-fitted to the rows they spanned, zones as they were.
 */
export function arrangeBands(input: ArrangeInput): {
  positions: Record<string, Centre>
  regions: Region[]
} {
  const regions = input.regions ?? []
  const oldRows = regions.filter(isRow)
  // Rows already there are the order: the stack runs top to bottom.
  const axis = oldRows.length ? "y" : (input.axis ?? "y")
  const across = axis === "x" ? "y" : "x"
  const groups = groupsOf(input, axis)
  const byRule = new Map<string, Region>()
  for (const r of oldRows)
    if (r.rule) byRule.set(ruleKey(r.rule.by, r.rule.ids), r)
  const taken = new Set(regions.map((r) => r.id))
  const newId =
    input.newId ??
    ((key: string) => {
      let id = `b${hash(key)}`
      for (let k = 2; taken.has(id); k++) id = `b${hash(key)}-${k}`
      return id
    })

  // Where the stack goes: where the old one stood, else over the cards.
  const oldStack = bounds(oldRows)
  const cardBox = bounds(input.cards.map((c) => c.box))
  const x0 = Math.round(oldStack?.x ?? (cardBox ? cardBox.x - BAND.PAD_X : 0))
  const y0 = Math.round(
    oldStack?.y ?? (cardBox ? cardBox.y - BAND.TITLE - BAND.PAD_TOP : 0)
  )

  const laid = groups.map((g) => {
    const mid = (c: ArrangeCard, k: "x" | "y") =>
      k === "x" ? c.box.x + c.box.w / 2 : c.box.y + c.box.h / 2
    const cards = [...g.cards].sort(
      (a, b) =>
        mid(a, across) - mid(b, across) ||
        mid(a, axis) - mid(b, axis) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    )
    const lines = linesOf(cards)
    const content = lines.reduce(
      (s, l, i) => s + lineHeight(l) + (i ? BAND.LINE_GAP : 0),
      0
    )
    return {
      g,
      lines,
      h: BAND.TITLE + BAND.PAD_TOP + content + BAND.PAD_BOTTOM,
    }
  })
  const contentW = Math.max(0, ...laid.flatMap((l) => l.lines.map(lineWidth)))
  const w = Math.round(contentW + 2 * BAND.PAD_X)

  const positions: Record<string, Centre> = {}
  const rows: Region[] = []
  const used = new Set<Region>()
  let y = y0
  for (const { g, lines, h } of laid) {
    const key = ruleKey(input.by, g.ids.length ? g.ids : [g.key])
    const rule = { by: input.by, ids: [...g.ids].sort() }
    const match = byRule.get(ruleKey(input.by, rule.ids))
    const old = match && !used.has(match) ? match : undefined
    if (old) used.add(old)
    const id = old?.id ?? newId(key)
    taken.add(id)
    rows.push({
      id,
      kind: "band",
      orient: "h",
      label: old?.label ?? g.label,
      color: old?.color ?? null,
      x: x0,
      y: Math.round(y),
      w,
      h: Math.round(h),
      rule,
    })
    let top = y + BAND.TITLE + BAND.PAD_TOP
    for (const line of lines) {
      const lh = lineHeight(line)
      let x = x0 + BAND.PAD_X + (contentW - lineWidth(line)) / 2
      for (const c of line) {
        positions[c.id] = [
          Math.round(x + c.box.w / 2),
          Math.round(top + lh / 2),
        ]
        x += c.box.w + BAND.GAP_X
      }
      top += lh + BAND.LINE_GAP
    }
    y += h + BAND.GAP
  }

  // Side bands follow the rows they spanned, and stay beside the stack.
  const newById = new Map(rows.map((r) => [r.id, r]))
  const newStack = bounds(rows)
  const sides = regions.filter(isSide).map((s) => {
    if (!oldStack || !newStack) return s
    const spanned = oldRows.filter((r) => {
      const mid = r.y + r.h / 2
      return mid >= s.y && mid <= s.y + s.h
    })
    const now = spanned
      .map((r) => newById.get(r.id))
      .filter((r): r is Region => !!r)
    if (!now.length || now.length !== spanned.length) return s
    const top = Math.min(...now.map((r) => r.y))
    const bottom = Math.max(...now.map((r) => r.y + r.h))
    const right = oldStack.x + oldStack.w
    const dx =
      s.x >= right
        ? newStack.x + newStack.w - right
        : s.x + s.w <= oldStack.x
          ? newStack.x - oldStack.x
          : 0
    return { ...s, x: s.x + dx, y: top, h: bottom - top }
  })

  return {
    positions,
    regions: [...regions.filter((r) => !isBand(r)), ...sides, ...rows],
  }
}

/** Remove every band; zones stay. Cards stay where they are. */
export function clearBands(regions: readonly Region[]): Region[] {
  return regions.filter((r) => !isBand(r))
}

/** Rows drawn by hand (no rule): what Arrange and Clear replace. */
export const handDrawn = (regions: readonly Region[]) =>
  regions.filter((r) => isBand(r) && !r.rule)

// ── Editing rows ─────────────────────────────────────────────────────────

const overlapsX = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w

/** The rows stacked with `row`: every row sharing some of its width,
 * itself included, top to bottom. */
export function stackOf(regions: readonly Region[], row: Region): Region[] {
  return regions
    .filter((r) => isRow(r) && overlapsX(r, row))
    .sort((a, b) => a.y - b.y || byName(a.id, b.id))
}

/** Move the cards of each moved row with it. */
function carry(
  before: readonly Region[],
  after: readonly Region[],
  boxes: Readonly<Record<string, Rect>>
): Record<string, Centre> {
  const members = membersOf(before, boxes)
  const now = new Map(after.map((r) => [r.id, r]))
  const moves: Record<string, Centre> = {}
  for (const r of before) {
    const n = now.get(r.id)
    if (!isRow(r) || !n) continue
    const dx = n.x - r.x
    const dy = n.y - r.y
    if (!dx && !dy) continue
    for (const id of members.get(r.id) ?? []) {
      const c = centreOf(boxes[id])
      moves[id] = [Math.round(c.x + dx), Math.round(c.y + dy)]
    }
  }
  return moves
}

/**
 * Restack rows in a new order: the rows named in `order` take the slots
 * the same rows filled (top to bottom, each slot keeping the gap above
 * it), and their cards move with them. Rows not named stay put.
 */
export function reorderRows(
  regions: readonly Region[],
  boxes: Readonly<Record<string, Rect>>,
  order: readonly string[]
): BandEdit {
  const byId = new Map(regions.map((r) => [r.id, r]))
  const rows = order
    .map((id) => byId.get(id))
    .filter((r): r is Region => !!r && isRow(r))
  if (rows.length < 2) return { regions: [...regions], moves: {} }
  const slots = [...rows].sort((a, b) => a.y - b.y)
  const gaps = slots.map((r, i) =>
    i ? r.y - (slots[i - 1].y + slots[i - 1].h) : 0
  )
  const next = new Map<string, Region>()
  let y = slots[0].y
  rows.forEach((r, i) => {
    y += gaps[i]
    next.set(r.id, { ...r, y })
    y += r.h
  })
  const out = regions.map((r) => next.get(r.id) ?? r)
  return { regions: out, moves: carry(regions, out, boxes) }
}

/** One row up (-1) or down (+1) its stack, swapping with its neighbour. */
export function reorderRow(
  regions: readonly Region[],
  boxes: Readonly<Record<string, Rect>>,
  id: string,
  dir: -1 | 1
): BandEdit {
  const row = regions.find((r) => r.id === id)
  if (!row || !isRow(row)) return { regions: [...regions], moves: {} }
  const stack = stackOf(regions, row)
  const i = stack.indexOf(row)
  const j = i + dir
  if (j < 0 || j >= stack.length) return { regions: [...regions], moves: {} }
  const order = stack.map((r) => r.id)
  ;[order[i], order[j]] = [order[j], order[i]]
  return reorderRows(regions, boxes, order)
}

/**
 * A row resized from its bottom or right edge to `rect`. Taller: the rows
 * stacked below it move down by the difference, with their cards, and a
 * side band that spanned its bottom edge grows with it. Wider: the rows
 * that were as wide as it (a stack Arrange made) widen with it, and the
 * side bands to their right keep their distance.
 */
export function resizeRow(
  regions: readonly Region[],
  boxes: Readonly<Record<string, Rect>>,
  id: string,
  rect: Rect
): BandEdit {
  const row = regions.find((r) => r.id === id)
  if (!row || !isRow(row)) return { regions: [...regions], moves: {} }
  const next: Rect = {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    w: Math.round(Math.max(BAND.MIN_W, rect.w)),
    h: Math.round(Math.max(BAND.MIN_H, rect.h)),
  }
  const bottom = row.y + row.h
  const right = row.x + row.w
  const dh = next.y + next.h - bottom
  const dw = next.x + next.w - right
  const stack = stackOf(regions, row)
  const aligned = (r: Region) =>
    Math.abs(r.x - row.x) < 1 && Math.abs(r.w - row.w) < 1
  const span = bounds(stack)!
  const out = regions.map((r) => {
    if (r.id === id) return { ...r, ...next }
    if (isRow(r) && stack.includes(r)) {
      let n = r
      if (dh && r.y >= bottom - 1) n = { ...n, y: n.y + dh }
      if (dw && aligned(r)) n = { ...n, x: next.x, w: next.w }
      return n
    }
    // A side band beside this stack: it spans the edge that moved, or
    // stands below it, or to the right of the widened rows.
    if (isSide(r) && r.y < span.y + span.h && span.y < r.y + r.h) {
      let n = r
      if (dh) {
        if (r.y >= bottom - 1) n = { ...n, y: n.y + dh }
        else if (r.y + r.h >= bottom - 1) n = { ...n, h: n.h + dh }
      }
      if (dw && r.x >= right - 1) n = { ...n, x: n.x + dw }
      return n
    }
    return r
  })
  return { regions: out, moves: carry(regions, out, boxes) }
}

/** How far a side band's ends snap to a row's edge. */
const SNAP = 16

/** A side band's top and bottom snap to the nearest row edges within a
 * few px, so one drawn by hand spans whole rows. */
export function snapSide(regions: readonly Region[], id: string): Region[] {
  const side = regions.find((r) => r.id === id)
  if (!side || !isSide(side)) return [...regions]
  const rows = regions.filter(isRow)
  if (!rows.length) return [...regions]
  const near = (v: number, edges: number[]) => {
    let best = v
    let d = SNAP + 1
    for (const e of edges)
      if (Math.abs(e - v) < d) {
        d = Math.abs(e - v)
        best = e
      }
    return best
  }
  const top = near(
    side.y,
    rows.map((r) => r.y)
  )
  const bottom = near(
    side.y + side.h,
    rows.map((r) => r.y + r.h)
  )
  if (top === side.y && bottom === side.y + side.h) return [...regions]
  if (bottom - top < BAND.MIN_H) return [...regions]
  return regions.map((r) =>
    r.id === id ? { ...r, y: top, h: bottom - top } : r
  )
}

// ── Adding bands by hand ─────────────────────────────────────────────────

/** A new row for Add ▸ Band: under the stack, as wide as it; or, with no
 * rows yet, across the cards (or centred on `at`). Neutral. */
export function newRow(
  regions: readonly Region[],
  id: string,
  cards: readonly Rect[],
  at: Pt
): Region {
  const rows = regions.filter(isRow)
  const stack = bounds(rows)
  if (stack)
    return {
      id,
      kind: "band",
      orient: "h",
      label: "Band",
      color: null,
      x: stack.x,
      y: stack.y + stack.h + BAND.GAP,
      w: stack.w,
      h: BAND.NEW_H,
    }
  const over = bounds(cards)
  const w = over ? over.w + 2 * BAND.PAD_X : BAND.NEW_W
  return {
    id,
    kind: "band",
    orient: "h",
    label: "Band",
    color: null,
    x: Math.round(over ? over.x - BAND.PAD_X : at.x - w / 2),
    y: Math.round(at.y - BAND.NEW_H / 2),
    w: Math.round(w),
    h: BAND.NEW_H,
  }
}

/** A new side band for Add ▸ Side band: to the right of the rows and of
 * the side bands already there, as tall as the stack; a pastel swatch
 * (the next one along). With no rows, centred on `at`. */
export function newSide(
  regions: readonly Region[],
  id: string,
  at: Pt
): Region {
  const rows = regions.filter(isRow)
  const sides = regions.filter(isSide)
  const color = ZONE_COLORS[(sides.length + 1) % ZONE_COLORS.length]
  const stack = bounds(rows)
  if (!stack)
    return {
      id,
      kind: "band",
      orient: "v",
      label: "Side band",
      color,
      x: Math.round(at.x - BAND.SIDE_W / 2),
      y: Math.round(at.y - 240),
      w: BAND.SIDE_W,
      h: 480,
    }
  const right = Math.max(
    stack.x + stack.w,
    ...sides.filter((s) => s.x >= stack.x + stack.w).map((s) => s.x + s.w)
  )
  return {
    id,
    kind: "band",
    orient: "v",
    label: "Side band",
    color,
    x: right + BAND.SIDE_GAP,
    y: stack.y,
    w: BAND.SIDE_W,
    h: stack.h,
  }
}
