import { useMemo, useState } from "react"
import { Search } from "lucide-react"

import type {
  CableRoute,
  SiteMapConnection,
  SiteMapDevice,
  SiteMapMarker,
  SiteMapSite,
} from "@/lib/api"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { CheckDot, FoldableGroup } from "@/components/foldable-group"
import { TileBadge } from "@/components/floorplan/tile-badge"
import { KIND_COLOR } from "@/components/site-map/connections-layer"

// "On this map" — the site map's clone of the floor planner's ObjectsSidebar:
// one search box, foldable groups, click to fly-to + select. Links (circuits /
// tunnels / cross-site cables) are listed here too, grouped by kind, exactly
// like tile types group tiles. No z-index: the map subtree is isolated, so
// portal'd dropdowns stack above everything naturally.

export type MapSelected =
  | { kind: "site"; id: string }
  | { kind: "device"; id: string }
  | { kind: "marker"; id: string }
  | { kind: "connection"; id: string }

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

export function MapObjectsSidebar({
  sites,
  devices,
  markers,
  connections,
  routes,
  selectedRouteId,
  selected,
  onSelect,
  onFocus,
  onFocusConnection,
  onPickRoute,
}: {
  sites: SiteMapSite[]
  devices: SiteMapDevice[]
  markers: SiteMapMarker[]
  connections: SiteMapConnection[]
  routes: CableRoute[]
  selectedRouteId: string | null
  selected: MapSelected | null
  onSelect: (sel: MapSelected | null) => void
  onFocus: (lat: number, lng: number) => void
  onFocusConnection: (id: string) => void
  /** Fly to + select a route; a cableId also highlights that cable. */
  onPickRoute: (routeId: string, cableId: string | null) => void
}) {
  const [q, setQ] = useState("")
  const filter = q.trim().toLowerCase()
  const match = (name: string) => !filter || name.toLowerCase().includes(filter)

  const placed = useMemo(
    () => sites.filter((s) => s.latitude !== null),
    [sites]
  )
  const shownSites = placed.filter((s) => match(s.name))
  const shownMarkers = markers.filter((m) =>
    match(m.label || m.device?.name || m.type?.name || "")
  )
  const shownConnections = connections.filter(
    (c) => match(c.name) || match(c.site_a.name) || match(c.site_z.name)
  )
  const shownRoutes = routes.filter(
    (r) => match(r.name) || r.cables.some((c) => match(c.label))
  )

  const deviceGroups = useMemo(() => {
    const map = new Map<
      string,
      { title: string; color: string; rows: SiteMapDevice[] }
    >()
    for (const d of devices) {
      if (!match(d.name)) continue
      const key = d.role?.name ?? "No role"
      const g = map.get(key) ?? {
        title: key,
        color: d.role?.color ?? "",
        rows: [],
      }
      g.rows.push(d)
      map.set(key, g)
    }
    return [...map.values()]
      .map((g) => ({
        ...g,
        rows: g.rows.sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { numeric: true })
        ),
      }))
      .sort((a, b) => a.title.localeCompare(b.title))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devices, filter])

  const linkGroups = useMemo(() => {
    const map = new Map<string, SiteMapConnection[]>()
    for (const c of shownConnections) {
      map.set(c.kind, [...(map.get(c.kind) ?? []), c])
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connections, filter])

  const total =
    shownSites.length +
    deviceGroups.reduce((n, g) => n + g.rows.length, 0) +
    shownMarkers.length +
    shownConnections.length +
    shownRoutes.length

  return (
    <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-l border-border p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[11px] font-semibold tracking-wide uppercase">
          On this map
        </p>
        <span className="num text-[11px] text-muted-foreground">{total}</span>
      </div>
      <div className="relative mb-3">
        <Search className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search the map…"
          className="h-8 pl-7 text-[13px]"
        />
      </div>

      {total === 0 && (
        <p className="px-1 text-[13px] text-muted-foreground">
          {filter ? "No matches." : "Nothing placed yet."}
        </p>
      )}

      {shownSites.length > 0 && (
        <div className="mb-3">
          <p className="mb-1 px-1 text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
            Sites
          </p>
          {shownSites.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => {
                onFocus(s.latitude!, s.longitude!)
                onSelect({ kind: "site", id: s.id })
              }}
              className={cn(
                "flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[13px]",
                selected?.kind === "site" && selected.id === s.id
                  ? "bg-muted font-medium"
                  : "hover:bg-muted/60"
              )}
            >
              <CheckDot check={s.check} />
              <span className="min-w-0 truncate">{s.name}</span>
              <span className="num ml-auto text-[11px] text-muted-foreground/70">
                {s.device_count}
              </span>
            </button>
          ))}
        </div>
      )}

      {deviceGroups.length > 0 && (
        <div className="mb-3">
          <p className="mb-1 px-1 text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
            Devices
          </p>
          {deviceGroups.map((g) => (
            <FoldableGroup
              key={g.title}
              title={g.title}
              count={g.rows.length}
              badge={<TileBadge color={g.color} />}
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
                    "flex w-full items-center gap-2 rounded px-1.5 py-1 pl-6 text-left font-mono text-[12px]",
                    selected?.kind === "device" && selected.id === d.id
                      ? "bg-muted font-medium"
                      : "hover:bg-muted/60"
                  )}
                >
                  <CheckDot check={d.check} />
                  <span className="min-w-0 truncate">{d.name}</span>
                </button>
              ))}
            </FoldableGroup>
          ))}
        </div>
      )}

      {shownMarkers.length > 0 && (
        <div className="mb-3">
          <p className="mb-1 px-1 text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
            Markers
          </p>
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
        </div>
      )}

      {shownRoutes.length > 0 && (
        <div className="mb-3">
          <p className="mb-1 px-1 text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
            Cable routes
          </p>
          {shownRoutes.map((r) => (
            <FoldableGroup
              key={r.id}
              title={r.name}
              count={r.cables.length}
              badge={
                <span
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ background: r.color || "#71717a" }}
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
                  className="flex w-full items-center gap-2 rounded px-1.5 py-1 pl-6 text-left font-mono text-[12px] hover:bg-muted/60"
                >
                  <span
                    className="size-1.5 shrink-0 rounded-full"
                    style={{ background: c.color || "#0ea5e9" }}
                  />
                  <span className="min-w-0 truncate">{c.label}</span>
                  {c.type && (
                    <span className="ml-auto font-sans text-[10px] text-muted-foreground/70">
                      {c.type}
                    </span>
                  )}
                </button>
              ))}
            </FoldableGroup>
          ))}
        </div>
      )}

      {linkGroups.length > 0 && (
        <div className="mb-3">
          <p className="mb-1 px-1 text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
            Links
          </p>
          {linkGroups.map(([kind, rows]) => (
            <FoldableGroup
              key={kind}
              title={LINK_KIND_TITLE[kind] ?? kind}
              count={rows.length}
              badge={
                <span
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ background: KIND_COLOR[kind] ?? "#71717a" }}
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
                  <span
                    className="size-1.5 shrink-0 rounded-full"
                    style={{ background: c.color || KIND_COLOR[c.kind] }}
                  />
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
        </div>
      )}
    </aside>
  )
}
