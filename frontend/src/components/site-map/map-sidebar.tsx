import { useMemo, useState } from "react"
import { Search } from "lucide-react"

import type {
  CableRoute,
  SiteMapConnection,
  SiteMapDevice,
  SiteMapMarker,
  SiteMapRegion,
  SiteMapSite,
} from "@/lib/api"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import {
  CheckChip,
  CheckCountChip,
  FoldableGroup,
} from "@/components/foldable-group"
import { TileBadge } from "@/components/floorplan/tile-badge"
import { KIND_COLOR } from "@/components/site-map/connections-layer"

// "On this map" - the site map's clone of the floor planner's ObjectsSidebar:
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

const FOLDS = "site-map:groups"

function SiteRow({
  site: s,
  indent = false,
  selected,
  onFocus,
  onSelect,
}: {
  site: SiteMapSite
  indent?: boolean
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
      {/* A dot only when the operator chose a marker color - default-tinted
          dots on every row are noise, not signal. */}
      {s.color && (
        <span
          aria-hidden
          className="size-2.5 shrink-0 rounded-full border border-background shadow-[0_0_0_1px_var(--border)]"
          style={{ background: s.color }}
        />
      )}
      <span className="min-w-0 truncate">{s.name}</span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        <CheckChip check={s.check} />
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

type StatusFilter = "down" | "degraded" | "up" | null

export function MapObjectsSidebar({
  sites,
  devices,
  markers,
  connections,
  routes,
  regions,
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
  const [status, setStatus] = useState<StatusFilter>(null)
  const filter = q.trim().toLowerCase()
  const match = (name: string) => !filter || name.toLowerCase().includes(filter)
  const matchStatus = (check: string | null | undefined) =>
    !status || check === status

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

  // Sites fold by region - the same treatment devices get by role. The
  // group carries the region's boundary color when one is set.
  const siteGroups = useMemo(() => {
    const colorByRegion = new Map(regions.map((r) => [r.id, r.color]))
    const map = new Map<
      string,
      { title: string; color: string; rows: SiteMapSite[] }
    >()
    for (const s of shownSites) {
      const key = s.region?.name ?? "No region"
      const g = map.get(key) ?? {
        title: key,
        color: (s.region && colorByRegion.get(s.region.id)) || "",
        rows: [],
      }
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
      mono: boolean
    }[] = []
    for (const s of shownSites)
      if (s.check === "down" || s.check === "degraded")
        rows.push({
          kind: "site",
          id: s.id,
          name: s.name,
          check: s.check,
          lat: s.latitude!,
          lng: s.longitude!,
          mono: false,
        })
    for (const g of deviceGroups)
      for (const d of g.rows)
        if (d.check === "down" || d.check === "degraded")
          rows.push({
            kind: "device",
            id: d.id,
            name: d.name,
            check: d.check,
            lat: d.latitude,
            lng: d.longitude,
            mono: true,
          })
    return rows.sort(
      (a, b) =>
        checkRank(a.check) - checkRank(b.check) ||
        a.name.localeCompare(b.name, undefined, { numeric: true })
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownSites, deviceGroups, status])

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
    (status
      ? 0
      : shownMarkers.length +
        shownConnections.length +
        shownRoutes.length +
        shownRegions.length)

  return (
    <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-l border-border p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[11px] font-semibold tracking-wide uppercase">
          On this map
        </p>
        <span className="num text-[11px] text-muted-foreground">{total}</span>
      </div>
      <div className="relative mb-2">
        <Search className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            // Enter jumps straight to the first hit.
            if (e.key !== "Enter") return
            const s = shownSites[0]
            const d = deviceGroups[0]?.rows[0]
            if (s) {
              onFocus(s.latitude!, s.longitude!)
              onSelect({ kind: "site", id: s.id })
            } else if (d) {
              onFocus(d.latitude, d.longitude)
              onSelect({ kind: "device", id: d.id })
            } else if (shownMarkers[0]) {
              const m = shownMarkers[0]
              onFocus(m.latitude, m.longitude)
              onSelect({ kind: "marker", id: m.id })
            }
          }}
          placeholder="Search the map…"
          className="h-8 pl-7 text-[13px]"
        />
      </div>

      <div className="mb-3 flex items-center gap-1">
        {(
          [
            [null, "All"],
            ["down", "down"],
            ["degraded", "degraded"],
            ["up", "up"],
          ] as [StatusFilter, string][]
        ).map(([value, label]) => (
          <button
            key={label}
            type="button"
            onClick={() => setStatus(value)}
            className={cn(
              "rounded-[4px] px-1.5 py-0.5 text-[10px] font-medium",
              status === value
                ? "bg-foreground text-background"
                : "bg-muted text-muted-foreground hover:text-foreground"
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {total === 0 && (
        <p className="px-1 text-[13px] text-muted-foreground">
          {filter || status ? "No matches." : "Nothing placed yet."}
        </p>
      )}

      {problems.length > 0 && (
        <div className="mb-3">
          <p className="mb-1 px-1 text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
            Problems
          </p>
          {problems.map((p) => (
            <button
              key={`${p.kind}:${p.id}`}
              type="button"
              onClick={() => {
                onFocus(p.lat, p.lng)
                onSelect({ kind: p.kind, id: p.id })
              }}
              className={cn(
                "flex w-full items-center gap-2 rounded px-1.5 py-1 text-left",
                p.mono ? "font-mono text-[12px]" : "text-[13px]",
                selected?.kind === p.kind && selected.id === p.id
                  ? "bg-muted font-medium"
                  : "hover:bg-muted/60"
              )}
            >
              <span className="min-w-0 truncate">{p.name}</span>
              <span className="ml-auto shrink-0">
                <CheckChip check={p.check} />
              </span>
            </button>
          ))}
        </div>
      )}

      {shownSites.length > 0 && (
        <div className="mb-3">
          <p className="mb-1 px-1 text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
            Sites
          </p>
          {/* One flat list while no site has a region; region folds (like
              the device role folds) as soon as regions are in use. */}
          {siteGroups.length === 1 && siteGroups[0].title === "No region"
            ? siteGroups[0].rows.map((s) => (
                <SiteRow
                  key={s.id}
                  site={s}
                  selected={selected}
                  onFocus={onFocus}
                  onSelect={onSelect}
                />
              ))
            : siteGroups.map((g) => (
                <FoldableGroup
                  key={g.title}
                  title={g.title}
                  count={g.rows.length}
                  storageId={FOLDS}
                  badge={
                    g.color ? (
                      <span
                        className="size-2.5 shrink-0 rounded-full border border-background shadow-[0_0_0_1px_var(--border)]"
                        style={{ background: g.color }}
                      />
                    ) : undefined
                  }
                  extra={
                    <>
                      <CheckCountChip check="down" n={g.down} />
                      <CheckCountChip check="degraded" n={g.degraded} />
                    </>
                  }
                >
                  {g.rows.map((s) => (
                    <SiteRow
                      key={s.id}
                      site={s}
                      indent
                      selected={selected}
                      onFocus={onFocus}
                      onSelect={onSelect}
                    />
                  ))}
                </FoldableGroup>
              ))}
        </div>
      )}

      {shownRegions.length > 0 && !status && (
        <div className="mb-3">
          <p className="mb-1 px-1 text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
            Regions
          </p>
          {shownRegions.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => onFocusRegion(r)}
              className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[13px] hover:bg-muted/60"
              title="Fit the map to this region"
            >
              {r.color && (
                <span
                  aria-hidden
                  className="size-2.5 shrink-0 rounded-full border border-background shadow-[0_0_0_1px_var(--border)]"
                  style={{ background: r.color }}
                />
              )}
              <span className="min-w-0 truncate">{r.name}</span>
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
              badge={<TileBadge color={g.color} icon={g.icon} />}
              storageId={FOLDS}
              extra={
                <>
                  <CheckCountChip check="down" n={g.down} />
                  <CheckCountChip check="degraded" n={g.degraded} />
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
                    "flex w-full items-center gap-2 rounded px-1.5 py-1 pl-6 text-left font-mono text-[12px]",
                    selected?.kind === "device" && selected.id === d.id
                      ? "bg-muted font-medium"
                      : "hover:bg-muted/60"
                  )}
                >
                  <span className="min-w-0 truncate">{d.name}</span>
                  {filter && d.site && (
                    <span className="min-w-0 truncate font-sans text-[10px] text-muted-foreground/70">
                      {d.site.name}
                    </span>
                  )}
                  <span className="ml-auto shrink-0">
                    <CheckChip check={d.check} />
                  </span>
                </button>
              ))}
            </FoldableGroup>
          ))}
        </div>
      )}

      {shownMarkers.length > 0 && !status && (
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

      {shownRoutes.length > 0 && !status && (
        <div className="mb-3">
          <p className="mb-1 px-1 text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
            Cable routes
          </p>
          {shownRoutes.map((r) => (
            <FoldableGroup
              key={r.id}
              title={r.name}
              count={r.cables.length}
              storageId={FOLDS}
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

      {linkGroups.length > 0 && !status && (
        <div className="mb-3">
          <p className="mb-1 px-1 text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
            Links
          </p>
          {linkGroups.map(([kind, rows]) => (
            <FoldableGroup
              key={kind}
              title={LINK_KIND_TITLE[kind] ?? kind}
              count={rows.length}
              storageId={FOLDS}
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
