import type { DinProfile, DinRail } from "@/lib/api"

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
