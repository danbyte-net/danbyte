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
  /** Between two rows of a stack: room for the lanes the cables between
   * them run in, clear of the next row's title strip. */
  GAP: 48,
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
  /** A row's title chip: its height in the strip, its text and the room
   * either side of the text (the canvas, SVG and draw.io agree). */
  CHIP_H: 24,
  CHIP_SIZE: 13,
  CHIP_PAD: 8,
  /** Least clear space a re-fitted row keeps between its cards, and
   * round a card that no longer fitted it. */
  FIT_GAP: 24,
  FIT_EDGE: 12,
} as const

/** A row's geometry, as the Diagram build takes it. */
export interface BandRow extends Rect {
  id: string
}

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

const byName = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true })

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

/** A row's inside a card may go in: below its title, within its
 * padding. */
function slotOf(r: Rect): RowSlot {
  const top = r.y + BAND.TITLE
  const padX = Math.min(BAND.PAD_X, r.w / 4)
  return {
    x: r.x + padX,
    y: top,
    w: Math.max(0, r.w - 2 * padX),
    h: Math.max(0, r.y + r.h - top),
  }
}

/** Where a card dropped at a point goes when that point is in a row: the
 * row's inside, below its title and within its padding. For
 * placement.ts's `rowsAt`. */
export function rowsAt(regions: readonly Region[]): RowsAt {
  const rows = regions.filter(isRow)
  return (p: Pt): RowSlot | null => {
    if (!rows.length) return null
    const r = rowAt(rows, p)
    return r ? slotOf(r) : null
  }
}

/** What a new card is, for the row its role or device type names. */
export interface RuleOf {
  role?: string | null
  type?: string | null
}

/** The row a new card belongs in by what Arrange made the rows from: the
 * first row, top to bottom, whose rule names its role (or device type) -
 * for a card added next to its neighbours, or dropped outside every row.
 * Null when no row was made for it. */
export function ruleRow(regions: readonly Region[]) {
  const rows = regions
    .filter((r) => isRow(r) && r.rule)
    .sort((a, b) => a.y - b.y || byName(a.id, b.id))
  return (card: RuleOf): RowSlot | null => {
    for (const r of rows) {
      const id = r.rule!.by === "role" ? card.role : card.type
      if (id && r.rule!.ids.includes(id)) return slotOf(r)
    }
    return null
  }
}

/** Do two region lists draw the same boxes (by id)? */
export function sameGeometry(
  a: readonly (Rect & { id: string })[],
  b: readonly (Rect & { id: string })[]
): boolean {
  if (a.length !== b.length) return false
  const byId = new Map(b.map((r) => [r.id, r]))
  return a.every((r) => {
    const o = byId.get(r.id)
    return !!o && o.x === r.x && o.y === r.y && o.w === r.w && o.h === r.h
  })
}

/** The rows of a region list, as the build takes them: top to bottom. */
export function bandRows(regions: readonly Region[] | undefined): BandRow[] {
  return (regions ?? [])
    .filter(isRow)
    .map(({ id, x, y, w, h }) => ({ id, x, y, w, h }))
    .sort((a, b) => a.y - b.y || byName(a.id, b.id))
}

/** A row list's geometry, as one string: what a build fitted them from. */
export const rowsSig = (rows: readonly BandRow[]) =>
  rows.map((r) => `${r.id}:${r.x}:${r.y}:${r.w}:${r.h}`).join("|")

/**
 * The regions as the map draws them: each row where the Diagram build
 * re-fitted it (`fitRows`, `fitted`), side bands following their rows.
 * Only when those rows were fitted from the rows in `regions` - a build
 * for rows since changed is not applied.
 */
export function drawnRegions<T extends Region>(
  regions: readonly T[],
  fitted: { from: string; rows: readonly BandRow[] } | null | undefined
): T[] {
  if (!fitted) return [...regions]
  const saved = bandRows(regions)
  if (rowsSig(saved) !== fitted.from || rowsSig(fitted.rows) === fitted.from)
    return [...regions]
  const byId = new Map(fitted.rows.map((r) => [r.id, r]))
  const sides = new Map(
    followRows(regions.filter(isSide), saved, fitted.rows).map((r) => [r.id, r])
  )
  return regions.map((r) => {
    const row = isRow(r) ? byId.get(r.id) : undefined
    if (row) return { ...r, x: row.x, y: row.y, w: row.w, h: row.h }
    return sides.get(r.id) ?? r
  })
}

// ── Titles ───────────────────────────────────────────────────────────────

/** The strip across the top of a row its title sits in. */
export const titleStrip = (r: Rect): Rect => ({
  x: r.x,
  y: r.y,
  w: r.w,
  h: Math.min(BAND.TITLE, r.h),
})

/** The part of a row's strip its title chip takes up and down. */
export const chipBand = (r: Rect): Rect => {
  const s = titleStrip(r)
  const h = Math.min(BAND.CHIP_H, s.h)
  return { x: s.x, y: s.y + (s.h - h) / 2, w: s.w, h }
}

/** A row's title chip width for a label `textW` px wide, within the row. */
export const chipWidth = (textW: number, rowW: number) =>
  Math.max(0, Math.min(textW + 2 * BAND.CHIP_PAD, rowW - 16))

/**
 * Where a row's title chip `w` px wide goes along its strip (its centre
 * x): the middle of the row, or - where a cable or a label crosses there
 * (`busy`, x spans the planner found in the strip) - the free spot nearest
 * the middle, so a title never hides a cable. With no free spot, the
 * middle.
 */
export function titleSpot(
  r: Rect,
  w: number,
  busy: readonly (readonly [number, number])[] = []
): number {
  const mid = r.x + r.w / 2
  const lo = r.x + 8 + w / 2
  const hi = r.x + r.w - 8 - w / 2
  if (!busy.length || hi < lo) return mid
  const free = (c: number) =>
    busy.every(([a, b]) => c + w / 2 <= a || c - w / 2 >= b)
  if (free(mid)) return mid
  let best: number | null = null
  for (const [a, b] of busy)
    for (const c of [a - w / 2, b + w / 2])
      if (
        c >= lo &&
        c <= hi &&
        free(c) &&
        (best === null ||
          Math.abs(c - mid) < Math.abs(best - mid) ||
          (Math.abs(c - mid) === Math.abs(best - mid) && c < best))
      )
        best = c
  return best ?? mid
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

/** A Levels tier's label: the names of its roles on the map, in the
 * tier's order ("Leaf + Border"). */
const tierLabel = (tier: readonly string[], present: ReadonlySet<string>) =>
  tier.filter((n) => present.has(n)).join(" + ")

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
  const present = new Set(cards.flatMap((c) => (c.role ? [c.role.name] : [])))
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
      label =
        tier !== null ? tierLabel(tiers[tier], present) : (name ?? "No role")
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
  const matched = matchRows(oldRows, groups, input)
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
  let y = y0
  for (const { g, lines, h } of laid) {
    const key = ruleKey(input.by, g.ids.length ? g.ids : [g.key])
    const rule = { by: input.by, ids: [...g.ids].sort() }
    const old = matched.get(g)
    const id = old?.id ?? newId(key)
    taken.add(id)
    rows.push({
      id,
      kind: "band",
      orient: "h",
      label: old && renamed(old, input) ? old.label : g.label,
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

  return {
    positions,
    regions: [
      ...regions.filter((r) => !isBand(r)),
      ...followRows(regions.filter(isSide), oldRows, rows),
      ...rows,
    ],
  }
}

/**
 * Side bands after their rows moved (`before` → `after`, matched by id):
 * each spans the rows it spanned, as they now stand - those still there -
 * and keeps its distance beside the stack.
 */
export function followRows<T extends Rect>(
  sides: readonly T[],
  before: readonly BandRow[],
  after: readonly BandRow[]
): T[] {
  const oldStack = bounds(before)
  const newStack = bounds(after)
  if (!oldStack || !newStack) return [...sides]
  const newById = new Map(after.map((r) => [r.id, r]))
  return sides.map((s) => {
    const spanned = before.filter((r) => {
      const mid = r.y + r.h / 2
      return mid >= s.y && mid <= s.y + s.h
    })
    const now = spanned
      .map((r) => newById.get(r.id))
      .filter((r): r is BandRow => !!r)
    if (!now.length) return s
    const top = Math.min(...now.map((r) => r.y))
    const bottom = Math.max(...now.map((r) => r.y + r.h))
    const right = oldStack.x + oldStack.w
    const dx =
      s.x >= right
        ? newStack.x + newStack.w - right
        : s.x + s.w <= oldStack.x
          ? newStack.x - oldStack.x
          : 0
    if (!dx && top === s.y && bottom - top === s.h) return s
    return { ...s, x: s.x + dx, y: top, h: bottom - top }
  })
}

/** How much two rules' ids share (Jaccard); two empty rules (the "No
 * role" row) match fully. */
function shared(a: readonly string[], b: readonly string[]): number {
  if (!a.length && !b.length) return 1
  const set = new Set(a)
  const both = b.filter((x) => set.has(x)).length
  return both / (a.length + b.length - both)
}

/**
 * The rows a second Arrange finds again: each generated row of the same
 * kind goes to the one new group its rule shares the most ids with - so a
 * row keeps its id, name and colour when a role joins or leaves its
 * Levels tier - one to one, the best pairs first.
 */
function matchRows(
  oldRows: readonly Region[],
  groups: readonly Group[],
  input: ArrangeInput
): Map<Group, Region> {
  const pairs: { g: Group; r: Region; score: number; i: number; j: number }[] =
    []
  oldRows.forEach((r, i) => {
    if (!r.rule || r.rule.by !== input.by) return
    groups.forEach((g, j) => {
      const score = shared(r.rule!.ids, g.ids)
      if (score > 0) pairs.push({ g, r, score, i, j })
    })
  })
  pairs.sort((a, b) => b.score - a.score || a.i - b.i || a.j - b.j)
  const out = new Map<Group, Region>()
  const used = new Set<Region>()
  for (const p of pairs) {
    if (out.has(p.g) || used.has(p.r)) continue
    out.set(p.g, p.r)
    used.add(p.r)
  }
  return out
}

/**
 * Was a found row renamed by hand? Not when its name is one Arrange gives:
 * "No role" / "No type", a Levels tier's role names ("Leaf + Border"), or
 * the names of the roles or types its rule holds. A generated name follows
 * the roles now in the row; a name given by hand stays.
 */
function renamed(old: Region, input: ArrangeInput): boolean {
  const label = old.label.trim()
  if (label === "No role" || label === "No type") return false
  const parts = label.split(" + ")
  if (input.by === "role" && input.levels?.order.length) {
    const tiers = resolveLevels(
      [...input.levels.order],
      [...input.levels.bonds]
    )
    if (tiers.some((t) => parts.every((p) => t.includes(p)))) return false
  }
  const names = new Map<string, string>()
  for (const c of input.cards) {
    const v = input.by === "role" ? c.role : c.type
    if (v?.id && v.name) names.set(v.id, v.name)
  }
  const mine = new Set(
    (old.rule?.ids ?? []).flatMap((id) => names.get(id) ?? [])
  )
  return !parts.every((p) => mine.has(p))
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
  // Never smaller than its cards: one left outside would change rows.
  const held = (membersOf(regions, boxes).get(id) ?? []).map((m) => boxes[m])
  const inner = bounds(held)
  const next: Rect = {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    w: Math.round(
      Math.max(
        BAND.MIN_W,
        rect.w,
        inner ? inner.x + inner.w + BAND.PAD_X - rect.x : 0
      )
    ),
    h: Math.round(
      Math.max(
        BAND.MIN_H,
        rect.h,
        inner ? inner.y + inner.h + BAND.PAD_BOTTOM - rect.y : 0
      )
    ),
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

/**
 * The rows re-fitted round their cards as they are now sized - a map
 * arranged with Simple cards drawn Detailed, or as photos: each row's
 * cards (the ones whose centre it holds) pushed apart along their line
 * where they overlap, below its title, the row grown to hold them, and the
 * rows under a grown one moved down with their cards. Rows of a stack
 * that were as wide stay as wide. Nothing moves when everything fits, so
 * a map shown as it was arranged is left exactly as it is. `boxes` are
 * the cards at their saved centres, in their size now. Returns the rows
 * (same ids, top to bottom) and the new centre of every card that moved.
 */
export function fitRows(
  rows: readonly BandRow[],
  boxes: Readonly<Record<string, Rect>>
): { rows: BandRow[]; moves: Record<string, Centre> } {
  const sorted = [...rows].sort((a, b) => a.y - b.y || byName(a.id, b.id))
  if (!sorted.length) return { rows: [], moves: {} }
  const members = membersOf(
    sorted.map((r) => ({ ...r, kind: "band", label: "", color: null })),
    boxes
  )
  const placed: Record<string, Rect> = {}
  const grown: { x0: number; x1: number; at: number; dh: number }[] = []
  const out: BandRow[] = []
  for (const r of sorted) {
    // Pushed down by every row above it that grew.
    const dy = grown
      .filter((g) => g.at <= r.y + 1 && g.x0 < r.x + r.w && r.x < g.x1)
      .reduce((s, g) => s + g.dh, 0)
    const top = r.y + dy
    const cards = (members.get(r.id) ?? []).map((id) => ({
      id,
      b: { ...boxes[id], y: boxes[id].y + dy },
    }))
    // Lines: the cards level with each other, top to bottom.
    cards.sort(
      (p, q) =>
        p.b.y + p.b.h / 2 - (q.b.y + q.b.h / 2) ||
        p.b.x - q.b.x ||
        byName(p.id, q.id)
    )
    const lines: (typeof cards)[] = []
    for (const c of cards) {
      const line = lines.at(-1)
      const cy = c.b.y + c.b.h / 2
      if (
        line &&
        cy - (line[0].b.y + line[0].b.h / 2) <
          Math.min(...line.map((m) => m.b.h)) / 2
      )
        line.push(c)
      else lines.push([c])
    }
    // The first line only moves when it reaches into the title strip.
    let floor = top + BAND.TITLE
    let lift: number = BAND.FIT_EDGE
    for (const line of lines) {
      line.sort((p, q) => p.b.x - q.b.x || byName(p.id, q.id))
      // Apart along the line, then back round where its middle was.
      const x0 = Math.min(...line.map((c) => c.b.x))
      const x1 = Math.max(...line.map((c) => c.b.x + c.b.w))
      let pushed = false
      for (let i = 1; i < line.length; i++) {
        const prev = line[i - 1].b
        const least = prev.x + prev.w + BAND.FIT_GAP
        if (line[i].b.x < least) {
          line[i].b.x = least
          pushed = true
        }
      }
      if (pushed) {
        const nx0 = line[0].b.x
        const nx1 = Math.max(...line.map((c) => c.b.x + c.b.w))
        const shift = (x0 + x1) / 2 - (nx0 + nx1) / 2
        for (const c of line) c.b.x += shift
      }
      // Below the title, or the line above.
      const lineTop = Math.min(...line.map((c) => c.b.y))
      const down = lineTop < floor ? floor + lift - lineTop : 0
      for (const c of line) c.b.y += down
      floor = Math.max(...line.map((c) => c.b.y + c.b.h))
      lift = BAND.FIT_GAP
    }
    for (const c of cards) placed[c.id] = c.b
    // Grown only where a card reaches past an edge, with room round it.
    const inner = bounds(cards.map((c) => c.b))
    const edge = BAND.FIT_EDGE
    const bottom =
      inner && inner.y + inner.h > top + r.h
        ? inner.y + inner.h + edge
        : top + r.h
    const left = inner && inner.x < r.x ? inner.x - edge : r.x
    const right =
      inner && inner.x + inner.w > r.x + r.w
        ? inner.x + inner.w + edge
        : r.x + r.w
    const dh = bottom - (top + r.h)
    if (dh > 0.5) grown.push({ x0: r.x, x1: r.x + r.w, at: r.y + r.h, dh })
    out.push({
      id: r.id,
      x: Math.round(left),
      y: Math.round(top),
      w: Math.round(right - left),
      h: Math.round(bottom - top),
    })
  }
  // A stack Arrange made keeps one width: rows that were as wide as each
  // other take the widest of them now.
  const width = new Map<string, { x0: number; x1: number }>()
  const keyOf = (r: BandRow) => `${Math.round(r.x)}:${Math.round(r.w)}`
  sorted.forEach((r, i) => {
    const k = keyOf(r)
    const w = width.get(k)
    const n = out[i]
    width.set(k, {
      x0: Math.min(w?.x0 ?? Infinity, n.x),
      x1: Math.max(w?.x1 ?? -Infinity, n.x + n.w),
    })
  })
  sorted.forEach((r, i) => {
    const w = width.get(keyOf(r))!
    out[i] = { ...out[i], x: w.x0, w: w.x1 - w.x0 }
  })
  const moves: Record<string, Centre> = {}
  for (const [id, b] of Object.entries(placed)) {
    const was = boxes[id]
    if (Math.abs(b.x - was.x) < 0.5 && Math.abs(b.y - was.y) < 0.5) continue
    moves[id] = [Math.round(b.x + b.w / 2), Math.round(b.y + b.h / 2)]
  }
  return { rows: out, moves }
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
