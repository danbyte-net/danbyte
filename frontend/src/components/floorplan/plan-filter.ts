import type { FloorPlanTile } from "@/lib/api"
import type { FacetOption } from "@/components/filter-rail"
import type { FilterSnapshot } from "@/components/table-filters"
import { evaluate, parse } from "@/lib/filter-expr"
import type { Expr } from "@/lib/filter-expr"

import { tileIsZone, tileName } from "./canvas-geometry"
import { planRooms } from "./plan-lod"
import type { PlanRoom } from "./plan-lod"
import { areaTypeOf } from "./shapes"
import type { AreaShape, Pt } from "./shapes"

// What the plan shows: a filter over its tiles, as the list pages filter
// their rows - facets (kind, device role, device type, status, tags, rack
// role, area type) ticked OR within one and AND across them, and the
// advanced expression over the same fields. What matches draws as ever, at
// every zoom (from afar as its icon on the rooms); the rest recedes, or is
// hidden. The filter is the page's state: in the URL as `?pf=`, and saved
// as a view (object type `floorplan`) like a list's.

export const FILTER_DIMS = [
  "kind",
  "role",
  "type",
  "status",
  "tag",
  "rack_role",
  "area",
] as const
export type FilterDim = (typeof FILTER_DIMS)[number]

export const FILTER_LABELS: Record<FilterDim, string> = {
  kind: "Kind",
  role: "Device role",
  type: "Device type",
  status: "Status",
  tag: "Tags",
  rack_role: "Rack role",
  area: "Area type",
}

/** The saved view's object type (core.SavedFilter.object_type). */
export const PLAN_VIEW_TYPE = "floorplan"

export interface PlanFilter {
  /** Each facet's ticked values; a facet with none is off. */
  facets: Partial<Record<FilterDim, readonly string[]>>
  /** The advanced expression ("" off). */
  expr: string
  /** Hide what does not match; else it recedes. From afar it is never
   * drawn either way. */
  hide: boolean
}

export const NO_FILTER: PlanFilter = { facets: {}, expr: "", hide: false }

/** How many facet values and expressions are on. */
export function filterCount(f: PlanFilter): number {
  let n = f.expr.trim() ? 1 : 0
  for (const d of FILTER_DIMS) n += f.facets[d]?.length ?? 0
  return n
}

export const filterIsOn = (f: PlanFilter) => filterCount(f) > 0

// ── The filter as data: URL and saved view ─────────────────────────────

/** The filter as a saved view's facets (and the URL's `pf`): each facet's
 * values, the expression under `__expr` as the lists keep it, and `hide`. */
export function filterSnapshot(f: PlanFilter): FilterSnapshot {
  const out: FilterSnapshot = {}
  for (const d of FILTER_DIMS) {
    const v = f.facets[d]
    if (v?.length) out[d] = [...v]
  }
  if (f.expr.trim()) out.__expr = f.expr.trim()
  if (f.hide && filterIsOn(f)) out.hide = "1"
  return out
}

/** A filter read back from a saved view's facets or the URL: anything not
 * understood is left out. */
export function readPlanFilter(v: unknown): PlanFilter {
  if (!v || typeof v !== "object" || Array.isArray(v)) return NO_FILTER
  const o = v as Record<string, unknown>
  const facets: PlanFilter["facets"] = {}
  for (const d of FILTER_DIMS) {
    const raw = o[d]
    const list = (
      Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : []
    )
      .filter((x): x is string => typeof x === "string" && x !== "")
      .slice(0, 200)
    if (list.length) facets[d] = [...new Set(list)]
  }
  const expr = typeof o.__expr === "string" ? o.__expr : ""
  const hide = o.hide === "1" || o.hide === true || o.hide === 1
  const f = { facets, expr, hide }
  return filterIsOn(f) ? f : NO_FILTER
}

/** The URL's `pf` for a filter; undefined when it is off. */
export function filterSearch(f: PlanFilter): FilterSnapshot | undefined {
  return filterIsOn(f) ? filterSnapshot(f) : undefined
}

/** Two filters the same? */
export function sameFilter(a: PlanFilter, b: PlanFilter): boolean {
  return JSON.stringify(filterSnapshot(a)) === JSON.stringify(filterSnapshot(b))
}

/** A facet value ticked or not. */
export function toggleFacet(
  f: PlanFilter,
  dim: FilterDim,
  value: string
): PlanFilter {
  const cur = new Set(f.facets[dim] ?? [])
  if (cur.has(value)) cur.delete(value)
  else cur.add(value)
  const facets = { ...f.facets }
  if (cur.size) facets[dim] = [...cur]
  else delete facets[dim]
  return { ...f, facets }
}

// ── What a tile is ─────────────────────────────────────────────────────

export interface FacetValue {
  value: string
  label: string
  color?: string
}

const KIND_LABEL: Record<string, string> = {
  rack: "Racks",
  cabinet: "Cabinets",
  device: "Devices",
  powerpanel: "Power panels",
  powerfeed: "Power feeds",
  coolingsource: "Cooling sources",
  floorplan: "Floor plans",
}

const TILE_STATUS: Record<string, string> = {
  active: "Active",
  planned: "Planned",
  reserved: "Reserved",
  decommissioning: "Decommissioning",
}

/** The areas (rooms) a point is in, for the area-type facet. */
export interface AreaIndex {
  rooms: PlanRoom[]
  typeOf: Map<string, FacetValue>
}

export function areaIndex(areas: readonly AreaShape[]): AreaIndex {
  const typeOf = new Map<string, FacetValue>()
  for (const a of areas) {
    const t = areaTypeOf(a)
    if (t) typeOf.set(a.id, { value: t.id, label: t.name, color: t.color })
  }
  return {
    rooms: planRooms(areas.filter((a) => typeOf.has(a.id))),
    typeOf,
  }
}

const centre = (t: FloorPlanTile): Pt => [t.x + t.width / 2, t.y + t.height / 2]

/** A tile's value(s) for each facet. A link the reader may not view names
 * nothing of its object: its kind only. */
export function tileFacets(
  t: FloorPlanTile,
  areas: AreaIndex | null = null
): Record<FilterDim, FacetValue[]> {
  const out: Record<FilterDim, FacetValue[]> = {
    kind: [],
    role: [],
    type: [],
    status: [],
    tag: [],
    rack_role: [],
    area: [],
  }
  const l = t.linked
  const seen = l && !l.hidden ? l : null
  if (l) out.kind.push({ value: l.kind, label: KIND_LABEL[l.kind] ?? l.kind })
  else if (t.tile_type)
    out.kind.push({
      value: `tt:${t.tile_type.id}`,
      label: t.tile_type.name,
      color: t.tile_type.color || undefined,
    })
  else if (t.role_type) out.kind.push({ value: "device", label: "Devices" })
  const role = seen?.role ?? null
  if (l?.kind === "device" && role)
    out.role.push({ value: role.id, label: role.name, color: role.color })
  else if (!l && t.role_type)
    out.role.push({
      value: t.role_type.id,
      label: t.role_type.name,
      color: t.role_type.color,
    })
  if (l?.kind === "rack" && role)
    out.rack_role.push({ value: role.id, label: role.name, color: role.color })
  if (l?.kind === "device" && seen?.type)
    out.type.push({ value: seen.type.id, label: seen.type.name })
  if (seen?.status)
    out.status.push({
      value: seen.status.name.toLowerCase(),
      label: seen.status.name,
      color: seen.status.color || undefined,
    })
  else if (t.status && !seen)
    out.status.push({
      value: t.status,
      label: TILE_STATUS[t.status] ?? t.status,
    })
  for (const tag of seen?.tags ?? [])
    out.tag.push({
      value: tag.slug,
      label: tag.name,
      color: tag.color || undefined,
    })
  if (areas) {
    const c = centre(t)
    const ids = new Set<string>()
    for (const r of areas.rooms) {
      if (!r.contains(c)) continue
      const v = areas.typeOf.get(r.id)
      if (v && !ids.has(v.value)) {
        ids.add(v.value)
        out.area.push(v)
      }
    }
  }
  return out
}

/** A tile as the advanced expression reads it: its facets' names. */
export function filterRow(
  t: FloorPlanTile,
  areas: AreaIndex | null = null
): Record<string, unknown> {
  const f = tileFacets(t, areas)
  const one = (d: FilterDim) => f[d][0]?.label ?? ""
  return {
    name: tileName(t),
    kind: one("kind"),
    role: one("role"),
    type: one("type"),
    status: one("status"),
    tags: f.tag.map((x) => x.label),
    rack_role: one("rack_role"),
    area_type: f.area.map((x) => x.label),
    tile_type: t.tile_type?.name ?? "",
  }
}

function parsed(expr: string): Expr | null {
  if (!expr.trim()) return null
  try {
    return parse(expr)
  } catch {
    return null
  }
}

/** The tiles the filter keeps (zones - aisles - never count: they are the
 * floor, not what stands on it); null when it is off. */
export function matchTiles(
  tiles: readonly FloorPlanTile[],
  areas: readonly AreaShape[],
  f: PlanFilter
): Set<string> | null {
  if (!filterIsOn(f)) return null
  const on = FILTER_DIMS.filter((d) => f.facets[d]?.length)
  const expr = parsed(f.expr)
  const idx =
    f.facets.area?.length || /area_type/.test(f.expr) ? areaIndex(areas) : null
  const out = new Set<string>()
  for (const t of tiles) {
    if (tileIsZone(t)) continue
    const facets = tileFacets(t, idx)
    const ok = on.every((d) => {
      const want = f.facets[d]!
      return facets[d].some((v) => want.includes(v.value))
    })
    if (!ok) continue
    if (expr && !evaluate(expr, filterRow(t, idx))) continue
    out.add(t.id)
  }
  return out
}

/** The areas the area-type facet keeps; null when it is off. */
export function matchAreas(
  areas: readonly AreaShape[],
  f: PlanFilter
): Set<string> | null {
  const want = f.facets.area
  if (!want?.length) return null
  const out = new Set<string>()
  for (const a of areas) {
    const t = areaTypeOf(a)
    if (t && want.includes(t.id)) out.add(a.id)
  }
  return out
}

/** Each facet's options on this plan, most used first, with how many
 * tiles carry each - a ticked value always stays offered. */
export function facetOptions(
  tiles: readonly FloorPlanTile[],
  areas: readonly AreaShape[],
  f: PlanFilter = NO_FILTER
): Record<FilterDim, FacetOption[]> {
  const idx = areaIndex(areas)
  const counts = Object.fromEntries(
    FILTER_DIMS.map((d) => [d, new Map<string, FacetOption>()])
  ) as Record<FilterDim, Map<string, FacetOption>>
  for (const t of tiles) {
    if (tileIsZone(t)) continue
    const facets = tileFacets(t, idx)
    for (const d of FILTER_DIMS)
      for (const v of facets[d]) {
        const o = counts[d].get(v.value)
        if (o) o.count++
        else counts[d].set(v.value, { ...v, count: 1 })
      }
  }
  const out = {} as Record<FilterDim, FacetOption[]>
  for (const d of FILTER_DIMS) {
    for (const v of f.facets[d] ?? [])
      if (!counts[d].has(v)) counts[d].set(v, { value: v, label: v, count: 0 })
    out[d] = [...counts[d].values()].sort(
      (a, b) => b.count - a.count || a.label.localeCompare(b.label)
    )
  }
  return out
}

/** What a room's facts count a kept tile as, under a filter: its role's,
 * its type's or its tile type's name when the filter picks by that
 * ("12 APs"); undefined leaves the plain count. */
export function filterFactKey(
  t: FloorPlanTile,
  f: PlanFilter
): string | undefined {
  if (!filterIsOn(f)) return undefined
  const facets = tileFacets(t)
  for (const d of ["role", "type", "rack_role"] as const)
    if (f.facets[d]?.length && facets[d][0]) return `type:${facets[d][0].label}`
  const kind = facets.kind.length ? facets.kind[0] : null
  if (kind?.value.startsWith("tt:")) return `type:${kind.label}`
  if (facets.role[0]) return `type:${facets.role[0].label}`
  return undefined
}

/** The filter in a few words for its chip: the ticked values' names. */
export function filterSummary(
  f: PlanFilter,
  options: Record<FilterDim, FacetOption[]>
): string {
  const names: string[] = []
  for (const d of FILTER_DIMS)
    for (const v of f.facets[d] ?? [])
      names.push(options[d].find((o) => o.value === v)?.label ?? v)
  if (f.expr.trim()) names.push(f.expr.trim())
  if (names.length <= 2) return names.join(", ")
  return `${names.slice(0, 2).join(", ")} +${names.length - 2}`
}
