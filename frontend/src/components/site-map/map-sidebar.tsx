import { useMemo, useState } from "react"

import type {
  CableRoute,
  SiteMapConnection,
  SiteMapDevice,
  SiteMapMarker,
  SiteMapRegion,
  SiteMapSite,
} from "@/lib/api"
import {
  emptyHidden,
  hiddenCount,
  setHidden,
} from "@/components/hidden-objects"
import type { HiddenSet } from "@/components/hidden-objects"
import { cn } from "@/lib/utils"
import { ColorBadge } from "@/components/cells/color-badge"
import {
  CheckCountBadge,
  FoldableGroup,
  RowCheckBadge,
  VisibilityToggle,
} from "@/components/foldable-group"
import {
  ObjectsEmpty,
  ObjectsPanel,
  ObjectsSection,
  checkCounts,
} from "@/components/objects-panel"
import type { CheckFilter } from "@/components/objects-panel"
import { TileBadge } from "@/components/floorplan/tile-badge"
import { KIND_COLOR } from "@/components/site-map/connections-layer"

// The site map's Objects sidebar - the same panel the floor plan and the
// topology map open: one search box, foldable groups, click to fly-to +
// select. Links (circuits / tunnels / cross-site cables) are listed here too,
// grouped by kind, exactly like tile types group tiles. No z-index: the map
// subtree is isolated, so portal'd dropdowns stack above everything naturally.

export type MapSelected =
  | { kind: "site"; id: string }
  | { kind: "device"; id: string }
  | { kind: "marker"; id: string }
  | { kind: "connection"; id: string }
  | { kind: "cable"; id: string }

/**
 * What the sidebar's eye toggles have switched off, by name/id.
 *
 * Kept as the *group* keys the sidebar shows rather than object ids: someone
 * hiding "Access Point" means the role, so a new access point placed tomorrow
 * stays hidden too. Sites are the exception - they are the map's top-level
 * objects and few enough to hide one at a time.
 */
export const MAP_HIDDEN_KEYS = ["roles", "regions", "sites"] as const
/** Device role names, region names (as the site groups are titled), site ids. */
export type MapHidden = HiddenSet<(typeof MAP_HIDDEN_KEYS)[number]>

export const NO_HIDDEN: MapHidden = emptyHidden(MAP_HIDDEN_KEYS)
export { hiddenCount }

/** A placeable marker type from the palette (FloorTileType or DeviceRole). */
export interface MarkerTypeOption {
  id: string
  name: string
  color: string
  icon: string
  kind: "tile_type" | "role"
  has_fov?: boolean
}

const LINK_KIND_TITLE: Record<string, string> = {
  circuit: "Circuits",
  tunnel: "Tunnels",
  cable: "Cables",
}

const FOLDS = "site-map:groups"

function SiteRow({
  site: s,
  indent = false,
  shown,
  onShownChange,
  selected,
  onFocus,
  onSelect,
}: {
  site: SiteMapSite
  indent?: boolean
  shown: boolean
  onShownChange: (shown: boolean) => void
  selected: MapSelected | null
  onFocus: (lat: number, lng: number) => void
  onSelect: (sel: MapSelected | null) => void
}) {
  return (
    <button
      type="button"
      onClick={() => {
        onFocus(s.latitude!, s.longitude!)
        onSelect({ kind: "site", id: s.id })
      }}
      className={cn(
        "flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[13px]",
        indent && "pl-6",
        selected?.kind === "site" && selected.id === s.id
          ? "bg-muted font-medium"
          : "hover:bg-muted/60"
      )}
    >
      {/* No color dot: the pin on the map carries the site's color; in the
          list it's noise. Status chips are the only color here. */}
      <span
        className={cn("min-w-0 truncate", !shown && "text-muted-foreground/60")}
      >
        {s.name}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        <VisibilityToggle
          vis={{ shown, onChange: onShownChange, what: s.name }}
        />
        <RowCheckBadge check={s.check} />
        <span className="num text-[11px] text-muted-foreground/70">
          {s.device_count}
        </span>
      </span>
    </button>
  )
}

/** down < degraded < everything else - the sidebar's triage order. */
function checkRank(check: string | null | undefined): number {
  return check === "down" ? 0 : check === "degraded" ? 1 : 2
}

export function MapObjectsSidebar({
  sites,
  devices,
  markers,
  connections,
  routes,
  regions,
  hidden,
  onHiddenChange,
  selectedRouteId,
  selected,
  onSelect,
  onFocus,
  onFocusConnection,
  onPickRoute,
  onFocusRegion,
}: {
  sites: SiteMapSite[]
  devices: SiteMapDevice[]
  markers: SiteMapMarker[]
  connections: SiteMapConnection[]
  routes: CableRoute[]
  /** Regions with a stored boundary - listed with a fit-to jump. */
  regions: SiteMapRegion[]
  /** What the eye toggles have taken off the map. */
  hidden: MapHidden
  onHiddenChange: (next: MapHidden) => void
  selectedRouteId: string | null
  selected: MapSelected | null
  onSelect: (sel: MapSelected | null) => void
  onFocus: (lat: number, lng: number) => void
  onFocusConnection: (id: string) => void
  /** Fly to + select a route; a cableId also highlights that cable. */
  onPickRoute: (routeId: string, cableId: string | null) => void
  /** Fit the map to a region's boundary. */
  onFocusRegion: (region: SiteMapRegion) => void
}) {
  const [q, setQ] = useState("")
  const [status, setStatus] = useState<CheckFilter>(null)
  const filter = q.trim().toLowerCase()
  const match = (name: string) => !filter || name.toLowerCase().includes(filter)
  const matchStatus = (check: string | null | undefined) =>
    !status || check === status

  const hiddenRoles = new Set(hidden.roles)
  const hiddenRegions = new Set(hidden.regions)
  const hiddenSites = new Set(hidden.sites)
  /** A site is off the map if it is hidden itself or its region is. */
  const siteShown = (s: SiteMapSite) =>
    !hiddenSites.has(s.id) && !hiddenRegions.has(s.region?.name ?? "No region")
  const deviceShown = (d: SiteMapDevice) =>
    !hiddenRoles.has(d.role?.name ?? "No role")

  const toggle = (key: keyof MapHidden, value: string, shown: boolean) =>
    onHiddenChange(setHidden(hidden, key, value, !shown))

  const placed = useMemo(
    () => sites.filter((s) => s.latitude !== null),
    [sites]
  )
  const shownSites = placed
    .filter((s) => match(s.name) && matchStatus(s.check))
    .sort(
      (a, b) =>
        checkRank(a.check) - checkRank(b.check) ||
        a.name.localeCompare(b.name, undefined, { numeric: true })
    )
  const shownMarkers = markers.filter((m) =>
    match(m.label || m.device?.name || m.type?.name || "")
  )
  const shownRegions = regions.filter((r) => match(r.name))

  // Sites fold by region - the same treatment devices get by role.
  const siteGroups = useMemo(() => {
    const map = new Map<string, { title: string; rows: SiteMapSite[] }>()
    for (const s of shownSites) {
      const key = s.region?.name ?? "No region"
      const g = map.get(key) ?? { title: key, rows: [] }
      g.rows.push(s)
      map.set(key, g)
    }
    return [...map.values()]
      .map((g) => ({
        ...g,
        down: g.rows.filter((s) => s.check === "down").length,
        degraded: g.rows.filter((s) => s.check === "degraded").length,
      }))
      .sort((a, b) =>
        a.title === "No region"
          ? 1
          : b.title === "No region"
            ? -1
            : a.title.localeCompare(b.title)
      )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sites, regions, filter, status])
  const shownConnections = connections.filter(
    (c) => match(c.name) || match(c.site_a.name) || match(c.site_z.name)
  )
  const shownRoutes = routes.filter(
    (r) => match(r.name) || r.cables.some((c) => match(c.label))
  )

  const deviceGroups = useMemo(() => {
    const map = new Map<
      string,
      { title: string; color: string; icon: string; rows: SiteMapDevice[] }
    >()
    for (const d of devices) {
      if (!match(d.name) || !matchStatus(d.check)) continue
      const key = d.role?.name ?? "No role"
      const g = map.get(key) ?? {
        title: key,
        color: d.role?.color ?? "",
        icon: d.role?.icon ?? "",
        rows: [],
      }
      g.rows.push(d)
      map.set(key, g)
    }
    return [...map.values()]
      .map((g) => ({
        ...g,
        down: g.rows.filter((d) => d.check === "down").length,
        degraded: g.rows.filter((d) => d.check === "degraded").length,
        rows: g.rows.sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { numeric: true })
        ),
      }))
      .sort((a, b) => a.title.localeCompare(b.title))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devices, filter, status])

  // Everything unhealthy, mixed and worst-first - the sidebar's own triage
  // list. Hidden while a status filter narrows the sections themselves.
  const problems = useMemo(() => {
    if (status) return []
    const rows: {
      kind: "site" | "device"
      id: string
      name: string
      check: string
      lat: number
      lng: number
    }[] = []
    for (const s of shownSites)
      // Hidden objects are off the map, so they are not this map's problems.
      if (siteShown(s) && (s.check === "down" || s.check === "degraded"))
        rows.push({
          kind: "site",
          id: s.id,
          name: s.name,
          check: s.check,
          lat: s.latitude!,
          lng: s.longitude!,
        })
    for (const g of deviceGroups)
      if (!hiddenRoles.has(g.title))
        for (const d of g.rows)
          if (d.check === "down" || d.check === "degraded")
            rows.push({
              kind: "device",
              id: d.id,
              name: d.name,
              check: d.check,
              lat: d.latitude,
              lng: d.longitude,
            })
    return rows.sort(
      (a, b) =>
        checkRank(a.check) - checkRank(b.check) ||
        a.name.localeCompare(b.name, undefined, { numeric: true })
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownSites, deviceGroups, status, hidden])

  const linkGroups = useMemo(() => {
    const map = new Map<string, SiteMapConnection[]>()
    for (const c of shownConnections) {
      map.set(c.kind, [...(map.get(c.kind) ?? []), c])
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connections, filter])

  // The filter's counts: every site and device the search matches, before
  // the status filter narrows the list.
  const statusCounts = checkCounts([
    ...placed.filter((s) => match(s.name)).map((s) => s.check),
    ...devices.filter((d) => match(d.name)).map((d) => d.check),
  ])

  const total =
    shownSites.length +
    deviceGroups.reduce((n, g) => n + g.rows.length, 0) +
    (status
      ? 0
      : shownMarkers.length +
        shownConnections.length +
        shownRoutes.length +
        shownRegions.length)

  const enterFirst = () => {
    // Enter jumps straight to the first hit.
    const site = shownSites[0]
    const d = deviceGroups[0]?.rows[0]
    if (site) {
      onFocus(site.latitude!, site.longitude!)
      onSelect({ kind: "site", id: site.id })
    } else if (d) {
      onFocus(d.latitude, d.longitude)
      onSelect({ kind: "device", id: d.id })
    } else if (shownMarkers[0]) {
      const m = shownMarkers[0]
      onFocus(m.latitude, m.longitude)
      onSelect({ kind: "marker", id: m.id })
    }
  }

  return (
    <ObjectsPanel
      total={total}
      query={q}
      onQueryChange={setQ}
      onSearchEnter={enterFirst}
      status={status}
      onStatusChange={setStatus}
      statusCounts={statusCounts}
      hiddenCount={hiddenCount(hidden)}
      onShowAll={() => onHiddenChange(NO_HIDDEN)}
    >
      {total === 0 && <ObjectsEmpty filtered={!!filter || !!status} />}

      {problems.length > 0 && (
        <ObjectsSection heading="Problems">
          {problems.map((p) => (
            <button
              key={`${p.kind}:${p.id}`}
              type="button"
              onClick={() => {
                onFocus(p.lat, p.lng)
                onSelect({ kind: p.kind, id: p.id })
              }}
              className={cn(
                "flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[13px]",
                selected?.kind === p.kind && selected.id === p.id
                  ? "bg-muted font-medium"
                  : "hover:bg-muted/60"
              )}
            >
              <span className="min-w-0 truncate">{p.name}</span>
              <span className="ml-auto shrink-0">
                <RowCheckBadge check={p.check} />
              </span>
            </button>
          ))}
        </ObjectsSection>
      )}

      {shownSites.length > 0 && (
        <ObjectsSection heading="Sites">
          {/* One flat list while no site has a region; region folds (like
              the device role folds) as soon as regions are in use. */}
          {siteGroups.length === 1 && siteGroups[0].title === "No region"
            ? siteGroups[0].rows.map((s) => (
                <SiteRow
                  key={s.id}
                  site={s}
                  shown={siteShown(s)}
                  onShownChange={(v) => toggle("sites", s.id, v)}
                  selected={selected}
                  onFocus={onFocus}
                  onSelect={onSelect}
                />
              ))
            : siteGroups.map((g) => (
                <FoldableGroup
                  key={g.title}
                  name={g.title}
                  count={g.rows.length}
                  storageId={FOLDS}
                  visibility={{
                    shown: !hiddenRegions.has(g.title),
                    onChange: (v) => toggle("regions", g.title, v),
                    what: g.title,
                  }}
                  extra={
                    <>
                      <CheckCountBadge check="down" n={g.down} />
                      <CheckCountBadge check="degraded" n={g.degraded} />
                    </>
                  }
                >
                  {g.rows.map((s) => (
                    <SiteRow
                      key={s.id}
                      site={s}
                      indent
                      shown={siteShown(s)}
                      onShownChange={(v) => toggle("sites", s.id, v)}
                      selected={selected}
                      onFocus={onFocus}
                      onSelect={onSelect}
                    />
                  ))}
                </FoldableGroup>
              ))}
        </ObjectsSection>
      )}

      {shownRegions.length > 0 && !status && (
        <ObjectsSection heading="Regions">
          {shownRegions.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => onFocusRegion(r)}
              className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[13px] hover:bg-muted/60"
            >
              <span className="min-w-0 truncate">{r.name}</span>
            </button>
          ))}
        </ObjectsSection>
      )}

      {deviceGroups.length > 0 && (
        <ObjectsSection heading="Devices">
          {deviceGroups.map((g) => (
            <FoldableGroup
              key={g.title}
              name={g.title}
              count={g.rows.length}
              label={
                // The role's badge; "No role" as the plain one.
                <ColorBadge
                  name={g.title}
                  color={g.color || undefined}
                  className="max-w-44"
                />
              }
              storageId={FOLDS}
              visibility={{
                shown: !hiddenRoles.has(g.title),
                onChange: (v) => toggle("roles", g.title, v),
                what: g.title,
              }}
              extra={
                <>
                  <CheckCountBadge check="down" n={g.down} />
                  <CheckCountBadge check="degraded" n={g.degraded} />
                </>
              }
            >
              {g.rows.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => {
                    onFocus(d.latitude, d.longitude)
                    onSelect({ kind: "device", id: d.id })
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded px-1.5 py-1 pl-6 text-left text-[13px]",
                    !deviceShown(d) && "text-muted-foreground/60",
                    selected?.kind === "device" && selected.id === d.id
                      ? "bg-muted font-medium"
                      : "hover:bg-muted/60"
                  )}
                >
                  <span className="min-w-0 truncate">{d.name}</span>
                  {filter && d.site && (
                    <span className="min-w-0 truncate text-[10px] text-muted-foreground/70">
                      {d.site.name}
                    </span>
                  )}
                  <span className="ml-auto shrink-0">
                    <RowCheckBadge check={d.check} />
                  </span>
                </button>
              ))}
            </FoldableGroup>
          ))}
        </ObjectsSection>
      )}

      {shownMarkers.length > 0 && !status && (
        <ObjectsSection heading="Markers">
          {shownMarkers.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => {
                onFocus(m.latitude, m.longitude)
                onSelect({ kind: "marker", id: m.id })
              }}
              className={cn(
                "flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[13px]",
                selected?.kind === "marker" && selected.id === m.id
                  ? "bg-muted font-medium"
                  : "hover:bg-muted/60"
              )}
            >
              {/* The marker type's icon, as the pin wears it. */}
              <TileBadge
                color={m.type?.color ?? ""}
                icon={m.type?.icon}
                className="size-4"
              />
              <span className="min-w-0 truncate">
                {m.label || m.device?.name || m.type?.name || "Marker"}
              </span>
            </button>
          ))}
        </ObjectsSection>
      )}

      {shownRoutes.length > 0 && !status && (
        <ObjectsSection heading="Cable routes">
          {shownRoutes.map((r) => (
            <FoldableGroup
              key={r.id}
              name={r.name}
              count={r.cables.length}
              storageId={FOLDS}
              label={
                <ColorBadge
                  name={r.name}
                  color={r.color || undefined}
                  className="max-w-44"
                />
              }
            >
              <button
                type="button"
                onClick={() => onPickRoute(r.id, null)}
                className={cn(
                  "flex w-full items-center gap-2 rounded px-1.5 py-1 pl-6 text-left text-[12px]",
                  selectedRouteId === r.id
                    ? "bg-muted font-medium"
                    : "hover:bg-muted/60"
                )}
              >
                <span className="truncate text-muted-foreground">
                  {r.kind || "route"} ·{" "}
                  <span className="num">{r.waypoints.length}</span> points
                </span>
              </button>
              {r.cables.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => onPickRoute(r.id, c.id)}
                  className="flex w-full items-center gap-2 rounded px-1.5 py-1 pl-6 text-left text-[12px] hover:bg-muted/60"
                >
                  <span className="min-w-0 truncate font-mono">{c.label}</span>
                  {c.type && (
                    <span className="ml-auto text-[10px] text-muted-foreground/70">
                      {c.type}
                    </span>
                  )}
                </button>
              ))}
            </FoldableGroup>
          ))}
        </ObjectsSection>
      )}

      {linkGroups.length > 0 && !status && (
        <ObjectsSection heading="Links">
          {linkGroups.map(([kind, rows]) => (
            <FoldableGroup
              key={kind}
              name={LINK_KIND_TITLE[kind] ?? kind}
              count={rows.length}
              storageId={FOLDS}
              label={
                // The kind's line color on the map.
                <ColorBadge
                  name={LINK_KIND_TITLE[kind] ?? kind}
                  color={KIND_COLOR[kind]}
                  className="max-w-44"
                />
              }
            >
              {rows.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => {
                    onFocusConnection(c.id)
                    onSelect({ kind: "connection", id: c.id })
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded px-1.5 py-1 pl-6 text-left text-[12px]",
                    selected?.kind === "connection" && selected.id === c.id
                      ? "bg-muted font-medium"
                      : "hover:bg-muted/60"
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{c.name}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {c.site_a.name} ↔ {c.site_z.name}
                    </span>
                  </span>
                </button>
              ))}
            </FoldableGroup>
          ))}
        </ObjectsSection>
      )}
    </ObjectsPanel>
  )
}
