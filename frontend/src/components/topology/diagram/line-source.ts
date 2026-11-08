import type { TopologyLinkOverride } from "@/lib/api"
import type { LineType, Pt, Rect } from "./types"

// Which line a cable is drawn as, and where that choice comes from. In
// order, the first that is set wins:
//
//   1. the link's own line (`state.links[pair].line`);
//   2. its ends' device lines (`state.nodes[device].line`);
//   3. its ends' band lines (`zones_by_style.diagram[i].line`, the row the
//      card stands in);
//   4. the view's line (`filters.diagram.line`).
//
// At 2 and 3, one end set wins; both set and equal is that line; both set
// and different, the edge's source end (its A side) wins. A device line on
// one end beats a band line on the other, as level 2 comes first.

/** Where a link's line comes from: a device or a band (its id), the link
 * itself, or the view. */
export type LineFrom =
  | { kind: "link" }
  | { kind: "device"; id: string }
  | { kind: "band"; id: string }
  | { kind: "view" }

export interface ResolvedLine {
  line: LineType
  from: LineFrom
}

/** One end of a link, as the resolver reads it. */
export interface LineEnd {
  /** The device id. */
  id: string
  /** The device's own line. */
  line?: LineType
  /** The band row its card stands in, when that band sets a line. */
  band?: { id: string; line: LineType }
}

const VIEW: LineFrom = { kind: "view" }
const LINK: LineFrom = { kind: "link" }

/** The line a link is drawn as: its own, its ends' devices', its ends'
 * bands', else the view's. `a` is the edge's source end. */
export function resolveLine(
  view: LineType,
  own: LineType | undefined,
  a: LineEnd,
  b: LineEnd
): ResolvedLine {
  if (own) return { line: own, from: LINK }
  // At each level either end set wins; both set, A does (equal lines are
  // the same line either way).
  const dev = a.line ? a : b.line ? b : undefined
  if (dev?.line) return { line: dev.line, from: { kind: "device", id: dev.id } }
  const band = a.band ?? b.band
  if (band) return { line: band.line, from: { kind: "band", id: band.id } }
  return { line: view, from: VIEW }
}

/** A line type, or undefined for anything else (Default). */
export function lineTypeOf(v: unknown): LineType | undefined {
  return v === "straight" || v === "elbow" || v === "bendy" || v === "cyclical"
    ? v
    : undefined
}

/** The device lines a view sets: device id → line, from `state.nodes`. */
export function nodeLines(
  nodes: Readonly<Record<string, { line?: unknown } | undefined>> | undefined
): Record<string, LineType> {
  const out: Record<string, LineType> = {}
  for (const [id, o] of Object.entries(nodes ?? {})) {
    const line = lineTypeOf(o?.line)
    if (line) out[id] = line
  }
  return out
}

/** A device's overrides with its line set (undefined: Default); null when
 * nothing is left to keep - the device follows the view again. */
export function withNodeLine<T extends { line?: LineType }>(
  own: T | undefined,
  line: LineType | undefined
): T | null {
  const { line: _was, ...rest } = own ?? ({} as T)
  const next = (line ? { ...rest, line } : rest) as T
  const set = Object.values(next as Record<string, unknown>).some(
    (v) => v !== undefined
  )
  return set ? next : null
}

const inside = (r: Rect, p: Pt) =>
  p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h

/**
 * Each card's band, where that band sets a line: node id → band id. A card
 * is in the smallest row holding its centre (as `rowAt` in bands.ts), from
 * the saved arrangement. Empty when no band sets a line.
 */
export function bandOfCards(
  rows: readonly (Rect & { id: string })[] | undefined,
  bandLines: Readonly<Partial<Record<string, LineType>>> | undefined,
  positions: Readonly<Record<string, readonly [number, number]>> | undefined
): Map<string, string> {
  const out = new Map<string, string>()
  if (!rows?.length || !positions || !bandLines) return out
  if (!rows.some((r) => bandLines[r.id])) return out
  for (const [id, [x, y]] of Object.entries(positions)) {
    const p = { x, y }
    let best: (Rect & { id: string }) | null = null
    for (const r of rows)
      if (inside(r, p) && (!best || r.w * r.h < best.w * best.h)) best = r
    if (best && bandLines[best.id]) out.set(id, best.id)
  }
  return out
}

export interface LineContext {
  view: LineType
  links?: Readonly<Record<string, TopologyLinkOverride>>
  /** Device id → its line. */
  nodes?: Readonly<Partial<Record<string, LineType>>>
  /** Band id → its line. */
  bands?: Readonly<Partial<Record<string, LineType>>>
  /** Node id → the band (with a line) its card stands in. */
  bandOf?: ReadonlyMap<string, string>
}

/**
 * A resolver for one build: `of(source, target, pair)` takes the edge's
 * two node ids, their device ids and the pair key. With no device or band
 * lines it is the link's own line or the view's.
 */
export function lineResolver(ctx: LineContext) {
  const plain =
    !Object.keys(ctx.nodes ?? {}).length && !(ctx.bandOf?.size ?? 0)
  const end = (node: string, device: string): LineEnd => {
    const bandId = ctx.bandOf?.get(node)
    const bandLine = bandId ? ctx.bands?.[bandId] : undefined
    const line = ctx.nodes?.[device]
    return {
      id: device,
      ...(line ? { line } : {}),
      ...(bandId && bandLine ? { band: { id: bandId, line: bandLine } } : {}),
    }
  }
  return (
    source: string,
    target: string,
    sourceDevice: string,
    targetDevice: string,
    pair: string
  ): ResolvedLine => {
    const own = ctx.links?.[pair]?.line
    if (plain)
      return own ? { line: own, from: LINK } : { line: ctx.view, from: VIEW }
    return resolveLine(
      ctx.view,
      own,
      end(source, sourceDevice),
      end(target, targetDevice)
    )
  }
}

export type LineResolver = ReturnType<typeof lineResolver>
