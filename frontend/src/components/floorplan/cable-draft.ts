import type {
  BulkTrayCreate,
  CablePathUpsert,
  CablePlanRequest,
  CablePlanRow,
  CablePlanSuggestion,
  FloorPlanCablePath,
  FloorPlanTile,
  FloorPlanTray,
  StoredCablePath,
} from "@/lib/api"

/**
 * Cable routes in the floor plan's draft - "After placing" → Route cables.
 * Applying the panel puts the ticked routes (and the suggested runs kept
 * as trays) in the draft as one undo step; the plan's Save writes them in
 * the same bulk call as the tiles (`trays.create`, then `cable_paths`).
 * Discard drops them with the rest of the draft.
 */

/** What a ticked row writes: its route, and its length when ticked -
 * "write" fills a blank or computed length, "replace" one a person
 * entered. */
export interface DraftCableRoute {
  cable: string
  label: string
  route: StoredCablePath
  /** The stored path's version the route is based on. */
  version?: string
  length?: "write" | "replace"
  /** The cable's version the length write is based on. */
  cableVersion?: string
  /** Bumped on every apply: the drawing's cache key. */
  rev: number
}

export interface CableDraft {
  /** By cable id. */
  routes: Readonly<Partial<Record<string, DraftCableRoute>>>
  /** New trays (suggested runs kept), with draft ids. */
  trays: readonly FloorPlanTray[]
}

export const EMPTY_CABLE_DRAFT: CableDraft = { routes: {}, trays: [] }

/** The draft's routes, in the order they were applied. */
export function draftRoutes(cd: CableDraft): DraftCableRoute[] {
  return Object.values(cd.routes).filter(
    (r): r is DraftCableRoute => r !== undefined
  )
}

export function cableDraftDirty(cd: CableDraft | undefined): boolean {
  return !!cd && (cd.trays.length > 0 || Object.keys(cd.routes).length > 0)
}

/** A row's ticks in the panel. */
export interface RouteTicks {
  route: boolean
  length: boolean
}

/** The default ticks: a row with a route the user may change is routed;
 * its length is set when it is blank or computed. A length a person
 * entered is replaced only by its own tick. */
export function defaultTicks(row: CablePlanRow): RouteTicks {
  const route = !!row.route && row.can_change && !row.off_floor
  return { route, length: route && row.write_length }
}

let rev = 0

/** The name of the n-th run ("Run 1"), after the plan's own. */
export function nextRunNumber(trays: readonly { name: string }[]): number {
  let n = 0
  for (const t of trays) {
    const m = /^Run (\d+)$/.exec(t.name)
    if (m) n = Math.max(n, Number(m[1]))
  }
  return n + 1
}

function withTrays(
  route: StoredCablePath,
  map: ReadonlyMap<string, string>
): StoredCablePath {
  if (!map.size) return route
  const id = (t: string) => map.get(t) ?? t
  return {
    ...route,
    tray_order: route.tray_order.map(id),
    legs: route.legs.map((l) => ({
      ...l,
      trays: l.trays.map((s) => ({ ...s, id: id(s.id) })),
    })),
  }
}

/**
 * The draft with the ticked rows applied: each ticked row's route (the
 * runs it uses kept as new trays, named "Run N" after the plan's), and
 * its length when ticked. `newId` names the new trays in the draft.
 */
export function applyRoutes(
  cd: CableDraft,
  {
    rows,
    ticks,
    suggestions = [],
    trays,
    newId,
  }: {
    rows: readonly CablePlanRow[]
    ticks: Readonly<Partial<Record<string, RouteTicks>>>
    suggestions?: readonly CablePlanSuggestion[]
    /** The plan's trays, for the run names. */
    trays: readonly { name: string }[]
    newId: () => string
  }
): CableDraft {
  const picked = rows.filter((r) => r.route && ticks[r.id]?.route)
  if (!picked.length) return cd
  const used = new Set(
    picked.flatMap((r) =>
      r.route!.tray_order.filter((t) => t.startsWith("run-"))
    )
  )
  const map = new Map<string, string>()
  const made: FloorPlanTray[] = []
  let n = nextRunNumber([...trays, ...cd.trays])
  for (const s of suggestions) {
    if (!s.run || !used.has(s.key)) continue
    const id = newId()
    map.set(s.key, id)
    made.push({
      id,
      name: `Run ${n++}`,
      kind: "",
      color: "",
      points: s.run,
      level: s.level,
      elevation_mm: null,
      description: "",
      cables: [],
      hidden_cable_count: 0,
      created_at: "",
      updated_at: "",
    })
  }
  const routes = { ...cd.routes }
  for (const row of picked) {
    const t = ticks[row.id]
    routes[row.id] = {
      cable: row.id,
      label: row.label,
      route: withTrays(row.route!, map),
      ...(row.path?.version ? { version: row.path.version } : {}),
      ...(t?.length
        ? {
            length: row.write_length
              ? ("write" as const)
              : ("replace" as const),
            ...(row.cable_version ? { cableVersion: row.cable_version } : {}),
          }
        : {}),
      rev: ++rev,
    }
  }
  return { routes, trays: [...cd.trays, ...made] }
}

const centre = (t: FloorPlanTile): [number, number] => [
  t.x + t.width / 2,
  t.y + t.height / 2,
]
const near = (a: readonly number[], b: readonly number[]) =>
  Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-3

/**
 * What Save sends for the draft's routes: the new trays, then a path per
 * route. A route whose end tile moved since it was applied goes without
 * its legs - the server routes it again through its trays, against the
 * tiles as saved; one whose end tile is gone is left out (`dropped`).
 */
export function cableDraftPayload(
  cd: CableDraft | undefined,
  tiles: readonly FloorPlanTile[]
): {
  trays?: { create: BulkTrayCreate[] }
  cable_paths?: { upsert: CablePathUpsert[] }
  dropped: string[]
} {
  if (!cableDraftDirty(cd)) return { dropped: [] }
  const byId = new Map(tiles.map((t) => [t.id, t]))
  const upsert: CablePathUpsert[] = []
  const dropped: string[] = []
  for (const r of draftRoutes(cd!)) {
    let gone = false
    let moved = false
    for (const leg of r.route.legs) {
      const a = byId.get(leg.from.tile)
      const b = byId.get(leg.to.tile)
      if (!a || !b) {
        gone = true
        break
      }
      if (
        !near(centre(a), leg.points[0]) ||
        !near(centre(b), leg.points[leg.points.length - 1])
      )
        moved = true
    }
    if (gone) {
      dropped.push(r.label)
      continue
    }
    upsert.push({
      cable: r.cable,
      kind: moved && r.route.kind === "trays" ? "trays" : r.route.kind,
      ...(moved
        ? {}
        : {
            legs: r.route.legs.map((l) => ({
              points: l.points,
              ...(l.elevation_mm != null
                ? { elevation_mm: l.elevation_mm }
                : {}),
            })),
          }),
      tray_order: r.route.tray_order,
      ...(r.version ? { version: r.version } : {}),
      ...(r.length === "write" ? { write_length: true } : {}),
      ...(r.length === "replace" ? { replace_length: true } : {}),
      ...(r.length && r.cableVersion ? { cable_version: r.cableVersion } : {}),
    })
  }
  return {
    ...(cd!.trays.length
      ? {
          trays: {
            create: cd!.trays.map((t) => ({
              key: t.id,
              name: t.name,
              points: t.points,
              level: t.level,
            })),
          },
        }
      : {}),
    ...(upsert.length ? { cable_paths: { upsert } } : {}),
    dropped,
  }
}

/** The plan's cables as drawn with the draft's routes: each routed cable
 * draws its draft route as its stored path; a cable the plan did not list
 * yet (both ends just placed) joins with what the panel knew of it. */
export function withDraftRoutes(
  cablePaths: FloorPlanCablePath[],
  cd: CableDraft | undefined
): FloorPlanCablePath[] {
  if (!cd || !Object.keys(cd.routes).length) return cablePaths
  const seen = new Set<string>()
  const out = cablePaths.map((cp) => {
    const r = cd.routes[cp.id]
    if (!r) return cp
    seen.add(cp.id)
    return { ...cp, path: { ...r.route, version: `draft-${r.rev}` } }
  })
  for (const r of draftRoutes(cd)) {
    if (seen.has(r.cable)) continue
    out.push({
      id: r.cable,
      label: r.label,
      color: "",
      type: "",
      path: { ...r.route, version: `draft-${r.rev}` },
      a_tiles: [],
      b_tiles: [],
      a_points: [],
      b_points: [],
      tray_ids: r.route.tray_order,
    })
  }
  return out
}

/** The preview request's view of the draft: tiles placed but not saved,
 * tiles moved, tiles deleted, trays not saved. */
export function draftPlanInput({
  tiles,
  dirtyIds,
  deletedIds,
  cd,
  isTemp,
}: {
  tiles: readonly FloorPlanTile[]
  dirtyIds: ReadonlySet<string>
  deletedIds: ReadonlySet<string>
  cd: CableDraft | undefined
  isTemp: (id: string) => boolean
}): Pick<
  CablePlanRequest,
  "positions" | "new_tiles" | "removed_tiles" | "draft_trays"
> {
  const out: ReturnType<typeof draftPlanInput> = {}
  const positions: NonNullable<CablePlanRequest["positions"]> = {}
  const fresh: NonNullable<CablePlanRequest["new_tiles"]> = []
  for (const t of tiles) {
    if (isTemp(t.id)) {
      const k = t.linked?.kind
      if (t.linked?.id && (k === "device" || k === "rack" || k === "cabinet"))
        fresh.push({
          id: t.id,
          x: t.x,
          y: t.y,
          width: t.width,
          height: t.height,
          link_kind: k,
          link_id: t.linked.id,
        })
    } else if (dirtyIds.has(t.id)) {
      positions[t.id] = { x: t.x, y: t.y, width: t.width, height: t.height }
    }
  }
  if (Object.keys(positions).length) out.positions = positions
  if (fresh.length) out.new_tiles = fresh
  const removed = [...deletedIds].filter((d) => !d.includes(":"))
  if (removed.length) out.removed_tiles = removed
  if (cd?.trays.length)
    out.draft_trays = cd.trays.map((t) => ({
      id: t.id,
      points: t.points,
      level: t.level,
      elevation_mm: t.elevation_mm,
    }))
  return out
}
