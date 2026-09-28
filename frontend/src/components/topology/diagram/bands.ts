import { layerRules } from "@/lib/diagram/geometry"
import { approxMeasure } from "@/lib/diagram/measure"
import { BAND as PRINT_BAND } from "@/lib/diagram/theme"
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
// roles or device types it was generated from) is used to find it again
// when Arrange runs a second time, and to put a new card in its row.
//
// A row can hold several layers - "Data Center fabric" holding Access and
// Server. Chosen by hand (Layers…, Merge), such a row keeps its layers
// through Arrange (`layout` marks it), and is drawn one of two ways: a
// sub-row per layer under its one title, each with its layer's badge at
// the left (`stack`), or every card in one row (`row`). Sub-rows are
// geometry too: a layer's sub-row is where its cards in the row stand.
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
  /** Clear space inside a row: beside its cards, under its title and
   * under its cards. A Detailed map's port names take more (`LabelRoom`). */
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
  /** Between two sub-rows of a stacked row: room for the cables between
   * two layers and the port names at both ends. */
  SUB_GAP: 72,
  /** A sub-row's label - its layer's badge at the left of the sub-row -
   * as the canvas's ColorBadge draws it (the SVG and draw.io draw it from
   * the same numbers): its height, text, the room either side of the text
   * (with the badge's border), and its distance from the row's left edge
   * and from its cards. */
  SUB_H: PRINT_BAND.SUB_H,
  SUB_SIZE: PRINT_BAND.SUB_SIZE,
  SUB_WEIGHT: PRINT_BAND.SUB_WEIGHT,
  SUB_PAD: PRINT_BAND.SUB_PAD,
  SUB_EDGE: PRINT_BAND.SUB_EDGE,
} as const

/** How a row of several layers lays them out: a sub-row each, or mixed. */
export type BandLayout = "stack" | "row"

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
  /** With its colour, for a stacked row's sub-label. */
  role?: { id?: string | null; name: string; color?: string | null } | null
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
  /** A Detailed map's labels at the nubs: room kept for them. */
  room?: LabelRoom | null
}

/**
 * The room a Detailed map's end labels take (build-diagram.ts
 * `labelRoom`): a port name, then its addresses, on the straight run out
 * of each nub. Rows keep that run clear above and below their cards where
 * a cable leaves that way, and cabled cards side by side stand far enough
 * apart for a name at both ends.
 */
export interface LabelRoom {
  /** The straight run out of a nub its labels take, px (the planner's
   * `portStub` of the longest). */
  stub: number
  /** The cards cabled to each other, by node id: a pair per link. */
  links: readonly (readonly [string, string])[]
  /** Room for the lanes the cables between two rows turn in, px. */
  lanes: number
  /** More between two rows when a breakout's legs turn off there, px. */
  legs?: number
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
/** A row drawn as a sub-row per layer: its layout says so and it holds
 * more than one. */
export const isStacked = (
  r: Pick<Region, "kind" | "orient" | "layout" | "rule">
) => isRow(r) && r.layout === "stack" && (r.rule?.ids.length ?? 0) > 1
/** A row whose layers were chosen by hand: Arrange keeps it. */
const isKept = (r: Region, by: BandBy) =>
  isRow(r) && !!r.layout && r.rule?.by === by && r.rule.ids.length > 0

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
          ids: [
            ...new Set(
              (rule.ids as unknown[]).filter(
                (v): v is string => typeof v === "string"
              )
            ),
          ],
        }
      if (o.layout === "stack" || o.layout === "row") region.layout = o.layout
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

// ── Sub-rows ─────────────────────────────────────────────────────────────

/** A card's layer in a row made by `by`: its role's or type's id. */
export const layerOf = (
  c: Pick<ArrangeCard, "role" | "type">,
  by: BandBy
): string | null => (by === "role" ? c.role?.id : c.type?.id) ?? null

/** A sub-row of a stacked row: where its layer's cards in the row stand. */
export interface SubRow {
  /** The role or device type id; null for the cards of no layer the row
   * holds (dropped in by hand), which get no label. */
  layer: string | null
  /** Its badge: the role's or type's name, and a role's colour. */
  label: string
  color: string | null
  /** Its cards span this, top to bottom. */
  y: number
  h: number
  ids: string[]
}

/** A sub-row label's width: its badge round `label`. */
export const subLabelWidth = (label: string) =>
  Math.ceil(approxMeasure(label, BAND.SUB_SIZE, BAND.SUB_WEIGHT)) +
  2 * BAND.SUB_PAD

/** The room a stacked row keeps at its left for these sub-labels (and
 * the same at its right, so its cards stay under its title). */
export const gutterOf = (labels: readonly string[]) =>
  labels.some(Boolean)
    ? Math.max(...labels.map(subLabelWidth)) + 2 * BAND.SUB_EDGE
    : 0

/**
 * A stacked row's sub-rows: `members` (the cards in the row) grouped by
 * the layer its rule holds, in the rule's order, the cards of none last.
 * Each spans its cards; a layer with no card in the row has none. Empty
 * for a row that is not stacked.
 */
export function subRowsOf(
  band: Region,
  members: readonly ArrangeCard[]
): SubRow[] {
  if (!isStacked(band)) return []
  const { by, ids } = band.rule!
  const groups = new Map<string | null, ArrangeCard[]>()
  for (const c of members) {
    const l = layerOf(c, by)
    const k = l && ids.includes(l) ? l : null
    groups.set(k, [...(groups.get(k) ?? []), c])
  }
  const keys = [
    ...ids.filter((k) => groups.has(k)),
    ...(groups.has(null) ? [null] : []),
  ]
  return keys.map((k) => {
    const cs = groups.get(k)!
    const top = Math.min(...cs.map((c) => c.box.y))
    const bottom = Math.max(...cs.map((c) => c.box.y + c.box.h))
    const named = cs.find((c) => (by === "role" ? c.role : c.type?.name))
    return {
      layer: k,
      label:
        k === null
          ? ""
          : ((by === "role" ? named?.role?.name : named?.type?.name) ?? ""),
      color: k !== null && by === "role" ? (named?.role?.color ?? null) : null,
      y: top,
      h: bottom - top,
      ids: cs.map((c) => c.id).sort(byName),
    }
  })
}

/** The rules between a stacked row's sub-rows, top to bottom: halfway
 * between two that do not overlap (as the exports draw them). */
export const subDividers = (subs: readonly Pick<SubRow, "y" | "h">[]) =>
  layerRules(subs)

/** Every stacked row's sub-rows, by band id: each card in the row its
 * centre is in. */
export function stackedSubRows(
  regions: readonly Region[],
  cards: readonly ArrangeCard[]
): Map<string, SubRow[]> {
  const out = new Map<string, SubRow[]>()
  const stacked = regions.filter(isStacked)
  if (!stacked.length) return out
  const rows = regions.filter(isRow)
  const members = new Map<string, ArrangeCard[]>()
  for (const c of cards) {
    const r = rowAt(rows, centreOf(c.box))
    if (r && isStacked(r)) members.set(r.id, [...(members.get(r.id) ?? []), c])
  }
  for (const r of stacked) out.set(r.id, subRowsOf(r, members.get(r.id) ?? []))
  return out
}

// ── Slots ────────────────────────────────────────────────────────────────

/** A row's inside a card may go in: below its title, within its padding
 * (and right of its sub-labels). */
function slotOf(r: Region, subs: readonly SubRow[] = []): RowSlot {
  const top = r.y + BAND.TITLE
  const padX = Math.min(BAND.PAD_X, r.w / 4)
  const left = Math.max(padX, gutterOf(subs.map((s) => s.label)))
  return {
    x: r.x + left,
    y: top,
    w: Math.max(0, r.w - left - padX),
    h: Math.max(0, r.y + r.h - top),
    band: r.id,
  }
}

/** A sub-row's slot: its cards' span across the row's inside, so a card
 * put in it lands on their line. */
function subSlot(r: Region, subs: readonly SubRow[], y: number, h: number) {
  return { ...slotOf(r, subs), y, h }
}

/** The cards in each stacked row, for its sub-rows. */
function subRowsBy(
  regions: readonly Region[],
  cards: readonly ArrangeCard[]
): (r: Region) => SubRow[] {
  const subs = cards.length ? stackedSubRows(regions, cards) : null
  return (r) => subs?.get(r.id) ?? []
}

/**
 * Where a card dropped at a point goes when that point is in a row: the
 * row's inside, below its title and within its padding - in a stacked
 * row, the sub-row the point is in (the band round its cards, halfway to
 * the next). For placement.ts's `rowsAt`; `cards` are the cards on the
 * map, for the sub-rows.
 */
export function rowsAt(
  regions: readonly Region[],
  cards: readonly ArrangeCard[] = []
): RowsAt {
  const rows = regions.filter(isRow)
  const subsOf = subRowsBy(rows, cards)
  return (p: Pt): RowSlot | null => {
    if (!rows.length) return null
    const r = rowAt(rows, p)
    if (!r) return null
    const subs = subsOf(r)
    if (subs.length) {
      const sorted = [...subs].sort((a, b) => a.y - b.y)
      const i = sorted.findIndex(
        (s, k) =>
          k === sorted.length - 1 || p.y < (s.y + s.h + sorted[k + 1].y) / 2
      )
      const s = sorted[Math.max(0, i)]
      return subSlot(r, subs, s.y, s.h)
    }
    return slotOf(r)
  }
}

/** What a new card is, for the row its role or device type names. */
export interface RuleOf {
  role?: string | null
  type?: string | null
}

/**
 * The row a new card belongs in by what the rows were made from: the
 * first row, top to bottom, whose rule names its role (or device type) -
 * for a card added next to its neighbours, or dropped outside every row
 * or into its own row. In a stacked row, its layer's sub-row; with none
 * yet, the room between the sub-rows it goes between. Null when no row
 * was made for it.
 */
export function ruleRow(
  regions: readonly Region[],
  cards: readonly ArrangeCard[] = []
) {
  const rows = regions
    .filter((r) => isRow(r) && r.rule)
    .sort((a, b) => a.y - b.y || byName(a.id, b.id))
  const subsOf = subRowsBy(regions, cards)
  return (card: RuleOf): RowSlot | null => {
    for (const r of rows) {
      const id = r.rule!.by === "role" ? card.role : card.type
      if (!id || !r.rule!.ids.includes(id)) continue
      const subs = subsOf(r)
      if (!subs.length) return slotOf(r)
      const own = subs.find((s) => s.layer === id)
      if (own) return subSlot(r, subs, own.y, own.h)
      // Not in the row yet: between the sub-rows of the layers either
      // side of it in the rule's order.
      const order = r.rule!.ids
      const rank = (s: SubRow) =>
        s.layer === null ? Infinity : order.indexOf(s.layer)
      const mine = order.indexOf(id)
      const above = subs.filter((s) => rank(s) < mine)
      const below = subs.filter((s) => rank(s) > mine)
      const top = above.length
        ? Math.max(...above.map((s) => s.y + s.h))
        : r.y + BAND.TITLE
      const bottom = below.length
        ? Math.min(...below.map((s) => s.y))
        : r.y + r.h
      return subSlot(r, subs, top, Math.max(0, bottom - top))
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
  /** The row whose layers were chosen by hand this group fills again. */
  kept?: Region
}

/** A Levels tier's label: the names of its roles on the map, in the
 * tier's order ("Leaf + Border"). */
const tierLabel = (tier: readonly string[], present: ReadonlySet<string>) =>
  tier.filter((n) => present.has(n)).join(" + ")

/** The Levels tiers, top to bottom, and each role name's tier. */
function tiersOf(input: Pick<ArrangeInput, "by" | "levels">) {
  const tiers =
    input.by === "role" && input.levels?.order.length
      ? resolveLevels([...input.levels.order], [...input.levels.bonds])
      : []
  const tierOf = new Map<string, number>()
  tiers.forEach((names, i) => names.forEach((n) => tierOf.set(n, i)))
  return { tiers, tierOf }
}

function groupsOf(
  input: ArrangeInput,
  axis: "x" | "y",
  kept: readonly Region[]
): Group[] {
  const { cards, by } = input
  const groups = new Map<string, Group>()
  // Levels: a tier of bonded roles is one row ("Spine + Border").
  const { tiers, tierOf } = tiersOf(input)
  // A row whose layers were chosen by hand takes its layers' cards first.
  const owner = new Map<string, Region>()
  for (const r of kept)
    for (const id of r.rule!.ids) if (!owner.has(id)) owner.set(id, r)
  const ownerOf = (c: ArrangeCard) => {
    const l = layerOf(c, by)
    return l ? owner.get(l) : undefined
  }
  const present = new Set(
    cards.flatMap((c) => (c.role && !ownerOf(c) ? [c.role.name] : []))
  )
  for (const c of cards) {
    const own = ownerOf(c)
    if (own) {
      const key = `band:${own.id}`
      const t = c.role ? (tierOf.get(c.role.name) ?? null) : null
      let g = groups.get(key)
      if (!g) {
        g = {
          key,
          label: own.label,
          ids: [...own.rule!.ids],
          cards: [],
          tier: t,
          none: false,
          kept: own,
        }
        groups.set(key, g)
      }
      if (t !== null && (g.tier === null || t < g.tier)) g.tier = t
      g.cards.push(c)
      continue
    }
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

/** How far apart a row's cards stand: the usual gaps, or - with a
 * Detailed map's labels (`LabelRoom`) - far enough for a port name at
 * both ends of a cable, with lanes between. */
interface Spacing {
  /** Between two cards side by side in a line. */
  gapX: (a: string, b: string) => number
  lineGap: number
  subGap: number
  /** Between two rows of a stack. */
  rowGap: number
  /** Above and below a row's cards where a cable leaves them that way. */
  padTop: number
  padBottom: number
  /** The pairs of cabled cards (`a\0b`, both ways); empty without room. */
  pairs: ReadonlySet<string>
}

const pairKey = (a: string, b: string) => `${a}\u0000${b}`

function spacingOf(room: LabelRoom | null | undefined): Spacing {
  const pairs = new Set<string>()
  if (!room || room.stub <= 0)
    return {
      gapX: () => BAND.GAP_X,
      lineGap: BAND.LINE_GAP,
      subGap: BAND.SUB_GAP,
      rowGap: BAND.GAP,
      padTop: BAND.PAD_TOP,
      padBottom: BAND.PAD_BOTTOM,
      pairs,
    }
  for (const [a, b] of room.links) {
    pairs.add(pairKey(a, b))
    pairs.add(pairKey(b, a))
  }
  // Both ends' runs, then the lanes between.
  const across = 2 * room.stub
  const lanes = Math.max(BAND.GAP, room.lanes)
  const side = Math.max(BAND.GAP_X, across + BAND.FIT_GAP)
  return {
    gapX: (a, b) => (pairs.has(pairKey(a, b)) ? side : BAND.GAP_X),
    lineGap: Math.max(BAND.LINE_GAP, across + lanes),
    subGap: Math.max(BAND.SUB_GAP, across + lanes),
    rowGap: lanes + (room.legs ?? 0),
    padTop: Math.max(BAND.PAD_TOP, room.stub + BAND.FIT_EDGE),
    padBottom: Math.max(BAND.PAD_BOTTOM, room.stub + BAND.FIT_EDGE),
    pairs,
  }
}

/** A row's cards in lines: wrapped past MAX_PER_LINE cards or MAX_LINE_W
 * px of cards. */
function linesOf(cards: ArrangeCard[], sp: Spacing): ArrangeCard[][] {
  const lines: ArrangeCard[][] = []
  let cur: ArrangeCard[] = []
  let w = 0
  for (const c of cards) {
    const last = cur.at(-1)
    const add = (last ? sp.gapX(last.id, c.id) : 0) + c.box.w
    if (
      cur.length &&
      (cur.length >= BAND.MAX_PER_LINE || w + add > BAND.MAX_LINE_W)
    ) {
      lines.push(cur)
      cur = []
      w = 0
    }
    const prev = cur.at(-1)
    w += (prev ? sp.gapX(prev.id, c.id) : 0) + c.box.w
    cur.push(c)
  }
  if (cur.length) lines.push(cur)
  return lines
}

const lineWidth = (line: ArrangeCard[], sp: Spacing) =>
  line.reduce(
    (s, c, i) => s + c.box.w + (i ? sp.gapX(line[i - 1].id, c.id) : 0),
    0
  )
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

/** A card's middle along an axis. */
const midOf = (c: ArrangeCard, k: "x" | "y") =>
  k === "x" ? c.box.x + c.box.w / 2 : c.box.y + c.box.h / 2

/** A row's cards in the order they stand: across the rank axis, then
 * along it. */
function standing(cards: readonly ArrangeCard[], axis: "x" | "y") {
  const across = axis === "x" ? "y" : "x"
  return [...cards].sort(
    (a, b) =>
      midOf(a, across) - midOf(b, across) ||
      midOf(a, axis) - midOf(b, axis) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  )
}

/** A row's cards laid out: one block of lines, or a stacked row's sub-rows
 * (its layers in order, the cards of none after them). */
interface Laid {
  subs: { label: string; lines: ArrangeCard[][]; h: number }[]
  /** The widest line. */
  w: number
  /** From the top of the first line to the bottom of the last. */
  h: number
  /** The room its sub-labels take at its left (0: none). */
  gutter: number
  sp: Spacing
  /** Clear space under its title and under its cards. */
  padTop: number
  padBottom: number
}

function layOut(
  cards: readonly ArrangeCard[],
  axis: "x" | "y",
  layers: { by: BandBy; ids: readonly string[] } | null,
  sp: Spacing
): Laid {
  const blocks: { label: string; cards: ArrangeCard[] }[] = []
  if (layers) {
    const at = new Map<string | null, ArrangeCard[]>()
    for (const c of cards) {
      const l = layerOf(c, layers.by)
      const k = l && layers.ids.includes(l) ? l : null
      at.set(k, [...(at.get(k) ?? []), c])
    }
    for (const k of [...layers.ids, null]) {
      const cs = at.get(k)
      if (!cs?.length) continue
      const named = cs.find((c) => layerOf(c, layers.by) === k)
      const label =
        k === null
          ? ""
          : ((layers.by === "role" ? named?.role?.name : named?.type?.name) ??
            "")
      blocks.push({ label, cards: cs })
    }
  } else blocks.push({ label: "", cards: [...cards] })
  const subs = blocks.map((b) => {
    const lines = linesOf(standing(b.cards, axis), sp)
    return {
      label: b.label,
      lines,
      h: lines.reduce((s, l, i) => s + lineHeight(l) + (i ? sp.lineGap : 0), 0),
    }
  })
  return {
    subs,
    w: Math.max(
      0,
      ...subs.flatMap((b) => b.lines.map((l) => lineWidth(l, sp)))
    ),
    h: subs.reduce((s, b, i) => s + b.h + (i ? sp.subGap : 0), 0),
    gutter: layers ? gutterOf(subs.map((b) => b.label)) : 0,
    sp,
    padTop: BAND.PAD_TOP,
    padBottom: BAND.PAD_BOTTOM,
  }
}

/** A laid-out row's height. */
const rowHeight = (l: Laid) => BAND.TITLE + l.padTop + l.h + l.padBottom

/**
 * A laid-out row's padding for its labelled cables (`LabelRoom`): room
 * under its title for the ones that leave its cards upwards - to a row
 * above (`rowOf` smaller), a card in no row, or round a card of its own
 * line - and under its cards for the ones that leave downwards. Cables
 * between two cards side by side, or between its lines or sub-rows, have
 * their gap already.
 */
function padFor(l: Laid, i: number, rowOf: ReadonlyMap<string, number>): Laid {
  if (!l.sp.pairs.size) return l
  const at = new Map<string, [number, number, number]>()
  l.subs.forEach((b, s) =>
    b.lines.forEach((line, k) =>
      line.forEach((c, j) => at.set(c.id, [s, k, j]))
    )
  )
  let up = false
  let down = false
  for (const key of l.sp.pairs) {
    const [a, b] = key.split("\u0000")
    const pa = at.get(a)
    if (!pa) continue
    const j = rowOf.get(b)
    const pb = at.get(b)
    if (j === undefined && !pb) {
      up = down = true
    } else if (pb) {
      // Its own row: the same line, not side by side, goes round.
      if (pa[0] === pb[0] && pa[1] === pb[1] && Math.abs(pa[2] - pb[2]) > 1)
        up = down = true
    } else if (j! < i) up = true
    else if (j! > i) down = true
    if (up && down) break
  }
  return {
    ...l,
    padTop: up ? l.sp.padTop : BAND.PAD_TOP,
    padBottom: down ? l.sp.padBottom : BAND.PAD_BOTTOM,
  }
}

/** A laid-out row's cards placed: its lines centred across `w` from
 * `left`, the first from `top` down. */
function placeLaid(
  l: Laid,
  left: number,
  w: number,
  top: number,
  into: Record<string, Centre>
): void {
  const { sp } = l
  let y = top
  l.subs.forEach((b, i) => {
    if (i) y += sp.subGap
    b.lines.forEach((line, j) => {
      if (j) y += sp.lineGap
      const lh = lineHeight(line)
      let x = left + (w - lineWidth(line, sp)) / 2
      line.forEach((c, k) => {
        if (k) x += sp.gapX(line[k - 1].id, c.id)
        into[c.id] = [Math.round(x + c.box.w / 2), Math.round(y + lh / 2)]
        x += c.box.w
      })
      y += lh
    })
  })
}

/** The Levels order of a stacked row's layers (the roles on no level
 * after the rest, in their order); device types keep the rule's order. */
function orderLayers(
  ids: readonly string[],
  input: Pick<ArrangeInput, "by" | "levels" | "cards">
): string[] {
  const { tierOf } = tiersOf(input)
  if (!tierOf.size) return [...ids]
  const names = new Map<string, string>()
  for (const c of input.cards) if (c.role?.id) names.set(c.role.id, c.role.name)
  const tier = (id: string) => {
    const n = names.get(id)
    return n !== undefined ? (tierOf.get(n) ?? Infinity) : Infinity
  }
  return ids
    .map((id, i) => ({ id, i }))
    .sort((a, b) => tier(a.id) - tier(b.id) || a.i - b.i)
    .map(({ id }) => id)
}

/** A row's layers as its layout lays them out: a stacked row's in order,
 * else none (one block). */
function layersOf(
  r: Region,
  input: Pick<ArrangeInput, "levels" | "cards">
): { by: BandBy; ids: string[] } | null {
  if (!isStacked(r)) return null
  const by = r.rule!.by
  return { by, ids: orderLayers(r.rule!.ids, { ...input, by }) }
}

/**
 * Bands by role (or device type): one row per group, stacked top to
 * bottom - the Levels order when it is set, else the order the layout
 * ranked them in (mean centre along its rank axis), or the stack's own
 * order on a second run - each row's cards side by side in the order they
 * stand now, wrapped onto more lines when a row gets long. Every row is as
 * wide as the widest; its lines are centred in it.
 *
 * A row whose layers were chosen by hand (Layers…, Merge: `layout` set)
 * is kept as it is - its layers, name, colour and layout - and filled
 * again with its layers' cards; a stacked one lays each layer out on a
 * sub-row of its own, in the Levels order. Roles in no such row get rows
 * as above.
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
  const kept = oldRows
    .filter((r) => isKept(r, input.by))
    .sort((a, b) => a.y - b.y || byName(a.id, b.id))
  const groups = groupsOf(input, axis, kept)
  const matched = matchRows(
    oldRows.filter((r) => !kept.includes(r)),
    groups.filter((g) => !g.kept),
    input
  )
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

  const sp = spacingOf(input.room)
  const rowOf = new Map<string, number>()
  groups.forEach((g, i) => g.cards.forEach((c) => rowOf.set(c.id, i)))
  const laid = groups.map((g, i) => {
    const layers = g.kept ? layersOf(g.kept, input) : null
    return { g, layers, l: padFor(layOut(g.cards, axis, layers, sp), i, rowOf) }
  })
  const contentW = Math.max(0, ...laid.map(({ l }) => l.w))
  // Room for a stacked row's sub-labels, both sides: every row of the
  // stack stays centred under its title and as wide as the rest.
  const pad = Math.max(BAND.PAD_X, ...laid.map(({ l }) => l.gutter))
  const w = Math.round(contentW + 2 * pad)

  const positions: Record<string, Centre> = {}
  const rows: Region[] = []
  let y = y0
  for (const { g, layers, l } of laid) {
    const h = rowHeight(l)
    const box = { x: x0, y: Math.round(y), w, h: Math.round(h) }
    if (g.kept) {
      rows.push({
        ...g.kept,
        ...box,
        rule: { by: input.by, ids: layers?.ids ?? [...g.kept.rule!.ids] },
      })
      taken.add(g.kept.id)
    } else {
      const key = ruleKey(input.by, g.ids.length ? g.ids : [g.key])
      const old = matched.get(g)
      const id = old?.id ?? newId(key)
      taken.add(id)
      rows.push({
        id,
        kind: "band",
        orient: "h",
        label: old && renamed(old, input) ? old.label : g.label,
        color: old?.color ?? null,
        ...box,
        rule: { by: input.by, ids: [...g.ids].sort() },
      })
    }
    placeLaid(l, x0 + pad, contentW, y + BAND.TITLE + l.padTop, positions)
    y += h + sp.rowGap
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

// ── Layers ───────────────────────────────────────────────────────────────

/** What an edit to a row's layers works from. */
export interface LayersInput {
  regions: readonly Region[]
  /** Every card on the map (its box, role and type): who is in which
   * row, and what moves. */
  cards: readonly ArrangeCard[]
  /** The Levels organiser, for the order of a stacked row's layers. */
  levels?: ArrangeInput["levels"]
  /** A Detailed map's labels at the nubs: room kept for them. */
  room?: LabelRoom | null
}

const noEdit = (regions: readonly Region[]): BandEdit => ({
  regions: [...regions],
  moves: {},
})

const boxesOf = (cards: readonly ArrangeCard[]) =>
  Object.fromEntries(cards.map((c) => [c.id, c.box])) as Record<string, Rect>

/** Each card's row (by id), for the cards in one. */
function rowOfCards(
  regions: readonly Region[],
  cards: readonly ArrangeCard[]
): Map<string, string> {
  const out = new Map<string, string>()
  for (const [row, ids] of membersOf(regions, boxesOf(cards)))
    for (const id of ids) out.set(id, row)
  return out
}

/** Role (or type) names by id, as the cards on the map name them. */
function layerNames(cards: readonly ArrangeCard[], by: BandBy) {
  const out = new Map<string, string>()
  for (const c of cards) {
    const id = layerOf(c, by)
    const name = by === "role" ? c.role?.name : c.type?.name
    if (id && name && !out.has(id)) out.set(id, name)
  }
  return out
}

/** A row's name after its layers change: a name made of its layers'
 * names (or none, or "Band") follows them; one given by hand stays. */
function relabel(
  r: Region,
  had: readonly string[],
  next: readonly string[],
  names: ReadonlyMap<string, string>
): string {
  const made = (ids: readonly string[]) =>
    ids.flatMap((id) => names.get(id) ?? []).join(" + ")
  const label = r.label.trim()
  const generated = !label || label === "Band" || label === made(had)
  return generated && made(next) ? made(next) : r.label
}

/**
 * One stack's rows laid out again where they stand. Each row `assign`
 * names gets those cards (its own and the ones joining it), laid out as
 * its layout says - a stacked row a sub-row per layer - below its title,
 * as wide as it (wider when they need it), as tall as they need; a row
 * with no cards keeps its size. The other rows of `order` (the stack top
 * to bottom after the edit) move up or down with their cards, each gap
 * above a row kept as it was; a row the edit added gets the usual gap.
 * Returns the rows' new geometry and the cards that moved.
 */
function reflow(
  before: readonly Region[],
  after: readonly Region[],
  order: readonly string[],
  assign: ReadonlyMap<string, readonly ArrangeCard[]>,
  input: LayersInput
): { rows: Map<string, Region>; moves: Record<string, Centre> } {
  const boxes = boxesOf(input.cards)
  const was = new Map(before.map((r) => [r.id, r]))
  const now = new Map(after.map((r) => [r.id, r]))
  const members = membersOf(before, boxes)
  // The stack as it stood, with the rows the edit took out.
  const stood = before
    .filter((r) => isRow(r) && (order.includes(r.id) || !now.has(r.id)))
    .sort((a, b) => a.y - b.y || byName(a.id, b.id))
  const gapAbove = (id: string) => {
    const w = was.get(id)
    const k = w ? stood.indexOf(w) : -1
    if (k < 0) return BAND.GAP
    if (k === 0) return 0
    return w!.y - (stood[k - 1].y + stood[k - 1].h)
  }
  const rows = new Map<string, Region>()
  const moves: Record<string, Centre> = {}
  const widened: { x: number; w: number; to: number }[] = []
  // Each card's row in the stack after the edit: what its labelled
  // cables leave by.
  const sp = spacingOf(input.room)
  const rowOf = new Map<string, number>()
  order.forEach((id, k) => {
    const held = assign.get(id)?.map((c) => c.id) ?? members.get(id) ?? []
    for (const c of held) rowOf.set(c, k)
  })
  let bottom: number | null = null
  for (const [k, id] of order.entries()) {
    const r = now.get(id)
    if (!r) continue
    const w0 = was.get(id)
    const top: number =
      bottom === null ? (w0?.y ?? r.y) : bottom + Math.max(0, gapAbove(id))
    const cards = assign.get(id)
    if (cards) {
      const l = padFor(layOut(cards, "y", layersOf(r, input), sp), k, rowOf)
      const pad = Math.max(BAND.PAD_X, l.gutter)
      const w = Math.round(Math.max(r.w, l.w + 2 * pad))
      const h = cards.length ? Math.round(rowHeight(l)) : r.h
      placeLaid(l, r.x + pad, w - 2 * pad, top + BAND.TITLE + l.padTop, moves)
      if (w > r.w) widened.push({ x: r.x, w: r.w, to: w })
      rows.set(id, { ...r, y: Math.round(top), w, h })
      bottom = top + h
    } else {
      const dy = Math.round(top - (w0?.y ?? r.y))
      rows.set(id, { ...r, y: Math.round(top) })
      if (dy)
        for (const m of members.get(id) ?? []) {
          const c = centreOf(boxes[m])
          moves[m] = [Math.round(c.x), Math.round(c.y + dy)]
        }
      bottom = top + r.h
    }
  }
  // A stack keeps one width: the rows as wide as a widened one widen too.
  for (const g of widened)
    for (const [id, r] of rows)
      if (Math.abs(r.x - g.x) < 1 && Math.abs(r.w - g.w) < 1)
        rows.set(id, { ...r, w: g.to })
  return { rows, moves }
}

/**
 * Lay out again the rows in `assign`, in every stack they are in, then
 * the side bands round their rows. `after` is the region list with the
 * edit's rules, rows added and taken out; its geometry is still the one
 * `before` had (a row added sorts after the one it came from).
 */
function reflowAll(
  before: readonly Region[],
  after: readonly Region[],
  assign: ReadonlyMap<string, readonly ArrangeCard[]>,
  input: LayersInput
): BandEdit {
  const done = new Set<string>()
  const rows = new Map<string, Region>()
  const moves: Record<string, Centre> = {}
  for (const id of assign.keys()) {
    if (done.has(id)) continue
    const row = after.find((r) => r.id === id)
    if (!row || !isRow(row)) continue
    const order = stackOf(after, row).map((r) => r.id)
    for (const k of order) done.add(k)
    const res = reflow(before, after, order, assign, input)
    for (const [k, r] of res.rows) rows.set(k, r)
    Object.assign(moves, res.moves)
  }
  const out = after.map((r) => rows.get(r.id) ?? r)
  const sides = new Map(
    followRows(after.filter(isSide), bandRows(before), bandRows(out)).map(
      (r) => [r.id, r]
    )
  )
  return {
    regions: out.map((r) => sides.get(r.id) ?? r),
    moves,
  }
}

/**
 * A row's layers set by hand (Layers…): the roles (or device types, by
 * `by`) it holds, in their order. A layer belongs to one row - picked
 * here, it leaves the row that held it, and its cards there move here
 * (so do its cards outside every row); a row left with none is a row
 * drawn by hand. The row becomes one Arrange keeps; holding several
 * layers for the first time it is stacked, a sub-row each. A name made
 * of its layers' names follows them. The rows that changed are laid out
 * again where they stand, the rows under them moving with their cards.
 */
export function setLayers(
  input: LayersInput & { id: string; by: BandBy; ids: readonly string[] }
): BandEdit {
  const { regions, cards, id, by } = input
  const row = regions.find((r) => r.id === id)
  if (!row || !isRow(row)) return noEdit(regions)
  // Kept in the order its sub-rows stack in: the Levels order, then as
  // picked.
  const want = orderLayers([...new Set(input.ids)], { ...input, by })
  const names = layerNames(cards, by)
  const changed = new Set([id])
  const after = regions.map((r) => {
    if (r.id === id) {
      const had = r.rule?.by === by ? r.rule.ids : []
      const n: Region = { ...r, label: relabel(r, had, want, names) }
      if (want.length) n.rule = { by, ids: want }
      else delete n.rule
      if (!n.layout && want.length > 1)
        n.layout = had.length > 1 ? "row" : "stack"
      return n
    }
    if (
      isRow(r) &&
      r.rule?.by === by &&
      r.rule.ids.some((x) => want.includes(x))
    ) {
      changed.add(r.id)
      const left = r.rule.ids.filter((x) => !want.includes(x))
      const n: Region = { ...r, label: relabel(r, r.rule.ids, left, names) }
      if (left.length) n.rule = { by, ids: left }
      else delete n.rule
      return n
    }
    return r
  })
  const rowOf = rowOfCards(regions, cards)
  const assign = new Map<string, ArrangeCard[]>(
    [...changed].map((k) => [k, []])
  )
  for (const c of cards) {
    const at = rowOf.get(c.id)
    const l = layerOf(c, by)
    if (l && want.includes(l) && (at === undefined || changed.has(at)))
      assign.get(id)!.push(c)
    else if (at !== undefined && changed.has(at)) assign.get(at)!.push(c)
  }
  return reflowAll(regions, after, assign, input)
}

/** A row's layout (a sub-row per layer, or one row), its cards laid out
 * again that way. */
export function setLayout(
  input: LayersInput & { id: string; layout: BandLayout }
): BandEdit {
  const { regions, cards, id, layout } = input
  const row = regions.find((r) => r.id === id)
  if (!row || !isRow(row) || row.layout === layout) return noEdit(regions)
  const after = regions.map((r) => (r.id === id ? { ...r, layout } : r))
  const rowOf = rowOfCards(regions, cards)
  const mine = cards.filter((c) => rowOf.get(c.id) === id)
  return reflowAll(regions, after, new Map([[id, mine]]), input)
}

/**
 * A row and the row under it in its stack as one band (Merge with band
 * below): the upper one's id, tint and place, both names ("Access +
 * Server"), both rows' layers - of the kind the upper one holds, else the
 * lower one's - and every card of both. Holding several layers it is
 * stacked, a sub-row each (unless it was set to one row). The rows under
 * them move up with their cards. Nothing to merge with: unchanged.
 */
export function mergeDown(input: LayersInput & { id: string }): BandEdit {
  const { regions, cards, id } = input
  const row = regions.find((r) => r.id === id)
  if (!row || !isRow(row)) return noEdit(regions)
  const stack = stackOf(regions, row)
  const k = stack.indexOf(row)
  if (k + 1 >= stack.length) return noEdit(regions)
  const below = stack[k + 1]
  const by = row.rule?.by ?? below.rule?.by
  const ids = by
    ? [
        ...new Set(
          [row, below].flatMap((r) => (r.rule?.by === by ? r.rule.ids : []))
        ),
      ]
    : []
  const merged: Region = {
    ...row,
    label: [row.label, below.label].filter((l) => l.trim()).join(" + "),
    color: row.color ?? below.color,
  }
  if (by && ids.length)
    merged.rule = { by, ids: orderLayers(ids, { ...input, by }) }
  else delete merged.rule
  if (ids.length > 1) merged.layout = row.layout ?? "stack"
  const after = regions
    .filter((r) => r.id !== below.id)
    .map((r) => (r.id === id ? merged : r))
  const rowOf = rowOfCards(regions, cards)
  const both = cards.filter((c) => {
    const at = rowOf.get(c.id)
    return at === id || at === below.id
  })
  return reflowAll(regions, after, new Map([[id, both]]), input)
}

/**
 * A row of several layers as a band per layer (Split into layers), top
 * to bottom in its layers' order: each named after its layer and holding
 * its layer's cards, all in the row's tint. The first keeps the row's id
 * and place (and the cards of no layer it held); the rest stack under it,
 * and the rows below move down with their cards. A layer with no card on
 * the map is left out - there is nothing to name it by.
 */
export function splitLayers(
  input: LayersInput & { id: string; newId?: (key: string) => string }
): BandEdit {
  const { regions, cards, id } = input
  const row = regions.find((r) => r.id === id)
  if (!row || !isRow(row) || !row.rule || row.rule.ids.length < 2)
    return noEdit(regions)
  const { by } = row.rule
  const rowOf = rowOfCards(regions, cards)
  const mine = cards.filter((c) => rowOf.get(c.id) === id)
  const names = layerNames(mine, by)
  const layers = orderLayers(row.rule.ids, { ...input, by }).filter((l) =>
    names.has(l)
  )
  if (!layers.length) return noEdit(regions)
  const taken = new Set(regions.map((r) => r.id))
  const newId =
    input.newId ??
    ((key: string) => {
      let nid = `b${hash(key)}`
      for (let k = 2; taken.has(nid); k++) nid = `b${hash(key)}-${k}`
      return nid
    })
  const parts: Region[] = layers.map((l, k) => {
    const part: Region = {
      ...row,
      id: k ? newId(`${id}:${l}`) : id,
      label: names.get(l)!,
      // Stacked right under the row until laid out: the order they take.
      y: row.y + k / 1000,
      h: BAND.NEW_H,
      rule: { by, ids: [l] },
    }
    delete part.layout
    taken.add(part.id)
    return part
  })
  const after = regions.flatMap((r) => (r.id === id ? parts : [r]))
  const assign = new Map<string, ArrangeCard[]>(parts.map((p) => [p.id, []]))
  for (const c of mine) {
    const k = layers.indexOf(layerOf(c, by) ?? "")
    assign.get(parts[Math.max(0, k)].id)!.push(c)
  }
  return reflowAll(regions, after, assign, input)
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
