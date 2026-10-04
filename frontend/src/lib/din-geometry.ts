import type { DeviceTypeMini, DinProfile, DinRail } from "@/lib/api"

// DIN rails on a cabinet's mounting plate (#277) - the TS twin of
// `api/din.py`, so the rail editor flags what the server would refuse, in the
// server's own words, before anything is sent.
//
// A rail is placed by its left end (`x_mm`) and its centreline (`y_mm`), both
// from the plate's top-left corner, and by its length; its profile sets the
// height of the band it takes on the plate. Tenths of a millimetre. The
// checks compare whole tenths, as the server's Decimals do, so a rail that
// touches an edge at 0.1 + 0.2 never reads as a hair past it.

/** The band a rail of each profile takes on the plate, in mm. */
export const PROFILE_HEIGHT_MM: Record<DinProfile, number> = {
  ts35: 35,
  ts15: 15,
  g32: 32,
}

export const PROFILE_LABELS: Record<DinProfile, string> = {
  ts35: "TS 35",
  ts15: "TS 15",
  g32: "G 32",
}

/** The profiles in the order a picker offers them. */
export const DIN_PROFILES: DinProfile[] = ["ts35", "ts15", "g32"]

/** What the geometry reads off a rail. */
export type RailGeometry = Pick<
  DinRail,
  "label" | "profile" | "x_mm" | "y_mm" | "length_mm"
>

/** A field a rail's error can land on. */
export type RailField =
  | "id"
  | "label"
  | "profile"
  | "x_mm"
  | "y_mm"
  | "length_mm"

/** One rail's field errors, the shape the server answers with:
 * `{y_mm: ["Overlaps rail C."]}`. Empty for a rail that is fine. */
export type RailErrors = Partial<Record<RailField, string[]>>

export function hasRailErrors(e: RailErrors): boolean {
  return Object.values(e).some((m) => m.length > 0)
}

/** Round to the 0.1 mm the API keeps. */
export function roundMm(v: number): number {
  return Math.round(v * 10) / 10
}

/** A length as the server's messages print it: "500", "512.5". */
export function fmtMm(v: number): string {
  return String(roundMm(v))
}

/** Top and bottom of the rail's band on the plate, in mm. */
export function band(
  rail: Pick<RailGeometry, "profile" | "y_mm">
): [number, number] {
  const half = PROFILE_HEIGHT_MM[rail.profile] / 2
  return [rail.y_mm - half, rail.y_mm + half]
}

/** Left and right end of the rail, in mm. */
export function span(
  rail: Pick<RailGeometry, "x_mm" | "length_mm">
): [number, number] {
  return [rail.x_mm, rail.x_mm + rail.length_mm]
}

// The same intervals in whole tenths. Half a band is 17.5, 7.5 or 16 mm, so
// a band edge is a whole number of tenths too.
const tenths = (v: number) => Math.round(v * 10)

function bandTenths(r: RailGeometry): [number, number] {
  const half = PROFILE_HEIGHT_MM[r.profile] * 5
  const y = tenths(r.y_mm)
  return [y - half, y + half]
}

function spanTenths(r: RailGeometry): [number, number] {
  const x = tenths(r.x_mm)
  return [x, x + tenths(r.length_mm)]
}

/** Open intervals: rails that only touch do not overlap. */
const overlaps = (a: [number, number], b: [number, number]) =>
  a[0] < b[1] && b[0] < a[1]

/** Field errors per rail (`{}` for a rail that is fine), in input order -
 * `rail_errors` in api/din.py, message for message. Every rail lies on the
 * plate, labels are unique, and no two rails' bands overlap where the rails
 * run side by side. A clash lands on the later rail and names the first
 * earlier rail it hits. */
export function railErrors(
  rails: RailGeometry[],
  width: number,
  height: number
): RailErrors[] {
  const w = tenths(width)
  const h = tenths(height)
  const errors: RailErrors[] = rails.map(() => ({}))
  const seen = new Set<string>()
  rails.forEach((r, i) => {
    const err = errors[i]
    const add = (field: RailField, message: string) => {
      ;(err[field] ??= []).push(message)
    }
    if (seen.has(r.label)) add("label", "Another rail has this label.")
    seen.add(r.label)
    if (spanTenths(r)[1] > w)
      add("length_mm", `Runs past the plate's right edge (${fmtMm(width)} mm).`)
    const [top, bottom] = bandTenths(r)
    if (top < 0) add("y_mm", "Sticks out above the plate.")
    else if (bottom > h)
      add("y_mm", `Sticks out below the plate (${fmtMm(height)} mm).`)
    const hit = rails
      .slice(0, i)
      .find(
        (o) =>
          overlaps(spanTenths(r), spanTenths(o)) &&
          overlaps(bandTenths(r), bandTenths(o))
      )
    if (hit) add("y_mm", `Overlaps rail ${hit.label}.`)
  })
  return errors
}

// ── one rail's own fields ───────────────────────────────────────────────────

/** A rail as an editor holds it: the numbers as typed, so a cleared field
 * stays blank instead of turning into 0. */
export interface RailDraft {
  label: string
  profile: DinProfile
  x_mm: string
  y_mm: string
  length_mm: string
}

const NUMBER_FIELDS = ["x_mm", "y_mm", "length_mm"] as const
const MIN_MM: Record<(typeof NUMBER_FIELDS)[number], number> = {
  x_mm: 0,
  y_mm: 0,
  length_mm: 10,
}
const MAX_MM = 5000
const MAX_LABEL = 32

/** One rail's own fields, checked the way the rail serializer checks them
 * before the set is: a label (at most 32 characters, surrounding spaces
 * trimmed), and numbers with at most one decimal, from 0 (a length from 10)
 * to 5000. `rail` is null while a number does not parse. */
export function parseRailDraft(d: RailDraft): {
  rail: RailGeometry | null
  errors: RailErrors
} {
  const errors: RailErrors = {}
  const label = d.label.trim()
  if (!label) errors.label = ["This field may not be blank."]
  else if (label.length > MAX_LABEL)
    errors.label = [
      `Ensure this field has no more than ${MAX_LABEL} characters.`,
    ]
  const n = { x_mm: 0, y_mm: 0, length_mm: 0 }
  let parsed = true
  for (const f of NUMBER_FIELDS) {
    const text = d[f].trim()
    const v = Number(text)
    if (text === "" || !Number.isFinite(v)) {
      errors[f] = ["A valid number is required."]
      parsed = false
      continue
    }
    n[f] = v
    if (Math.abs(v * 10 - Math.round(v * 10)) > 1e-6)
      errors[f] = ["Ensure that there are no more than 1 decimal places."]
    else if (v < MIN_MM[f])
      errors[f] = [
        `Ensure this value is greater than or equal to ${MIN_MM[f]}.`,
      ]
    else if (v > MAX_MM)
      errors[f] = [`Ensure this value is less than or equal to ${MAX_MM}.`]
  }
  return {
    rail: parsed ? { label, profile: d.profile, ...n } : null,
    errors,
  }
}

// ── placing rails ───────────────────────────────────────────────────────────

/** Where "Add rail" puts the first rail's centreline, from the plate's top. */
export const FIRST_RAIL_Y_MM = 75
/** How far below the lowest rail's centreline the next one goes. */
export const RAIL_PITCH_MM = 125

/** "R1", "R2", … - the first one no rail is labelled. */
export function nextRailLabel(labels: string[]): string {
  const used = new Set(labels.map((l) => l.trim()))
  let n = 1
  while (used.has(`R${n}`)) n++
  return `R${n}`
}

/** The rail "Add rail" adds: the plate's full width from its left edge, its
 * centreline 125 mm below the lowest rail's (75 mm from the top for the
 * first). Where that does not fit, the first free spot from the top down;
 * where nothing is free, the same spot kept on the plate, to be moved by
 * hand. `labels` are every label in use, rails whose numbers do not parse
 * yet included. */
export function newRail(
  rails: RailGeometry[],
  width: number,
  height: number,
  {
    labels = rails.map((r) => r.label),
    profile = "ts35",
  }: { labels?: string[]; profile?: DinProfile } = {}
): RailGeometry {
  const label = nextRailLabel(labels)
  const at = (y: number): RailGeometry => ({
    label,
    profile,
    x_mm: 0,
    y_mm: roundMm(y),
    length_mm: roundMm(width),
  })
  const fits = (y: number) => {
    const errors = railErrors([...rails, at(y)], width, height)
    return !hasRailErrors(errors[errors.length - 1])
  }
  const half = PROFILE_HEIGHT_MM[profile] / 2
  const preferred = rails.length
    ? Math.max(...rails.map((r) => r.y_mm)) + RAIL_PITCH_MM
    : FIRST_RAIL_Y_MM
  if (fits(preferred)) return at(preferred)
  // The highest free spot sits on the plate's top edge or just under a band.
  const free = [half, ...rails.map((r) => band(r)[1] + half)]
    .sort((a, b) => a - b)
    .find(fits)
  if (free !== undefined) return at(free)
  return at(Math.min(Math.max(preferred, half), height - half))
}

/** Keep a moved rail on the plate: its left end within [0, width - length]
 * and its band within [0, height]. A rail longer than the plate stays at
 * the left edge. */
export function clampToPlate(
  rail: Pick<RailGeometry, "profile" | "length_mm">,
  x: number,
  y: number,
  width: number,
  height: number
): { x_mm: number; y_mm: number } {
  const half = PROFILE_HEIGHT_MM[rail.profile] / 2
  const clamp = (v: number, lo: number, hi: number) =>
    Math.min(Math.max(v, lo), Math.max(lo, hi))
  return {
    x_mm: roundMm(clamp(x, 0, width - rail.length_mm)),
    y_mm: roundMm(clamp(y, half, height - half)),
  }
}

// ── devices on a rail ───────────────────────────────────────────────────────
// A device sits on a rail at an offset from the rail's left end and takes its
// type's width from there; devices on one rail may touch but not overlap.
// `spans`, `free_gaps` and the no-offset path of `place` in api/din.py.

/** A stretch of a rail, from and to the rail's left end, in mm. */
export type RailSpan = [number, number]

/** What the gap math reads off a device row. */
export interface RailDevice {
  id: string
  din_offset_mm: number | null
  device_type: { width_mm: number | null } | null
}

/** The stretches the devices on one rail take, left to right. A device whose
 * type has no width takes none, as on the server; `exclude` leaves one out -
 * the device being moved. */
export function railSpans(
  devices: RailDevice[],
  exclude?: string | null
): RailSpan[] {
  return devices
    .filter((d) => d.id !== exclude && d.din_offset_mm != null)
    .map(spanOf)
    .sort((a, b) => a[0] - b[0])
}

/** The stretch a device on a rail takes: from its offset, its type's width. */
function spanOf(d: RailDevice): RailSpan {
  const start = d.din_offset_mm ?? 0
  return [start, roundMm(start + (d.device_type?.width_mm ?? 0))]
}

/** The free stretches of a rail `length` mm long around the `taken` spans,
 * left to right. Spans that touch leave no gap between them. */
export function freeGaps(length: number, taken: RailSpan[]): RailSpan[] {
  const gaps: RailSpan[] = []
  let at = 0
  for (const [start, end] of [...taken].sort((a, b) => a[0] - b[0])) {
    if (tenths(start) > tenths(at)) gaps.push([at, start])
    at = Math.max(at, end)
  }
  if (tenths(at) < tenths(length)) gaps.push([at, length])
  return gaps
}

/** Where the server puts a device `width` mm wide sent with a rail and no
 * offset: the left end of the first gap from the left it fits in. Null when
 * none fits - "No gap on R1 is 90 mm wide." */
export function firstFit(gaps: RailSpan[], width: number): number | null {
  const hit = gaps.find(
    ([start, end]) => tenths(end) - tenths(start) >= tenths(width)
  )
  return hit ? hit[0] : null
}

/** The widest free stretch, in mm; 0 on a full rail. */
export function widestGap(gaps: RailSpan[]): number {
  return gaps.reduce((w, [start, end]) => Math.max(w, roundMm(end - start)), 0)
}

/** "0-120, 210-525 mm" - gaps as the server's messages print a span. */
export function fmtGaps(gaps: RailSpan[]): string {
  if (gaps.length === 0) return ""
  return `${gaps.map(([s, e]) => `${fmtMm(s)}-${fmtMm(e)}`).join(", ")} mm`
}

// ── placing a device by pointer ─────────────────────────────────────────────
// The device form draws the cabinet's plate under its fields: a click on a
// rail puts the device there, a drag moves it along a rail or onto another,
// and the arrow keys nudge it. These decide where it lands - on the rail and
// over no device, as the server takes it - and what the server says where it
// can't go.

/** A moved device snaps flush to an edge this close, in mm. */
export const SNAP_MM = 3

/** A device on a rail, named for the messages: where it sits, from the
 * rail's left end. */
export interface RailNeighbour {
  name: string
  span: RailSpan
}

/** The devices on one rail, named, left to right - `railSpans` for the
 * messages that name them. `exclude` leaves out the device being moved. */
export function railNeighbours(
  devices: (RailDevice & { name: string; din_rail: { id: string } | null })[],
  railId: string,
  exclude?: string | null
): RailNeighbour[] {
  return devices
    .filter(
      (d) =>
        d.din_rail?.id === railId && d.id !== exclude && d.din_offset_mm != null
    )
    .map((d) => ({ name: d.name, span: spanOf(d) }))
    .sort((a, b) => a.span[0] - b.span[0])
}

/** Whether a device of `type` goes on a rail of `profile`: the type lists
 * the profile and has a width. Any rail while the type is unknown. */
export function mountsOn(
  type: Pick<DeviceTypeMini, "din_profiles" | "width_mm"> | null | undefined,
  profile: DinProfile
): boolean {
  if (!type) return true
  return type.width_mm != null && type.din_profiles.includes(profile)
}

/** A device's left edge `offset` moved flush against the nearest edge within
 * `tolerance`: its left edge against the rail's left end or a device's right
 * edge, its right edge against the rail's right end or a device's left edge.
 * Unchanged where no edge is that close. */
export function snapFlush(
  offset: number,
  width: number,
  length: number,
  taken: RailSpan[],
  tolerance = SNAP_MM
): number {
  const candidates = [
    0,
    ...taken.map(([, end]) => end),
    length - width,
    ...taken.map(([start]) => start - width),
  ]
  let best = offset
  let dist = Infinity
  for (const c of candidates) {
    const d = Math.abs(tenths(c) - tenths(offset))
    if (d <= tenths(tolerance) && d < dist) {
      best = c
      dist = d
    }
  }
  return roundMm(best)
}

/** Where a press on a rail puts a device: at `offset`, its left edge from
 * the rail's left end; on `taken`, the device the press is on; or `narrow`,
 * the free gap it is in when the device is wider than it. */
export type RailPlacement =
  | { offset: number }
  | { taken: RailSpan }
  | { narrow: RailSpan }

/** Where a device `width` mm wide goes when its left edge is put `at` mm
 * from a rail's left end - a click on the rail, or a drag let go: to the
 * millimetre, flush against an edge within `tolerance`, and moved as little
 * as it takes to lie in the free gap under `anchor` (the click; for a drag,
 * the device's middle). Refused over a device, or in a gap too narrow. */
export function placeOnRail(
  at: number,
  width: number,
  length: number,
  taken: RailSpan[],
  {
    anchor = at,
    tolerance = SNAP_MM,
  }: { anchor?: number; tolerance?: number } = {}
): RailPlacement {
  const x = tenths(Math.min(Math.max(anchor, 0), length))
  const on = taken.find(([s, e]) => tenths(s) <= x && x < tenths(e))
  if (on) return { taken: on }
  const gap = freeGaps(length, taken).find(
    ([s, e]) => tenths(s) <= x && x <= tenths(e)
  )
  if (!gap) {
    // The rail's right end, against a device that ends there.
    const last = taken.find(([s, e]) => tenths(s) <= x && x <= tenths(e))
    return { taken: last ?? [length, length] }
  }
  const [start, end] = gap
  if (tenths(end) - tenths(start) < tenths(width)) return { narrow: gap }
  const fit = (o: number) => Math.min(Math.max(o, start), end - width)
  const offset = fit(Math.round(at))
  const snapped = snapFlush(offset, width, length, taken, tolerance)
  const inGap =
    tenths(snapped) >= tenths(start) &&
    tenths(snapped) + tenths(width) <= tenths(end)
  return { offset: roundMm(inGap ? snapped : offset) }
}

/** What the server answers for a device `width` mm wide at `offset` on a
 * rail `length` mm long beside its `neighbours` - `place` in api/din.py,
 * message for message: null where it fits. Devices may touch. */
export function railClash(
  offset: number,
  width: number,
  length: number,
  neighbours: RailNeighbour[]
): string | null {
  const a = tenths(offset)
  const b = a + tenths(width)
  if (a < 0) return "Runs past the rail's start."
  if (b > tenths(length))
    return `Runs past the rail's end (${fmtMm(length)} mm).`
  const hit = neighbours.find(
    ({ span: [s, e] }) => a < tenths(e) && tenths(s) < b
  )
  return hit
    ? `Overlaps ${hit.name} at ${fmtMm(hit.span[0])}-${fmtMm(hit.span[1])} mm.`
    : null
}

/** The stretches of a device at `offset` that will not go: off either end
 * of the rail, or over a device. From the rail's left end, left to right. */
export function clashSpans(
  offset: number,
  width: number,
  length: number,
  taken: RailSpan[]
): RailSpan[] {
  const a = offset
  const b = offset + width
  const out: RailSpan[] = []
  if (tenths(a) < 0) out.push([a, Math.min(0, b)])
  for (const [s, e] of taken) {
    const lo = Math.max(a, s)
    const hi = Math.min(b, e)
    if (tenths(lo) < tenths(hi)) out.push([lo, hi])
  }
  if (tenths(b) > tenths(length)) out.push([Math.max(a, length), b])
  return out.sort((x, y) => x[0] - y[0])
}

// ── the offset slider ───────────────────────────────────────────────────────
// Under the plate, a slider along the picked rail: its keys and buttons jump
// between the gaps the device fits in, and set it flush against an end of
// the one it is in.

/** The free gaps a device `width` mm wide fits in, left to right. */
export function fittingGaps(gaps: RailSpan[], width: number): RailSpan[] {
  return gaps.filter(([s, e]) => tenths(e) - tenths(s) >= tenths(width))
}

/** The gap a device at `offset` is in: the fitting gap under its middle -
 * where it lies whole, or where it would settle if let go there. */
export function gapAt(
  gaps: RailSpan[],
  width: number,
  offset: number
): RailSpan | null {
  const mid = tenths(offset + width / 2)
  return (
    fittingGaps(gaps, width).find(
      ([s, e]) => tenths(s) <= mid && mid <= tenths(e)
    ) ?? null
  )
}

/** The start of the next (`1`) or previous (`-1`) gap the device fits in,
 * from the one it is in - or from its middle, where it is in none. Null
 * past the last. */
export function gapStep(
  gaps: RailSpan[],
  width: number,
  offset: number,
  dir: -1 | 1
): number | null {
  const fit = fittingGaps(gaps, width)
  const here = gapAt(gaps, width, offset)
  if (here) {
    const i = fit.findIndex(([s]) => s === here[0]) + dir
    return i >= 0 && i < fit.length ? fit[i][0] : null
  }
  const mid = tenths(offset + width / 2)
  const to =
    dir > 0
      ? fit.find(([s]) => tenths(s) > mid)
      : [...fit].reverse().find(([, e]) => tenths(e) < mid)
  return to ? to[0] : null
}

/** The device flush against the left (`-1`) or right (`1`) end of the gap
 * it is in: a neighbour's edge, or the rail's end. Null where it is in no
 * gap it fits. */
export function flushIn(
  gaps: RailSpan[],
  width: number,
  offset: number,
  side: -1 | 1
): number | null {
  const gap = gapAt(gaps, width, offset)
  if (!gap) return null
  return side < 0 ? gap[0] : roundMm(gap[1] - width)
}

/** The first and the last offset the device fits at; null where it fits
 * nowhere. */
export function fitRange(
  gaps: RailSpan[],
  width: number
): [number, number] | null {
  const fit = fittingGaps(gaps, width)
  if (fit.length === 0) return null
  return [fit[0][0], roundMm(fit[fit.length - 1][1] - width)]
}

/** The offset that centres a device in a gap, to the millimetre. */
export function centreIn(gap: RailSpan, width: number): number {
  return Math.round(gap[0] + (gap[1] - gap[0] - width) / 2)
}

/** What the rail picking reads off a rail. */
type RailPlace = Pick<RailGeometry, "profile" | "x_mm" | "y_mm" | "length_mm">

/** The rail a point on the plate is on: within a rail's length, and within
 * its band - or the body a device hangs from it, `above` and `below` the
 * centreline, when that reaches further. Where two reach the point, the
 * nearer centreline. Null off every rail. */
export function railAtPoint<TRail extends RailPlace>(
  rails: TRail[],
  x: number,
  y: number,
  reach: { above: number; below: number } = { above: 0, below: 0 }
): TRail | null {
  let best: TRail | null = null
  let dist = Infinity
  for (const r of rails) {
    if (x < r.x_mm || x > r.x_mm + r.length_mm) continue
    const half = PROFILE_HEIGHT_MM[r.profile] / 2
    if (y < r.y_mm - Math.max(half, reach.above)) continue
    if (y > r.y_mm + Math.max(half, reach.below)) continue
    const d = Math.abs(y - r.y_mm)
    if (d < dist) {
      best = r
      dist = d
    }
  }
  return best
}

/** The rail whose centreline runs nearest a point - where a dragged device
 * goes. */
export function nearestRail<TRail extends RailPlace>(
  rails: TRail[],
  x: number,
  y: number
): TRail | null {
  let best: TRail | null = null
  let dist = Infinity
  for (const r of rails) {
    const dx = Math.max(r.x_mm - x, 0, x - (r.x_mm + r.length_mm))
    const d = Math.hypot(dx, y - r.y_mm)
    if (d < dist) {
      best = r
      dist = d
    }
  }
  return best
}

/** The next rail up (`-1`) or down (`1`) from `from`, for the arrow keys:
 * the nearest centreline that way, and of those the one running nearest `x`
 * across the plate. Null at the top or bottom. */
export function adjacentRail<TRail extends RailPlace>(
  rails: TRail[],
  from: TRail,
  dir: -1 | 1,
  x: number
): TRail | null {
  const y = tenths(from.y_mm)
  const across = (r: TRail) =>
    Math.max(r.x_mm - x, 0, x - (r.x_mm + r.length_mm))
  const ahead = rails
    .filter((r) => (dir < 0 ? tenths(r.y_mm) < y : tenths(r.y_mm) > y))
    .sort(
      (a, b) =>
        Math.abs(a.y_mm - from.y_mm) - Math.abs(b.y_mm - from.y_mm) ||
        across(a) - across(b)
    )
  return ahead[0] ?? null
}

// ── a device's body on the plate ────────────────────────────────────────────

/** The body a device draws on the plate: its left edge at the rail's left
 * end plus its offset, its top so the rail's centreline crosses the body
 * `din_rail_mm` below its top edge (the middle when the type leaves it
 * empty). Null while the device is off a rail or its type has no size. */
export function deviceBody(
  rail: Pick<RailGeometry, "x_mm" | "y_mm">,
  offset: number | null,
  type: Pick<DeviceTypeMini, "width_mm" | "height_mm" | "din_rail_mm"> | null
): { x: number; y: number; width: number; height: number } | null {
  if (offset == null || !type?.width_mm || !type.height_mm) return null
  const railAt = type.din_rail_mm ?? type.height_mm / 2
  return {
    x: roundMm(rail.x_mm + offset),
    y: roundMm(rail.y_mm - railAt),
    width: type.width_mm,
    height: type.height_mm,
  }
}
