import type {
  BulkCableCreate,
  BulkTrayCreate,
  CablePathUpsert,
  CablePlanRequest,
  CablePlanRow,
  CablePlanSuggestion,
  ConnectPort,
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
 *
 * New cables planned with "Connect to…" ride the draft too: Save makes
 * them (`cables.create`, all or nothing) before their routes, which name
 * them by their draft key.
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

/** A new cable planned with "Connect to…", not made until Save. Its
 * route (if any) is in `routes` under its `key`. */
export interface DraftNewCable {
  key: string
  a: ConnectPort
  b: ConnectPort
  type: string
  color: string
  status: { id: string; name: string; color: string }
}

export interface CableDraft {
  /** By cable id - a new cable's by its draft key. */
  routes: Readonly<Partial<Record<string, DraftCableRoute>>>
  /** New trays (suggested runs kept), with draft ids. */
  trays: readonly FloorPlanTray[]
  /** New cables (Connect to…). */
  cables?: readonly DraftNewCable[]
}

export const EMPTY_CABLE_DRAFT: CableDraft = { routes: {}, trays: [] }

/** The draft's routes, in the order they were applied. */
export function draftRoutes(cd: CableDraft): DraftCableRoute[] {
  return Object.values(cd.routes).filter(
    (r): r is DraftCableRoute => r !== undefined
  )
}

export function cableDraftDirty(cd: CableDraft | undefined): boolean {
  return (
    !!cd &&
    (cd.trays.length > 0 ||
      Object.keys(cd.routes).length > 0 ||
      (cd.cables?.length ?? 0) > 0)
  )
}

/** A new cable's name in lists: "sw-a · ge-1 → sw-b · ge-1". */
export function newCableLabel(c: { a: ConnectPort; b: ConnectPort }): string {
  return `${c.a.device_name} · ${c.a.name} → ${c.b.device_name} · ${c.b.name}`
}

/** The ports the draft's new cables take - not offered again. */
export function draftCablePorts(
  cd: CableDraft | undefined
): { kind: string; id: string }[] {
  return (cd?.cables ?? []).flatMap((c) => [
    { kind: c.a.kind, id: c.a.id },
    { kind: c.b.kind, id: c.b.id },
  ])
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

/**
 * The draft with new cables (Connect to…): one per pair, in the status,
 * type and colour picked, each routed as previewed - its length written
 * from the route - and the runs it uses kept as trays. One step: undo
 * takes them all back. `newId` names the cables and trays in the draft.
 */
export function applyNewCables(
  cd: CableDraft,
  {
    pairs,
    type,
    color,
    status,
    suggestions = [],
    trays,
    newId,
  }: {
    pairs: readonly {
      a: ConnectPort
      b: ConnectPort
      route: StoredCablePath | null
      type?: string
    }[]
    type: string | null
    color: string
    status: DraftNewCable["status"]
    suggestions?: readonly CablePlanSuggestion[]
    trays: readonly { name: string }[]
    newId: () => string
  }
): CableDraft {
  if (!pairs.length) return cd
  const made: DraftNewCable[] = []
  const rows: CablePlanRow[] = []
  const ticks: Partial<Record<string, RouteTicks>> = {}
  for (const p of pairs) {
    const key = newId()
    made.push({
      key,
      a: p.a,
      b: p.b,
      type: type ?? p.type ?? "",
      color,
      status,
    })
    if (!p.route) continue
    rows.push({
      id: key,
      label: newCableLabel(p),
      length: null,
      length_unit: "m",
      length_source: "",
      can_change: true,
      path: null,
      route: p.route,
      reason: "",
      delta_mm: null,
      write_length: true,
    })
    ticks[key] = { route: true, length: true }
  }
  const routed = applyRoutes(cd, { rows, ticks, suggestions, trays, newId })
  return { ...routed, cables: [...(cd.cables ?? []), ...made] }
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
 * A route between floors goes as its riser: the server routes both floors.
 */
export function cableDraftPayload(
  cd: CableDraft | undefined,
  tiles: readonly FloorPlanTile[]
): {
  trays?: { create: BulkTrayCreate[] }
  cables?: { create: BulkCableCreate[] }
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
    if (r.route.riser) {
      // Between floors: the server routes both floors through the riser,
      // against the tiles as saved.
      upsert.push({
        cable: r.cable,
        riser: r.route.riser.tile,
        ...(r.version ? { version: r.version } : {}),
        ...(r.length === "write" ? { write_length: true } : {}),
        ...(r.length === "replace" ? { replace_length: true } : {}),
        ...(r.length && r.cableVersion
          ? { cable_version: r.cableVersion }
          : {}),
      })
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
    ...(cd!.cables?.length
      ? {
          cables: {
            create: cd!.cables.map((c) => ({
              key: c.key,
              a: [{ kind: c.a.kind, id: c.a.id }],
              b: [{ kind: c.b.kind, id: c.b.id }],
              ...(c.type ? { type: c.type } : {}),
              ...(c.color ? { color: c.color } : {}),
              status_id: c.status.id,
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
  const fresh = new Map((cd.cables ?? []).map((c) => [c.key, c]))
  const seen = new Set<string>()
  const out = cablePaths.map((cp) => {
    const r = cd.routes[cp.id]
    if (!r) return cp
    seen.add(cp.id)
    return { ...cp, path: { ...r.route, version: `draft-${r.rev}` } }
  })
  for (const r of draftRoutes(cd)) {
    if (seen.has(r.cable)) continue
    const c = fresh.get(r.cable)
    out.push({
      id: r.cable,
      label: r.label,
      color: c?.color ?? "",
      type: c?.type ?? "",
      // A new cable draws as what it is: planned.
      ...(c
        ? { status: { ...c.status, text_color: "", is_planned: true } }
        : {}),
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

/** What of the draft a preview request carries. */
export type DraftPlanInput = Pick<
  CablePlanRequest,
  "positions" | "new_tiles" | "removed_tiles" | "draft_trays" | "removed_trays"
>

/** The preview request's view of the draft: tiles placed but not saved,
 * tiles moved, tiles deleted, trays not saved - the runs kept as trays,
 * and the plan's trays (`trays`) drawn, reshaped or deleted in the
 * draft. */
export function draftPlanInput({
  tiles,
  dirtyIds,
  deletedIds,
  cd,
  isTemp,
  trays = [],
}: {
  tiles: readonly FloorPlanTile[]
  dirtyIds: ReadonlySet<string>
  deletedIds: ReadonlySet<string>
  cd: CableDraft | undefined
  isTemp: (id: string) => boolean
  /** The draft's trays (its structure). */
  trays?: readonly FloorPlanTray[]
}): DraftPlanInput {
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
  const goneTrays = [...deletedIds]
    .filter((d) => d.startsWith("tray:"))
    .map((d) => d.slice(5))
    .filter((d) => !isTemp(d))
  if (goneTrays.length) out.removed_trays = goneTrays
  const drafted = [
    ...trays.filter((t) => isTemp(t.id) || dirtyIds.has(t.id)),
    ...(cd?.trays ?? []),
  ]
  if (drafted.length)
    out.draft_trays = drafted.map((t) => ({
      id: t.id,
      points: t.points,
      level: t.level,
      elevation_mm: t.elevation_mm,
    }))
  return out
}
