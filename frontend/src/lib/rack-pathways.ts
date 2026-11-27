// Rack pathways (docs/dcim/racks.md → Pathways): the labels the Pathways tab
// shows and the payloads its dialog sends. A rack's list is resolved on the
// server (`/api/rack-pathways/resolved/`): kit or frame defaults, then the
// rack type's rows, then the rack's. Editing an inherited pathway writes an
// overlay row (`key` set) carrying only what changed.

import type {
  RackPathwayFields,
  RackPathwayKind,
  RackPathwaySource,
  RackPathwaySubkind,
  ResolvedPathway,
} from "@/lib/api"

export const KIND_LABEL: Record<RackPathwayKind, string> = {
  vertical: "Vertical",
  horizontal: "Horizontal",
  entry: "Entry",
  channel: "0U channel",
}

export const SUBKIND_LABEL: Record<RackPathwaySubkind, string> = {
  finger: "Finger",
  "d-ring": "D-ring",
  channel: "Channel",
  lacing: "Lacing bar",
  brush: "Brush",
  open: "Open",
  gland: "Gland",
  sealed: "Sealed",
}

/** The subkinds each kind takes (the server's `SUBKINDS`). */
export const SUBKINDS: Record<RackPathwayKind, RackPathwaySubkind[]> = {
  vertical: ["finger", "d-ring", "channel", "lacing"],
  horizontal: ["finger", "d-ring", "channel", "lacing", "brush"],
  entry: ["open", "brush", "gland", "sealed"],
  channel: [],
}

export const SOURCE_LABEL: Record<RackPathwaySource, string> = {
  kit: "Kit",
  default: "Default",
  type: "Type",
  manual: "Manual",
}

const FACE_LABEL = { front: "front", rear: "rear", full: "full depth" }
const SURFACE_LABEL = { top: "Roof", bottom: "Floor", side: "Side panel" }

/** Where a pathway is: its side and face, or an entry's surface. */
export function whereText(
  p: Pick<ResolvedPathway, "kind" | "side" | "face" | "surface">
): string {
  if (p.kind === "entry") {
    const surface = p.surface ? SURFACE_LABEL[p.surface] : ""
    return [surface, p.surface === "side" ? p.side : ""]
      .filter(Boolean)
      .join(" ")
  }
  const side = p.side ? p.side[0].toUpperCase() + p.side.slice(1) : ""
  const face = p.face ? FACE_LABEL[p.face] : ""
  return [side, face].filter(Boolean).join(" ")
}

/** The units a pathway spans: `U1-U42`, `U12` for one. */
export function unitsText(p: Pick<ResolvedPathway, "u_from" | "u_to">): string {
  if (p.u_from == null) return ""
  if (p.u_to == null || p.u_to === p.u_from) return `U${p.u_from}`
  return `U${p.u_from}-U${p.u_to}`
}

/** The inner cross-section, or an entry's opening, in mm. */
export function sizeText(
  p: Pick<ResolvedPathway, "inner_w_mm" | "inner_d_mm">
): string {
  if (p.inner_w_mm == null && p.inner_d_mm == null) return ""
  return `${p.inner_w_mm ?? "?"} × ${p.inner_d_mm ?? "?"} mm`
}

/** Sorts kit, default, type and manual pathways in that order. */
export function sourceRank(s: RackPathwaySource): number {
  return ["kit", "default", "type", "manual"].indexOf(s)
}

/** The form's fields, as strings for the inputs. */
export type PathwayForm = Record<keyof RackPathwayFields, string>

const NUMBER_FIELDS = [
  "u_from",
  "u_to",
  "offset_mm",
  "depth_mm",
  "x_mm",
  "y_mm",
  "inner_w_mm",
  "inner_d_mm",
  "fill_limit_pct",
] as const
const TEXT_FIELDS = [
  "kind",
  "subkind",
  "side",
  "face",
  "surface",
  "name",
  "description",
] as const

/** The form for a pathway (blank for a new one). A fill limit of the
 * default shows blank. */
export function formOf(
  p: ResolvedPathway | null,
  defaultFill = 40
): PathwayForm {
  const out = {} as PathwayForm
  for (const f of TEXT_FIELDS) out[f] = p ? String(p[f]) : ""
  for (const f of NUMBER_FIELDS) {
    const v = p ? p[f] : null
    out[f] = v == null ? "" : String(v)
  }
  if (
    p &&
    p.fill_limit_pct === defaultFill &&
    !p.overridden.includes("fill_limit_pct")
  )
    out.fill_limit_pct = ""
  return out
}

function value(
  f: keyof RackPathwayFields,
  raw: string
): string | number | null {
  if ((NUMBER_FIELDS as readonly string[]).includes(f))
    return raw.trim() === "" ? null : Number(raw)
  return raw.trim()
}

/** Every field of the form as the API takes it (a pathway of its own). */
export function fullPayload(
  form: PathwayForm
): Partial<Record<keyof RackPathwayFields, unknown>> {
  const out: Partial<Record<keyof RackPathwayFields, unknown>> = {}
  for (const f of [...TEXT_FIELDS, ...NUMBER_FIELDS]) out[f] = value(f, form[f])
  return out
}

/** The fields the form changed from `initial` (an inherited pathway's
 * overlay carries only those, so the rest keeps following the kit). */
export function changedPayload(
  initial: PathwayForm,
  form: PathwayForm
): Partial<Record<keyof RackPathwayFields, unknown>> {
  const out: Partial<Record<keyof RackPathwayFields, unknown>> = {}
  for (const f of [...TEXT_FIELDS, ...NUMBER_FIELDS]) {
    if (f === "kind") continue
    if (initial[f].trim() !== form[f].trim()) out[f] = value(f, form[f])
  }
  return out
}

/** An overlay with nothing changed: every field inheriting again. */
export function resetPayload(): Record<string, unknown> {
  const out: Record<string, unknown> = {
    hidden: null,
    accessory_type_id: null,
    device_id: null,
  }
  for (const f of TEXT_FIELDS) if (f !== "kind") out[f] = ""
  for (const f of NUMBER_FIELDS) out[f] = null
  return out
}

/** Whether a resolved pathway is this level's own (edited and deleted as a
 * row) rather than inherited (edited through an overlay). */
export function isOwn(p: ResolvedPathway, level: "rack" | "type"): boolean {
  return level === "rack"
    ? p.source === "manual"
    : p.source === "type" && !!p.id && p.key === `type:${p.id}`
}

// ── On the elevation ────────────────────────────────────────────────────────
// The rack page's 2D elevation draws the pathways when its Pathways tick is
// on (components/rack-pathway-layer.tsx): these place them.

export type ElevationFace = "front" | "rear"

/** Whether a shown pathway draws on an elevation face: a vertical or
 * horizontal manager at that face or full depth, a 0U channel at that face,
 * a roof or floor entry on both. Hidden ones and rows left from a kit are
 * only listed (the Pathways tab). */
export function onFace(p: ResolvedPathway, face: ElevationFace): boolean {
  if (p.hidden || p.orphan) return false
  if (p.kind === "entry") return p.surface === "top" || p.surface === "bottom"
  if (p.u_from == null) return false
  if (p.kind === "channel") return p.face === face
  return !p.face || p.face === "full" || p.face === face
}

/** A pathway's units, low to high (one unit when it has no end). */
export function span(p: Pick<ResolvedPathway, "u_from" | "u_to">): {
  lo: number
  hi: number
} {
  const a = p.u_from ?? 0
  const b = p.u_to ?? a
  return { lo: Math.min(a, b), hi: Math.max(a, b) }
}

/** One side's vertical managers and 0U channels on a face, each in a lane
 * counted from the rails out: managers first, then channels, each taking
 * the first lane where it overlaps nothing. */
export function sideLanes(
  items: ResolvedPathway[],
  side: "left" | "right",
  face: ElevationFace
): { lanes: number; placed: { p: ResolvedPathway; lane: number }[] } {
  const mine = items
    .filter(
      (p) =>
        (p.kind === "vertical" || p.kind === "channel") &&
        p.side === side &&
        onFace(p, face)
    )
    .sort(
      (a, b) =>
        (a.kind === "vertical" ? 0 : 1) - (b.kind === "vertical" ? 0 : 1) ||
        span(a).lo - span(b).lo
    )
  const taken: { lo: number; hi: number }[][] = []
  const placed = mine.map((p) => {
    const s = span(p)
    let lane = taken.findIndex((l) =>
      l.every((o) => o.hi < s.lo || s.hi < o.lo)
    )
    if (lane < 0) lane = taken.push([]) - 1
    taken[lane].push(s)
    return { p, lane }
  })
  return { lanes: taken.length, placed }
}

/** The free run of units around `unit` that none of `spans` covers, inside
 * `first`..`last`; null when one covers `unit`. */
export function freeRun(
  spans: { lo: number; hi: number }[],
  unit: number,
  first: number,
  last: number
): { lo: number; hi: number } | null {
  if (spans.some((s) => s.lo <= unit && unit <= s.hi)) return null
  let lo = first
  let hi = last
  for (const s of spans) {
    if (s.hi < unit) lo = Math.max(lo, s.hi + 1)
    if (s.lo > unit) hi = Math.min(hi, s.lo - 1)
  }
  return { lo, hi }
}

/** What a press on an empty unit of a side strip adds: a vertical manager
 * over the free run of units there, or - where a manager already runs - a
 * 0U channel over the free run of channels. */
export function addPreset(
  items: ResolvedPathway[],
  side: "left" | "right",
  face: ElevationFace,
  unit: number,
  first: number,
  last: number
): Partial<PathwayForm> {
  const spansOf = (kind: RackPathwayKind) =>
    items
      .filter((p) => p.kind === kind && p.side === side && onFace(p, face))
      .map(span)
  const vertical = freeRun(spansOf("vertical"), unit, first, last)
  const run = vertical ??
    freeRun(spansOf("channel"), unit, first, last) ?? { lo: unit, hi: unit }
  return {
    kind: vertical ? "vertical" : "channel",
    side,
    face,
    u_from: String(run.lo),
    u_to: String(run.hi),
  }
}

/** The units a drag of one end of a vertical pathway leaves it: from the
 * end that stays to the unit the moved one is dropped on. */
export function dragSpan(
  fixed: number,
  moved: number
): { u_from: number; u_to: number } {
  return { u_from: Math.min(fixed, moved), u_to: Math.max(fixed, moved) }
}
