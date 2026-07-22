import { createFileRoute, Link } from "@tanstack/react-router"
import { renderToStaticMarkup } from "react-dom/server"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import L from "leaflet"
import "leaflet/dist/leaflet.css"
import { toast } from "sonner"
import {
  Maximize,
  PanelRight,
  Satellite,
  Search,
  SlidersHorizontal,
  Waypoints,
  X,
} from "lucide-react"

import {
  api,
  type FloorplanPopoverConfig,
  type Paginated,
  type SiteMapConnection,
  type SiteMapDevice,
  type SiteMapDeviceInfo,
  type SiteMapFov,
  type SiteMapMarker,
  type SiteMapCable,
  type SiteMapPayload,
  type SiteMapSite,
  type CableRoute,
  type CableRouteWritePayload,
  type CheckStatus,
  type CustomField,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field } from "@/components/forms"
import { ColorBadge } from "@/components/cells/color-badge"
import { CheckStatusBadge } from "@/components/monitoring/status-badge"
import { TagList } from "@/components/cells/tag-list"
import {
  formatCustomValue,
  useCustomFieldDefs,
} from "@/components/custom-field-display"
import { QueryError } from "@/components/query-error"
import { SegmentedTabs } from "@/components/segmented-tabs"
import {
  MapObjectsSidebar,
  type MapSelected,
  type MarkerTypeOption,
} from "@/components/site-map/map-sidebar"
import {
  ConnectionInspector,
  DeviceInspector,
  MarkerInspector,
  SiteInspector,
} from "@/components/site-map/inspector"
import {
  RouteInspector,
  RouteNameDialog,
  RouteRail,
} from "@/components/site-map/route-panels"
import { buildRoutesLayer } from "@/components/site-map/routes-layer"
import {
  buildDraftLayer,
  buildReshapeLayer,
} from "@/components/site-map/route-editor"
import {
  buildDrawnCables,
  buildDrawnCablesLayer,
} from "@/components/site-map/cable-geo-route"
import { FovEditor } from "@/components/site-map/fov-editor"
import { DevicePicker } from "@/components/device-picker"
import { buildConnectionsLayer } from "@/components/site-map/connections-layer"
import { TileBadge } from "@/components/floorplan/tile-badge"
import { MapPaletteRail } from "@/components/site-map/palette-rail"
import { buildFovLayer, type FovSource } from "@/components/site-map/fov-layer"
import { useMe } from "@/lib/use-me"
import { cn } from "@/lib/utils"

// The geographic floor plan. Same shell as /floorplans/$id — h-14 header with
// View|Edit tabs + search + view tools, left palette rail in edit mode, the
// canvas replaced by a Leaflet map, right inspector when something is
// selected, and an "On this map" objects sidebar on the far right. Tiles come
// from the deployment's configured tile server (OSM + Esri World Imagery by
// default, per their usage policies: exact HTTPS URLs, visible attribution).

export const Route = createFileRoute("/site-map")({
  // ?focus=<deviceId> — arrive centered on a device (the "Show on site map"
  // quick button on device detail pages).
  // ?focus=<deviceId> · ?trace=<cableId> — arrive centered on a device, or
  // with a routed cable highlighted (the "Show on site map" cable button).
  validateSearch: (
    s: Record<string, unknown>
  ): { focus?: string; trace?: string } => ({
    ...(typeof s.focus === "string" ? { focus: s.focus } : {}),
    ...(typeof s.trace === "string" ? { trace: s.trace } : {}),
  }),
  component: SiteMapPage,
})

function SiteMapPage() {
  const q = useQuery({
    queryKey: ["site-map"],
    queryFn: () => api<SiteMapPayload>("/api/site-map/"),
  })
  if (q.isLoading)
    return <p className="p-6 text-sm text-muted-foreground">Loading map…</p>
  if (q.isError) return <QueryError error={q.error} />
  return <MapBody data={q.data!} />
}

// ── marker rendering ──────────────────────────────────────────────────────

const CHECK_COLOR: Record<string, string> = {
  up: "var(--color-emerald-500)",
  degraded: "var(--color-amber-500)",
  down: "var(--color-red-500)",
  stale: "var(--color-zinc-400)",
  unknown: "var(--color-zinc-400)",
}

function healthRing(check: string | null): string {
  if (!check) return ""
  const c = CHECK_COLOR[check] ?? CHECK_COLOR.unknown
  return `<span class="sm-health" style="background:${c}"></span>`
}

function siteIcon(s: SiteMapSite, selected = false): L.DivIcon {
  const count =
    s.device_count > 0 ? `<span class="sm-count">${s.device_count}</span>` : ""
  return L.divIcon({
    className: "sm-marker" + (selected ? " sm-sel" : ""),
    html:
      `<span class="sm-pin"></span>${healthRing(s.check)}` +
      `<span class="sm-label">${escapeHtml(s.name)}${count}</span>`,
    iconSize: undefined as unknown as L.PointExpression,
    iconAnchor: [7, 7],
  })
}

function deviceIcon(d: SiteMapDevice, selected = false): L.DivIcon {
  // The floorplan badge — a tinted square with the role colour (a centred dot,
  // since device roles carry no icon). Same visual language as the palette,
  // the sidebar, and free markers.
  const badge = renderToStaticMarkup(<TileBadge color={d.role?.color} />)
  return L.divIcon({
    className: "sm-marker" + (selected ? " sm-sel" : ""),
    html:
      `<span class="sm-badge">${badge}</span>${healthRing(d.check)}` +
      `<span class="sm-devlabel" style="left:27px;top:2px">${escapeHtml(d.name)}</span>`,
    iconAnchor: [12, 12],
  })
}

function freeMarkerIcon(m: SiteMapMarker, selected = false): L.DivIcon {
  const label = m.label || m.device?.name || m.type?.name || ""
  // The same TileBadge as the palette/sidebar, rendered to static HTML for
  // the divIcon — a marker on the map looks identical to its sidebar row.
  // The .sm-badge wrapper gives the ~20% tint a solid backdrop over tiles.
  const badge = renderToStaticMarkup(
    <TileBadge color={m.type?.color} icon={m.type?.icon} />
  )
  return L.divIcon({
    className: "sm-marker" + (selected ? " sm-sel" : ""),
    html:
      `<span class="sm-badge">${badge}</span>` +
      (label
        ? `<span class="sm-devlabel" style="left:27px;top:2px">${escapeHtml(label)}</span>`
        : ""),
    iconAnchor: [12, 12],
  })
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

// ── the map ───────────────────────────────────────────────────────────────

type Placing =
  | { kind: "site"; id: string; name: string }
  | { kind: "marker"; id: string; name: string; type: MarkerTypeOption }

function MapBody({ data }: { data: SiteMapPayload }) {
  const qc = useQueryClient()
  const { focus, trace } = Route.useSearch()
  const { canDo } = useMe()
  const mapEl = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<L.Map | null>(null)
  const markersRef = useRef<L.LayerGroup | null>(null)
  const fovRef = useRef<L.LayerGroup | null>(null)
  const [mapReady, setMapReady] = useState(false)
  const [mode, setMode] = useState<"view" | "layout" | "cables">("view")
  const editing = mode === "layout"
  const [placing, setPlacing] = useState<Placing | null>(null)
  // Cables mode: route drawing + reshaping (the tray-draw flow, on a map).
  const [drawWaypoints, setDrawWaypoints] = useState<[number, number][] | null>(
    null
  )
  const [namingWaypoints, setNamingWaypoints] = useState<
    [number, number][] | null
  >(null)
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null)
  const [routeEditMode, setRouteEditMode] = useState(false)
  const [highlightCableIds, setHighlightCableIds] = useState<Set<string>>(
    new Set()
  )
  const traceCables = useCallback((ids: string[]) => {
    setHighlightCableIds(new Set(ids))
  }, [])
  const [selected, setSelected] = useState<MapSelected | null>(null)
  const [popPos, setPopPos] = useState<{ x: number; y: number } | null>(null)
  const [layers, setLayers] = useState({
    sites: true,
    devices: true,
    links: true,
    routes: true,
  })
  const [showFov, setShowFovState] = useState(
    () => localStorage.getItem("site-map:fov") !== "off"
  )
  const setShowFov = (v: boolean) => {
    localStorage.setItem("site-map:fov", v ? "on" : "off")
    setShowFovState(v)
  }
  const [tilesBlocked, setTilesBlocked] = useState(false)
  // After stamping a marker: ask for a name + optional device link.
  const [linkPrompt, setLinkPrompt] = useState<{
    id: string
    typeName: string
    roleId: string | null
  } | null>(null)
  const [fovDraft, setFovDraft] = useState<
    Record<string, SiteMapFov | null | undefined>
  >({})
  const [basemap, setBasemap] = useState<"map" | "sat">(() =>
    localStorage.getItem("site-map:basemap") === "sat" ? "sat" : "map"
  )
  const setBase = (b: "map" | "sat") => {
    localStorage.setItem("site-map:basemap", b)
    setBasemap(b)
  }
  const [showObjects, setShowObjects] = useState(
    () => localStorage.getItem("site-map:sidebar") !== "closed"
  )
  const toggleObjects = () =>
    setShowObjects((v) => {
      localStorage.setItem("site-map:sidebar", v ? "closed" : "open")
      return !v
    })
  // Arriving with ?focus=<deviceId>: fly to it and open its popover, once.
  const focusedRef = useRef(false)
  useEffect(() => {
    if (!focus || focusedRef.current) return
    const map = mapRef.current
    const d = data.devices.find((x) => x.id === focus)
    if (map && d) {
      focusedRef.current = true
      // Claim the one-shot auto-fit so the marker draw doesn't reset the view.
      ;(map as unknown as { _smFitted?: boolean })._smFitted = true
      map.setView([d.latitude, d.longitude], Math.max(map.getZoom(), 16))
      setSelected({ kind: "device", id: d.id })
    }
  }, [focus, data.devices, mapReady])

  // The map container's width changes when the rails/sidebars come and go;
  // Leaflet must be told or it renders gray tiles in the newly-revealed area.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const t = setTimeout(() => map.invalidateSize(), 220)
    return () => clearTimeout(t)
  }, [showObjects, mode, selected, selectedRouteId])
  // Refs so stable Leaflet handlers see current state without re-binding.
  const editingRef = useRef(editing)
  const placingRef = useRef(placing)
  const drawingRef = useRef(false)
  editingRef.current = editing
  placingRef.current = placing
  drawingRef.current = mode === "cables" && drawWaypoints !== null

  const placed = useMemo(
    () => data.sites.filter((s) => s.latitude !== null),
    [data.sites]
  )
  const canEditAny =
    data.sites.some((s) => s.can_edit) || canDo("device", "change")

  // Shared popover config — the SAME effective floorplan-popover settings the
  // floor-plan canvas uses, so which linked-device fields show on a device
  // popover is consistent between the floor plan and the site map.
  const popoverCfg = useQuery({
    queryKey: ["floorplan-popover-effective"],
    queryFn: () => api<FloorplanPopoverConfig>("/api/floorplan-popover/"),
    staleTime: 10 * 60_000,
  })
  const popoverFields = popoverCfg.data?.fields

  // Marker palette: user-created tile types + device roles.
  const tileTypes = useQuery({
    queryKey: ["floor-tile-types-all"],
    queryFn: () =>
      api<
        Paginated<{
          id: string
          name: string
          color: string
          icon: string
          has_fov?: boolean
        }>
      >("/api/floor-tile-types/"),
    enabled: editing,
    staleTime: 5 * 60_000,
  })
  const roles = useQuery({
    queryKey: ["device-roles-all"],
    queryFn: () =>
      api<
        Paginated<{
          id: string
          name: string
          color: string
          has_fov?: boolean
        }>
      >("/api/device-roles/"),
    enabled: editing,
    staleTime: 5 * 60_000,
  })
  const markerTypes = useMemo<MarkerTypeOption[]>(
    () => [
      ...(tileTypes.data?.results ?? []).map((t) => ({
        id: t.id,
        name: t.name,
        color: t.color,
        icon: t.icon,
        kind: "tile_type" as const,
        has_fov: t.has_fov,
      })),
      ...(roles.data?.results ?? []).map((r) => ({
        id: r.id,
        name: r.name,
        color: r.color,
        icon: "",
        kind: "role" as const,
        has_fov: r.has_fov,
      })),
    ],
    [tileTypes.data, roles.data]
  )

  const connQuery = useQuery({
    queryKey: ["site-map-connections"],
    queryFn: () =>
      api<{ connections: SiteMapConnection[] }>("/api/site-map/connections/"),
  })
  const connections = useMemo(
    () => connQuery.data?.connections ?? [],
    [connQuery.data]
  )
  const connRef = useRef<L.LayerGroup | null>(null)
  const midpointsRef = useRef<Map<string, [number, number]>>(new Map())

  const routesQuery = useQuery({
    queryKey: ["cable-routes"],
    queryFn: () =>
      api<Paginated<CableRoute>>("/api/cable-routes/?page_size=500"),
  })
  const routes = useMemo(
    () => routesQuery.data?.results ?? [],
    [routesQuery.data]
  )
  const selectedRoute = routes.find((r) => r.id === selectedRouteId) ?? null
  const routesRef = useRef<L.LayerGroup | null>(null)
  const draftRef = useRef<L.LayerGroup | null>(null)
  const reshapeRef = useRef<L.LayerGroup | null>(null)
  const drawnCablesRef = useRef<L.LayerGroup | null>(null)

  // Every cable with two placeable ends — drawn whether or not it's routed.
  const cablesQuery = useQuery({
    queryKey: ["site-map-cables"],
    queryFn: () => api<{ cables: SiteMapCable[] }>("/api/site-map/cables/"),
  })
  const drawnCables = useMemo(
    () => buildDrawnCables(cablesQuery.data?.cables ?? [], routes),
    [cablesQuery.data, routes]
  )
  // device id → the cable ids touching it, for popover counts + one-click trace.
  const cablesByDevice = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const c of cablesQuery.data?.cables ?? []) {
      m.set(c.a.device_id, [...(m.get(c.a.device_id) ?? []), c.id])
      if (c.z.device_id !== c.a.device_id)
        m.set(c.z.device_id, [...(m.get(c.z.device_id) ?? []), c.id])
    }
    return m
  }, [cablesQuery.data])
  // Cables are now their own layer (all of them, cross-site or not), so the
  // connections layer only draws circuits + tunnels.
  const shownConnections = useMemo(
    () => connections.filter((c) => c.kind !== "cable"),
    [connections]
  )

  const invalidate = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["site-map"] })
    qc.invalidateQueries({ queryKey: ["sites"] })
  }, [qc])

  const moveSite = useMutation({
    mutationFn: ({ id, lat, lng }: { id: string; lat: number; lng: number }) =>
      api(`/api/sites/${id}/`, {
        method: "PATCH",
        body: JSON.stringify({
          latitude: lat.toFixed(6),
          longitude: lng.toFixed(6),
        }),
      }),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  })
  const moveDevice = useMutation({
    mutationFn: ({
      id,
      lat,
      lng,
    }: {
      id: string
      lat: number | null
      lng: number | null
    }) =>
      api(`/api/devices/${id}/`, {
        method: "PATCH",
        body: JSON.stringify({
          latitude: lat === null ? null : lat.toFixed(6),
          longitude: lng === null ? null : lng.toFixed(6),
        }),
      }),
    onSuccess: () => {
      invalidate()
      qc.invalidateQueries({ queryKey: ["devices"] })
    },
    onError: (e: Error) => toast.error(e.message),
  })
  const createMarker = useMutation({
    mutationFn: ({
      body,
    }: {
      body: Record<string, unknown>
      typeName: string
      roleId: string | null
    }) =>
      api<SiteMapMarker>("/api/site-markers/", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: (created, v) => {
      invalidate()
      setLinkPrompt({ id: created.id, typeName: v.typeName, roleId: v.roleId })
    },
    onError: (e: Error) => toast.error(e.message),
  })
  const moveMarker = useMutation({
    mutationFn: ({ id, lat, lng }: { id: string; lat: number; lng: number }) =>
      api(`/api/site-markers/${id}/`, {
        method: "PATCH",
        body: JSON.stringify({
          latitude: lat.toFixed(6),
          longitude: lng.toFixed(6),
        }),
      }),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  })
  const deleteMarker = useMutation({
    mutationFn: (id: string) =>
      api(`/api/site-markers/${id}/`, { method: "DELETE" }),
    onSuccess: () => {
      invalidate()
      setSelected(null)
    },
    onError: (e: Error) => toast.error(e.message),
  })
  const updateMarker = useMutation({
    mutationFn: ({
      id,
      patch,
    }: {
      id: string
      patch: { label?: string; description?: string; device_id?: string | null }
    }) =>
      api(`/api/site-markers/${id}/`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  })
  const linkMarkerDevice = useMutation({
    mutationFn: ({ id, deviceId }: { id: string; deviceId: string | null }) =>
      api(`/api/site-markers/${id}/`, {
        method: "PATCH",
        body: JSON.stringify({ device_id: deviceId }),
      }),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  })
  const invalidateRoutes = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["cable-routes"] })
    qc.invalidateQueries({ queryKey: ["site-map-connections"] })
  }, [qc])
  const createRoute = useMutation({
    mutationFn: (payload: CableRouteWritePayload) =>
      api<CableRoute>("/api/cable-routes/", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: (r) => {
      invalidateRoutes()
      setSelectedRouteId(r.id)
      toast.success(`Added ${r.name}`)
    },
    onError: (e: Error) => toast.error(e.message),
  })
  const patchRoute = useMutation({
    mutationFn: ({
      id,
      patch,
    }: {
      id: string
      patch: CableRouteWritePayload
    }) =>
      api<CableRoute>(`/api/cable-routes/${id}/`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    onSuccess: invalidateRoutes,
    onError: (e: Error) => toast.error(e.message),
  })
  const deleteRoute = useMutation({
    mutationFn: (id: string) =>
      api(`/api/cable-routes/${id}/`, { method: "DELETE" }),
    onSuccess: () => {
      invalidateRoutes()
      setSelectedRouteId(null)
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const fovBody = (fov: SiteMapFov | null) => ({
    fov_direction: fov?.direction ?? null,
    fov_deg: fov?.deg ?? null,
    fov_distance_m: fov?.distance_m ?? null,
    fov_ptz: fov?.ptz ?? false,
  })
  const saveDeviceFov = useMutation({
    mutationFn: ({ id, fov }: { id: string; fov: SiteMapFov | null }) =>
      api(`/api/devices/${id}/`, {
        method: "PATCH",
        body: JSON.stringify(fovBody(fov)),
      }),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  })
  const saveMarkerFov = useMutation({
    mutationFn: ({ id, fov }: { id: string; fov: SiteMapFov | null }) =>
      api(`/api/site-markers/${id}/`, {
        method: "PATCH",
        body: JSON.stringify(fovBody(fov)),
      }),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  })
  const moveSiteRef = useRef(moveSite)
  const moveDeviceRef = useRef(moveDevice)
  const createMarkerRef = useRef(createMarker)
  moveSiteRef.current = moveSite
  moveDeviceRef.current = moveDevice
  createMarkerRef.current = createMarker

  // Create the map once.
  useEffect(() => {
    if (!mapEl.current || mapRef.current) return
    const map = L.map(mapEl.current, { maxZoom: 19, worldCopyJump: true })
    // Basemap layer is swapped by the effect below.
    map.on("click", (e: L.LeafletMouseEvent) => {
      if (drawingRef.current) {
        setDrawWaypoints((prev) =>
          prev ? [...prev, [e.latlng.lat, e.latlng.lng]] : prev
        )
        return
      }
      const target = placingRef.current
      if (editingRef.current && target) {
        if (target.kind === "site") {
          moveSiteRef.current.mutate({
            id: target.id,
            lat: e.latlng.lat,
            lng: e.latlng.lng,
          })
        } else {
          createMarkerRef.current.mutate({
            body: {
              latitude: e.latlng.lat.toFixed(6),
              longitude: e.latlng.lng.toFixed(6),
              [target.type.kind === "tile_type"
                ? "tile_type_id"
                : "role_type_id"]: target.type.id,
            },
            typeName: target.name,
            roleId: target.type.kind === "role" ? target.type.id : null,
          })
        }
        toast.success(`Placed ${target.name}`)
        // A marker type stays armed (stamp several); sites/devices don't.
        if (target.kind !== "marker") setPlacing(null)
        return
      }
      setSelected(null) // click-away closes the popover
      setSelectedRouteId(null)
    })
    map.on("dblclick", (e: L.LeafletMouseEvent) => {
      if (!drawingRef.current) return
      L.DomEvent.stopPropagation(e)
      setDrawWaypoints((prev) => {
        if (prev && prev.length >= 2) setNamingWaypoints(prev)
        return null
      })
    })
    map.on("movestart zoomstart", () => setSelected(null))
    mapRef.current = map
    setMapReady(true)

    // Detect CSP-blocked tiles for BOTH basemaps (street + satellite) — the
    // reverse proxy's img-src must allow each tile host, and a stale nginx
    // config otherwise fails silently with a gray map.
    const tileHosts = [data.tiles.url, data.tiles.satellite.url]
      .map((u) => {
        try {
          return new URL(u.replace(/\{[xyz]\}/g, "0")).host
        } catch {
          return ""
        }
      })
      .filter(Boolean)
    const onCspViolation = (e: SecurityPolicyViolationEvent) => {
      if (
        e.violatedDirective.startsWith("img-src") &&
        tileHosts.some((h) => e.blockedURI.includes(h))
      ) {
        setTilesBlocked(true)
      }
    }
    document.addEventListener("securitypolicyviolation", onCspViolation)
    return () => {
      document.removeEventListener("securitypolicyviolation", onCspViolation)
      map.remove()
      mapRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Basemap — street tiles or satellite imagery, swapped in place.
  const baseRef = useRef<L.TileLayer | null>(null)
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    baseRef.current?.remove()
    setTilesBlocked(false) // re-detect per basemap
    const cfg =
      basemap === "sat"
        ? data.tiles.satellite
        : { url: data.tiles.url, attribution: data.tiles.attribution }
    const layer = L.tileLayer(cfg.url, {
      attribution: cfg.attribution,
      maxZoom: 19,
      className: basemap === "sat" ? "" : "sm-tiles",
      referrerPolicy: "strict-origin-when-cross-origin",
    })
    layer.addTo(map)
    baseRef.current = layer
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    basemap,
    data.tiles.url,
    data.tiles.attribution,
    data.tiles.satellite.url,
    data.tiles.satellite.attribution,
  ])

  // Connection arcs.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    connRef.current?.remove()
    midpointsRef.current = new Map()
    if (!layers.links || shownConnections.length === 0) return
    const built = buildConnectionsLayer(shownConnections, (id) =>
      setSelected({ kind: "connection", id })
    )
    built.group.addTo(map)
    connRef.current = built.group
    midpointsRef.current = built.midpoints
  }, [shownConnections, layers.links])

  // Route channels (view + edit); rebuilt on selection so the selected one
  // reads heavier, exactly like tray selection on the floor plan.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    routesRef.current?.remove()
    if (!layers.routes || routes.length === 0) return
    const layer = buildRoutesLayer(routes, {
      selectedId: selectedRouteId,
      onSelect: (id) => setSelectedRouteId(id),
    })
    layer.addTo(map)
    routesRef.current = layer
  }, [routes, layers.routes, selectedRouteId])

  // Every cable, drawn: routed cables follow their route geometry, un-routed
  // ones a curved chord. Highlight thickens members, dims the rest. Toggling
  // the "routes" layer hides the routed geometry but not the raw cables — so
  // cabling is always visible.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    drawnCablesRef.current?.remove()
    if (drawnCables.length === 0) return
    const layer = buildDrawnCablesLayer(drawnCables, {
      highlightIds: highlightCableIds,
      onSelect: (id) =>
        setHighlightCableIds((prev) =>
          prev.size === 1 && prev.has(id) ? new Set() : new Set([id])
        ),
    })
    layer.addTo(map)
    drawnCablesRef.current = layer
  }, [drawnCables, highlightCableIds])

  // Arriving with ?trace=<cableId>: highlight the cable and fit the view —
  // once, when the data lands.
  const tracedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!trace || tracedRef.current === trace) return
    const rc = drawnCables.find((c) => c.id === trace)
    if (!rc) return // cables still loading — effect re-runs
    tracedRef.current = trace
    setHighlightCableIds(new Set([trace]))
    const carrier = routes.find((r) => r.cables.some((c) => c.id === trace))
    if (carrier) setSelectedRouteId(carrier.id)
    const map = mapRef.current
    if (map && rc.path.length >= 2) {
      map.fitBounds(L.latLngBounds(rc.path).pad(0.25), { maxZoom: 16 })
    }
  }, [trace, drawnCables, routes])

  // Dashed draw preview while a new route is being clicked out.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    draftRef.current?.remove()
    draftRef.current = null
    if (!drawWaypoints || drawWaypoints.length === 0) return
    const layer = buildDraftLayer(drawWaypoints)
    layer.addTo(map)
    draftRef.current = layer
  }, [drawWaypoints])

  // Reshape handles for the selected route in edit-shape mode.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    reshapeRef.current?.remove()
    reshapeRef.current = null
    if (mode !== "cables" || !routeEditMode || !selectedRoute) return
    const layer = buildReshapeLayer(selectedRoute.waypoints, (waypoints) =>
      patchRoute.mutate({ id: selectedRoute.id, patch: { waypoints } })
    )
    layer.addTo(map)
    reshapeRef.current = layer
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, routeEditMode, selectedRoute])

  // Drawing wants dblclick for "finish", not zoom.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (drawWaypoints !== null) map.doubleClickZoom.disable()
    else map.doubleClickZoom.enable()
  }, [drawWaypoints])

  // FOV cones — devices + free markers, live drafts overlaid.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    fovRef.current?.remove()
    if (!showFov) return
    const sources: FovSource[] = []
    if (layers.devices) {
      for (const d of data.devices) {
        const fov = d.id in fovDraft ? fovDraft[d.id] : d.fov
        if (!fov) continue
        sources.push({
          lat: d.latitude,
          lng: d.longitude,
          color: d.role?.color || "",
          fov,
        })
      }
    }
    for (const m of data.markers) {
      const fov = m.id in fovDraft ? fovDraft[m.id] : m.fov
      if (!fov) continue
      sources.push({
        lat: m.latitude,
        lng: m.longitude,
        color: m.type?.color || "",
        fov,
      })
    }
    const layer = buildFovLayer(sources)
    layer.addTo(map)
    fovRef.current = layer
  }, [data, fovDraft, layers.devices, showFov])

  // (Re)draw markers whenever data / edit mode / layers change.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    markersRef.current?.remove()
    const group = L.layerGroup()

    if (layers.sites) {
      for (const s of placed) {
        const m = L.marker([s.latitude!, s.longitude!], {
          icon: siteIcon(s, selected?.kind === "site" && selected.id === s.id),
          draggable: editing && s.can_edit,
        })
        m.on("dragend", () => {
          const p = m.getLatLng()
          moveSiteRef.current.mutate({ id: s.id, lat: p.lat, lng: p.lng })
        })
        m.on("click", (e: L.LeafletMouseEvent) => {
          L.DomEvent.stopPropagation(e)
          setSelected({ kind: "site", id: s.id })
        })
        group.addLayer(m)
      }
    }
    if (layers.devices) {
      for (const d of data.devices) {
        const m = L.marker([d.latitude, d.longitude], {
          icon: deviceIcon(
            d,
            selected?.kind === "device" && selected.id === d.id
          ),
          draggable: editing && d.can_edit,
          zIndexOffset: -100,
        })
        m.on("dragend", () => {
          const p = m.getLatLng()
          moveDeviceRef.current.mutate({ id: d.id, lat: p.lat, lng: p.lng })
        })
        m.on("click", (e: L.LeafletMouseEvent) => {
          L.DomEvent.stopPropagation(e)
          setSelected({ kind: "device", id: d.id })
        })
        group.addLayer(m)
      }
    }
    for (const mk of data.markers) {
      const m = L.marker([mk.latitude, mk.longitude], {
        icon: freeMarkerIcon(
          mk,
          selected?.kind === "marker" && selected.id === mk.id
        ),
        draggable: editing,
        zIndexOffset: -50,
      })
      m.on("dragend", () => {
        const p = m.getLatLng()
        moveMarker.mutate({ id: mk.id, lat: p.lat, lng: p.lng })
      })
      m.on("click", (e: L.LeafletMouseEvent) => {
        L.DomEvent.stopPropagation(e)
        setSelected({ kind: "marker", id: mk.id })
      })
      group.addLayer(m)
    }

    group.addTo(map)
    markersRef.current = group

    if (!(map as unknown as { _smFitted?: boolean })._smFitted) {
      fitAll(map)
      ;(map as unknown as { _smFitted?: boolean })._smFitted = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, editing, placed, layers, selected])

  const fitAll = useCallback(
    (map?: L.Map | null) => {
      const m = map ?? mapRef.current
      if (!m) return
      const pts: [number, number][] = [
        ...placed.map((s) => [s.latitude!, s.longitude!] as [number, number]),
        ...data.devices.map(
          (d) => [d.latitude, d.longitude] as [number, number]
        ),
        ...data.markers.map(
          (mk) => [mk.latitude, mk.longitude] as [number, number]
        ),
      ]
      if (pts.length > 0) {
        m.fitBounds(L.latLngBounds(pts).pad(0.25), { maxZoom: 15 })
      } else {
        m.setView([30, 10], 2)
      }
    },
    [placed, data.devices, data.markers]
  )

  // Resolve the selection.
  const selSite =
    selected?.kind === "site"
      ? (placed.find((s) => s.id === selected.id) ?? null)
      : null
  const selDevice =
    selected?.kind === "device"
      ? (data.devices.find((d) => d.id === selected.id) ?? null)
      : null
  const selMarker =
    selected?.kind === "marker"
      ? (data.markers.find((m) => m.id === selected.id) ?? null)
      : null
  const selConn =
    selected?.kind === "connection"
      ? (connections.find((c) => c.id === selected.id) ?? null)
      : null

  // Keyboard: Escape disarms/deselects; Delete removes a selected marker in
  // edit mode. Skipped while typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return
      if (e.key === "Escape") {
        if (drawWaypoints !== null) {
          setDrawWaypoints(null)
          return
        }
        if (routeEditMode) {
          setRouteEditMode(false)
          return
        }
        setPlacing(null)
        setSelected(null)
        setSelectedRouteId(null)
        return
      }
      if (e.key === "Enter" && drawWaypoints !== null) {
        e.preventDefault()
        if (drawWaypoints.length >= 2) setNamingWaypoints(drawWaypoints)
        setDrawWaypoints(null)
        return
      }
      if (
        editing &&
        selMarker &&
        (e.key === "Delete" || e.key === "Backspace")
      ) {
        e.preventDefault()
        deleteMarker.mutate(selMarker.id)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, selMarker, drawWaypoints, routeEditMode])

  // Project the selected object into container coordinates for the popover.
  useEffect(() => {
    const map = mapRef.current
    const target = selSite ?? selDevice ?? selMarker
    if (!map || (!target && !selConn)) {
      setPopPos(null)
      return
    }
    const ll: [number, number] = target
      ? [Number(target.latitude), Number(target.longitude)]
      : (midpointsRef.current.get(selConn!.id) ?? [0, 0])
    const update = () => {
      const p = map.latLngToContainerPoint(ll)
      setPopPos({ x: p.x, y: p.y })
    }
    update()
    map.on("move zoom", update)
    return () => {
      map.off("move zoom", update)
    }
  }, [selSite, selDevice, selMarker, selConn])

  const removeFromMap = (d: SiteMapDevice) => {
    moveDevice.mutate({ id: d.id, lat: null, lng: null })
    setSelected(null)
  }
  const flyTo = (lat: number, lng: number) => {
    const map = mapRef.current
    if (map) map.flyTo([lat, lng], Math.max(map.getZoom(), 12))
  }
  const fitToCables = (ids: string[]) => {
    const map = mapRef.current
    if (!map) return
    const pts = drawnCables
      .filter((c) => ids.includes(c.id))
      .flatMap((c) => c.path)
    if (pts.length >= 2)
      map.fitBounds(L.latLngBounds(pts as [number, number][]).pad(0.3), {
        maxZoom: 16,
      })
  }

  // Inspector slots. FOV isn't a placement action, so it's editable whenever
  // you select a camera you can change — not only in Edit mode.
  const deviceFovEditor =
    selDevice?.can_edit && selDevice.has_fov ? (
      <FovEditor
        value={
          selDevice.id in fovDraft
            ? (fovDraft[selDevice.id] ?? null)
            : selDevice.fov
        }
        onDraft={(v) => setFovDraft((m) => ({ ...m, [selDevice.id]: v }))}
        onCommit={(v) => saveDeviceFov.mutate({ id: selDevice.id, fov: v })}
      />
    ) : undefined
  const markerFovEditor =
    selMarker && canEditAny && selMarker.type?.has_fov ? (
      <FovEditor
        value={
          selMarker.id in fovDraft
            ? (fovDraft[selMarker.id] ?? null)
            : selMarker.fov
        }
        onDraft={(v) => setFovDraft((m) => ({ ...m, [selMarker.id]: v }))}
        onCommit={(v) => saveMarkerFov.mutate({ id: selMarker.id, fov: v })}
      />
    ) : undefined
  const markerDeviceLink =
    selMarker && canEditAny ? (
      <MarkerDeviceLink
        marker={selMarker}
        onLink={(deviceId) =>
          linkMarkerDevice.mutate({ id: selMarker.id, deviceId })
        }
      />
    ) : undefined

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* ── Header ──────────────────────────────────────────────────── */}
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4 lg:px-6">
        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold">Site map</h1>
          <p className="truncate text-[11px] text-muted-foreground">
            <span className="num">
              {placed.length}/{data.sites.length}
            </span>{" "}
            sites placed
            {data.devices.length > 0 && (
              <>
                {" · "}
                <span className="num">{data.devices.length}</span> devices
              </>
            )}
            {data.markers.length > 0 && (
              <>
                {" · "}
                <span className="num">{data.markers.length}</span> markers
              </>
            )}
            {connections.length > 0 && (
              <>
                {" · "}
                <span className="num">{connections.length}</span> links
              </>
            )}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {canEditAny && (
            <SegmentedTabs<"view" | "layout" | "cables">
              value={mode}
              onValueChange={(m) => {
                setMode(m)
                setPlacing(null)
                setDrawWaypoints(null)
                setRouteEditMode(false)
              }}
              items={[
                { value: "view", label: "View" },
                { value: "layout", label: "Layout" },
                { value: "cables", label: "Cables" },
              ]}
            />
          )}
          <MapSearch
            sites={placed}
            devices={data.devices}
            markers={data.markers}
            onPick={(sel, lat, lng) => {
              flyTo(lat, lng)
              setSelected(sel)
            }}
          />
          <Button
            variant="outline"
            size="sm"
            title="Fit to view"
            onClick={() => fitAll()}
          >
            <Maximize className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setBase(basemap === "sat" ? "map" : "sat")}
            className={cn(basemap !== "sat" && "text-muted-foreground")}
            title="Toggle satellite imagery"
          >
            <Satellite className="h-3.5 w-3.5" /> Satellite
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={toggleObjects}
            className={cn(!showObjects && "text-muted-foreground")}
            title="List everything on this map"
          >
            <PanelRight className="h-3.5 w-3.5" /> Objects
          </Button>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm">
                <SlidersHorizontal className="h-3.5 w-3.5" /> View
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-56 gap-1 p-2">
              <label className="flex items-center gap-2 rounded px-2 py-1.5 text-[13px] hover:bg-muted/60">
                <input
                  type="checkbox"
                  className="ck"
                  checked={layers.sites}
                  onChange={(e) =>
                    setLayers((l) => ({ ...l, sites: e.target.checked }))
                  }
                />
                <span>Sites</span>
              </label>
              <label className="flex items-center gap-2 rounded px-2 py-1.5 text-[13px] hover:bg-muted/60">
                <input
                  type="checkbox"
                  className="ck"
                  checked={layers.devices}
                  onChange={(e) =>
                    setLayers((l) => ({ ...l, devices: e.target.checked }))
                  }
                />
                <span>Devices</span>
              </label>
              <label className="flex items-center gap-2 rounded px-2 py-1.5 text-[13px] hover:bg-muted/60">
                <input
                  type="checkbox"
                  className="ck"
                  checked={layers.links}
                  onChange={(e) =>
                    setLayers((l) => ({ ...l, links: e.target.checked }))
                  }
                />
                <span>Links (circuits · tunnels · cables)</span>
              </label>
              <label className="flex items-center gap-2 rounded px-2 py-1.5 text-[13px] hover:bg-muted/60">
                <input
                  type="checkbox"
                  className="ck"
                  checked={layers.routes}
                  onChange={(e) =>
                    setLayers((l) => ({ ...l, routes: e.target.checked }))
                  }
                />
                <span>Cable routes</span>
              </label>
              <div className="my-1 h-px bg-border" />
              <label className="flex items-center gap-2 rounded px-2 py-1.5 text-[13px] hover:bg-muted/60">
                <input
                  type="checkbox"
                  className="ck"
                  checked={showFov}
                  onChange={(e) => setShowFov(e.target.checked)}
                />
                <span>Camera FOV cones</span>
              </label>
            </PopoverContent>
          </Popover>
        </div>
      </header>

      {/* ── Body: palette rail · map · inspector · objects ──────────── */}
      <div className="flex min-h-0 flex-1">
        {mode === "cables" && (
          <RouteRail
            routes={routes}
            selectedRouteId={selectedRouteId}
            drawing={drawWaypoints !== null}
            editMode={routeEditMode}
            onToggleEdit={() => setRouteEditMode((v) => !v)}
            onSelectRoute={setSelectedRouteId}
            onStartDraw={() => {
              setSelectedRouteId(null)
              setRouteEditMode(false)
              setDrawWaypoints([])
            }}
            onCancelDraw={() => setDrawWaypoints(null)}
          />
        )}
        {editing && (
          <MapPaletteRail
            sites={data.sites}
            placing={placing}
            onPlaceSite={(site) =>
              setPlacing({ kind: "site", id: site.id, name: site.name })
            }
            markerTypes={markerTypes}
            onArmMarkerType={(t) =>
              setPlacing({ kind: "marker", id: t.id, name: t.name, type: t })
            }
          />
        )}

        <div className="relative isolate z-0 min-w-0 flex-1">
          <div ref={mapEl} className="absolute inset-0" />

          {tilesBlocked && (
            <div className="absolute inset-x-0 top-3 z-[1000] mx-auto w-fit max-w-xl rounded-lg border border-amber-500/40 bg-background/95 px-4 py-3 text-[13px] shadow-sm backdrop-blur">
              <p className="font-medium">
                {basemap === "sat" ? "Satellite imagery is" : "Map tiles are"}{" "}
                blocked by this server's Content-Security-Policy.
              </p>
              <p className="mt-1 text-muted-foreground">
                The reverse proxy's <span className="font-mono">img-src</span>{" "}
                directive doesn't allow the tile server — see{" "}
                <a
                  href="/docs/features/site-map/"
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary hover:underline"
                >
                  the Site map docs
                </a>{" "}
                for the one-line fix. Markers and placement still work.
              </p>
            </div>
          )}

          {drawWaypoints !== null && (
            <div className="absolute bottom-4 left-1/2 z-[1000] -translate-x-1/2 rounded-full border border-border bg-background px-4 py-1.5 text-xs shadow-sm">
              Click the map along the run · double-click or Enter to finish ·
              Esc to cancel (<span className="num">{drawWaypoints.length}</span>
              )
            </div>
          )}
          {editing && placing && (
            <div className="absolute bottom-4 left-1/2 z-[1000] flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-background px-4 py-1.5 text-xs shadow-sm">
              <span>
                Click the map to place{" "}
                <span className="font-medium">{placing.name}</span>
                {placing.kind === "marker" && " — stays armed"} · Esc to cancel
              </span>
              <button
                onClick={() => setPlacing(null)}
                aria-label="Cancel placing"
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            </div>
          )}

          {/* rich popover, anchored to the selected object */}
          {popPos && (selSite || selDevice || selMarker || selConn) && (
            <div
              className="absolute z-[900] w-max min-w-[15rem] max-w-[22rem] -translate-x-1/2 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg"
              style={{ left: popPos.x, top: popPos.y + 14 }}
            >
              {selSite && (
                <SitePopover site={selSite} onClose={() => setSelected(null)} />
              )}
              {!selectedRoute && selDevice && (
                <DevicePopover
                  device={selDevice}
                  fields={popoverFields}
                  cableIds={cablesByDevice.get(selDevice.id) ?? []}
                  onTrace={(ids) => {
                    traceCables(ids)
                    fitToCables(ids)
                  }}
                  onClose={() => setSelected(null)}
                />
              )}
              {!selectedRoute && selMarker && (
                <MarkerPopover
                  marker={selMarker}
                  fields={popoverFields}
                  onClose={() => setSelected(null)}
                />
              )}
              {!selectedRoute && selConn && (
                <ConnectionPopover
                  edge={selConn}
                  onClose={() => setSelected(null)}
                />
              )}
            </div>
          )}
        </div>

        {selectedRoute && (
          <RouteInspector
            key={selectedRoute.id}
            route={selectedRoute}
            highlightCableId={[...highlightCableIds][0] ?? null}
            editing={routeEditMode}
            canEdit={canEditAny}
            onEditShape={() => {
              setMode("cables")
              setRouteEditMode((v) => !v)
            }}
            onHighlightCable={(id) =>
              setHighlightCableIds(id ? new Set([id]) : new Set())
            }
            onPatch={(patch) =>
              patchRoute.mutate({ id: selectedRoute.id, patch })
            }
            onDelete={() => deleteRoute.mutate(selectedRoute.id)}
            onClose={() => {
              setSelectedRouteId(null)
              setRouteEditMode(false)
            }}
          />
        )}
        {!selectedRoute && selSite && (
          <SiteInspector site={selSite} onClose={() => setSelected(null)} />
        )}
        {selDevice && (
          <DeviceInspector
            device={selDevice}
            editing={editing}
            fovEditor={deviceFovEditor}
            onTraceCables={(ids) => {
              traceCables(ids)
              fitToCables(ids)
            }}
            onConnected={() => {
              qc.invalidateQueries({ queryKey: ["site-map-cables"] })
              qc.invalidateQueries({ queryKey: ["device-paths", selDevice.id] })
            }}
            onRemove={() => removeFromMap(selDevice)}
            onClose={() => setSelected(null)}
          />
        )}
        {selMarker && (
          <MarkerInspector
            key={selMarker.id}
            marker={selMarker}
            canEdit={canEditAny}
            editing={editing}
            deviceLink={markerDeviceLink}
            fovEditor={markerFovEditor}
            onTraceCables={(ids) => {
              traceCables(ids)
              fitToCables(ids)
            }}
            onUpdate={(patch) =>
              updateMarker.mutate({ id: selMarker.id, patch })
            }
            onDelete={() => deleteMarker.mutate(selMarker.id)}
            onClose={() => setSelected(null)}
          />
        )}
        {selConn && (
          <ConnectionInspector
            edge={selConn}
            onClose={() => setSelected(null)}
          />
        )}

        {/* Outermost right aside, so it coexists with whichever inspector is
            open rather than fighting it for the gutter. */}
        <RouteNameDialog
          waypoints={namingWaypoints}
          onCancel={() => setNamingWaypoints(null)}
          onCreate={(payload) => {
            createRoute.mutate(payload)
            setNamingWaypoints(null)
          }}
        />

        <MarkerLinkDialog
          prompt={linkPrompt}
          onClose={() => setLinkPrompt(null)}
          onSave={(patch) => {
            updateMarker.mutate({ id: linkPrompt!.id, patch })
            setLinkPrompt(null)
          }}
        />

        {showObjects && (
          <MapObjectsSidebar
            sites={data.sites}
            devices={data.devices}
            markers={data.markers}
            connections={connections}
            routes={routes}
            selectedRouteId={selectedRouteId}
            selected={selected}
            onSelect={setSelected}
            onFocus={flyTo}
            onFocusConnection={(id) => {
              const mid = midpointsRef.current.get(id)
              const map = mapRef.current
              if (mid && map) map.flyTo(mid, map.getZoom())
            }}
            onPickRoute={(routeId, cableId) => {
              const r = routes.find((x) => x.id === routeId)
              const map = mapRef.current
              if (r && map && r.waypoints.length >= 2) {
                map.fitBounds(L.latLngBounds(r.waypoints).pad(0.3), {
                  maxZoom: 16,
                })
              }
              setSelectedRouteId(routeId)
              setHighlightCableIds(cableId ? new Set([cableId]) : new Set())
            }}
          />
        )}
      </div>
    </div>
  )
}

/** After stamping a marker: name it and (optionally) link the real device.
 * Role markers open the picker pre-filtered to that role. The name is
 * optional — an unnamed marker displays its linked device's name, then the
 * type name. */
function MarkerLinkDialog({
  prompt,
  onClose,
  onSave,
}: {
  prompt: { id: string; typeName: string; roleId: string | null } | null
  onClose: () => void
  onSave: (patch: { label?: string; device_id?: string | null }) => void
}) {
  const [name, setName] = useState("")
  const [deviceId, setDeviceId] = useState<string | null>(null)
  useEffect(() => {
    if (prompt) {
      setName("")
      setDeviceId(null)
    }
  }, [prompt])
  const dirty = name.trim() !== "" || deviceId !== null

  return (
    <Dialog open={prompt !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Placed {prompt?.typeName}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <Field
            label="Name"
            hint="Optional — defaults to the linked device's name"
          >
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={prompt?.typeName}
              className="h-9"
            />
          </Field>
          <DevicePicker
            label="Linked device (optional)"
            value={deviceId}
            onChange={setDeviceId}
            preferQuery={prompt?.roleId ? `role=${prompt.roleId}` : undefined}
            initialFilters={
              prompt?.roleId ? { role: prompt.roleId } : undefined
            }
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Skip
            </Button>
            <Button
              type="button"
              disabled={!dirty}
              onClick={() =>
                onSave({
                  ...(name.trim() ? { label: name.trim() } : {}),
                  ...(deviceId ? { device_id: deviceId } : {}),
                })
              }
            >
              Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Header search — jump to a site / device / marker, like the plan's search. */
function MapSearch({
  sites,
  devices,
  markers,
  onPick,
}: {
  sites: SiteMapSite[]
  devices: SiteMapDevice[]
  markers: SiteMapMarker[]
  onPick: (sel: MapSelected, lat: number, lng: number) => void
}) {
  const [value, setValue] = useState("")
  const [open, setOpen] = useState(false)
  const q = value.trim().toLowerCase()
  const matches = useMemo(() => {
    if (!q) return []
    const rows: {
      sel: MapSelected
      lat: number
      lng: number
      name: string
      hint: string
      color: string
    }[] = []
    for (const s of sites) {
      if (s.name.toLowerCase().includes(q))
        rows.push({
          sel: { kind: "site", id: s.id },
          lat: Number(s.latitude),
          lng: Number(s.longitude),
          name: s.name,
          hint: "site",
          color: "#71717a",
        })
    }
    for (const d of devices) {
      if (d.name.toLowerCase().includes(q))
        rows.push({
          sel: { kind: "device", id: d.id },
          lat: d.latitude,
          lng: d.longitude,
          name: d.name,
          hint: d.role?.name ?? "device",
          color: d.role?.color || "#71717a",
        })
    }
    for (const m of markers) {
      const name = m.label || m.type?.name || "Marker"
      if (name.toLowerCase().includes(q))
        rows.push({
          sel: { kind: "marker", id: m.id },
          lat: m.latitude,
          lng: m.longitude,
          name,
          hint: m.type?.name ?? "marker",
          color: m.type?.color || "#71717a",
        })
    }
    return rows.slice(0, 8)
  }, [q, sites, devices, markers])

  return (
    <Popover open={open && matches.length > 0} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <div className="relative">
          <Search className="absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Find on map…"
            value={value}
            onChange={(e) => {
              setValue(e.target.value)
              setOpen(true)
            }}
            className="h-8 w-48 pl-8 text-xs"
          />
        </div>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-64 p-1"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {matches.map((m) => (
          <button
            key={`${m.sel.kind}:${m.sel.id}`}
            type="button"
            onClick={() => {
              onPick(m.sel, m.lat, m.lng)
              setOpen(false)
            }}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-muted/60"
          >
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ backgroundColor: m.color }}
            />
            <span className="truncate">{m.name}</span>
            <span className="ml-auto text-[10px] text-muted-foreground">
              {m.hint}
            </span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}

// ── popovers (anchored quick-glance cards; the inspector holds the tools) ──

function PopHeader({
  title,
  mono,
  onClose,
}: {
  title: string
  mono?: boolean
  onClose: () => void
}) {
  return (
    <div className="flex items-start justify-between gap-2">
      <span
        className={"text-[13px] font-semibold " + (mono ? "font-mono" : "")}
      >
        {title}
      </span>
      <button
        onClick={onClose}
        className="text-muted-foreground hover:text-foreground"
        aria-label="Close"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}

function SitePopover({
  site: s,
  onClose,
}: {
  site: SiteMapSite
  onClose: () => void
}) {
  return (
    <div className="grid gap-2">
      <PopHeader title={s.name} onClose={onClose} />
      <div className="text-[12px] text-muted-foreground">
        {s.device_count} device{s.device_count === 1 ? "" : "s"}
        {s.floor_plan_count > 0 &&
          ` · ${s.floor_plan_count} floor plan${s.floor_plan_count === 1 ? "" : "s"}`}
      </div>
      {s.floor_plans.length > 0 && (
        <div className="grid gap-0.5">
          {s.floor_plans.map((fp) => (
            <Link
              key={fp.id}
              to="/floorplans/$id"
              params={{ id: fp.id }}
              className="truncate rounded px-1.5 py-1 text-[12px] hover:bg-muted"
            >
              ⌗ {fp.name}
            </Link>
          ))}
        </div>
      )}
      <Button size="sm" variant="outline" asChild className="h-7">
        <Link to="/sites/$id" params={{ id: s.id }}>
          Open site →
        </Link>
      </Button>
    </div>
  )
}

// One configured popover field → its device row (or null to skip). The site map
// honors the SAME keys the floor-plan popover config sets, mapped to the device;
// tile-only keys (position, size, utilization, colour, …) have no device
// equivalent and fall through to null. `name` is the header and `linked` is the
// Open-device action, both handled in DevicePopover.
function deviceFieldRow(
  key: string,
  d: SiteMapDeviceInfo,
  cfDefs?: CustomField[]
): { label: string; node: ReactNode } | null {
  switch (key) {
    case "type":
      return d.device_type
        ? {
            label: "Type",
            node: <Badge variant="outline">{d.device_type}</Badge>,
          }
        : null
    case "status":
    case "linked_status":
      return d.status
        ? {
            label: "Status",
            node: (
              <ColorBadge
                name={d.status.name}
                color={d.status.color || undefined}
              />
            ),
          }
        : null
    case "linked_role":
      return d.role
        ? {
            label: "Role",
            node: (
              <ColorBadge
                name={d.role.name}
                color={d.role.color || undefined}
              />
            ),
          }
        : null
    case "check":
      return d.check
        ? {
            label: "Monitoring",
            node: <CheckStatusBadge status={d.check as CheckStatus} />,
          }
        : null
    case "site":
    case "linked_site":
      return d.site
        ? {
            label: "Site",
            node: (
              <Link
                to="/sites/$id"
                params={{ id: d.site.id }}
                className="text-primary hover:underline"
              >
                {d.site.name}
              </Link>
            ),
          }
        : null
    case "linked_description":
      return d.description
        ? { label: "Description", node: <span>{d.description}</span> }
        : null
    case "linked_primary_ip":
      return d.primary_ip
        ? {
            label: "Primary IP",
            node: (
              <Link
                to="/ips/$id"
                params={{ id: d.primary_ip.id }}
                className="font-mono text-primary hover:underline"
              >
                {d.primary_ip.ip_address}
              </Link>
            ),
          }
        : null
    case "linked_serial":
      return d.serial_number
        ? {
            label: "Serial",
            node: <span className="font-mono">{d.serial_number}</span>,
          }
        : null
    case "linked_asset_tag":
      return d.asset_tag
        ? {
            label: "Asset tag",
            node: <span className="font-mono">{d.asset_tag}</span>,
          }
        : null
    case "linked_numid":
      return d.numid != null
        ? { label: "ID", node: <span className="num">#{d.numid}</span> }
        : null
    case "tags":
    case "linked_tags":
      return d.tags?.length
        ? { label: "Tags", node: <TagList tags={d.tags} /> }
        : null
    default:
      if (key.startsWith("cf_")) {
        const cfKey = key.slice(3)
        const v = d.custom_fields?.[cfKey]
        if (v === null || v === undefined || v === "") return null
        const def = cfDefs?.find((x) => x.key === cfKey)
        return { label: def?.label ?? cfKey, node: formatCustomValue(def, v) }
      }
      return null
  }
}

// The device detail block (front image + the configured field rows), shared by
// a placed device pin and a marker linked to a device — so both show the same
// details the floor-plan popover config sets.
function DeviceDetails({
  device: d,
  fields,
}: {
  device: SiteMapDeviceInfo
  fields?: string[]
}) {
  const cfDefs = useCustomFieldDefs("device").data?.results
  const keys = fields ?? [
    "type",
    "linked_status",
    "linked_primary_ip",
    "linked_site",
  ]
  const rows = keys
    .map((key) => ({ key, row: deviceFieldRow(key, d, cfDefs) }))
    .filter(
      (r): r is { key: string; row: { label: string; node: ReactNode } } =>
        !!r.row
    )
  return (
    <>
      {d.front_image && (
        <img
          src={d.front_image}
          alt={d.device_type ?? "device"}
          className="max-h-14 w-full rounded-md border border-border object-contain"
        />
      )}
      {rows.length > 0 && (
        <div className="grid gap-1">
          {rows.map(({ key, row }) => (
            <div
              key={key}
              className="flex items-baseline justify-between gap-3 text-[12px]"
            >
              <span className="shrink-0 text-muted-foreground">
                {row.label}
              </span>
              <span className="min-w-0 text-right break-words">{row.node}</span>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

function DevicePopover({
  device: d,
  fields,
  cableIds,
  onTrace,
  onClose,
}: {
  device: SiteMapDevice
  /** Effective floorplan-popover fields (shared with the floor plan). Undefined
   * while loading → a sensible default; once loaded, honour the admin's config
   * exactly, so the map shows the same details a floor-plan tile would. */
  fields?: string[]
  cableIds: string[]
  onTrace: (ids: string[]) => void
  onClose: () => void
}) {
  return (
    <div className="grid gap-2">
      <PopHeader title={d.name} mono onClose={onClose} />
      <DeviceDetails device={d} fields={fields} />
      <div className="flex items-center justify-between text-[12px]">
        <span className="text-muted-foreground">
          <span className="num">{cableIds.length}</span> cable
          {cableIds.length === 1 ? "" : "s"}
        </span>
        {cableIds.length > 0 && (
          <button
            className="inline-flex items-center gap-1 text-primary hover:underline"
            onClick={() => onTrace(cableIds)}
          >
            <Waypoints className="size-3.5" /> Trace
          </button>
        )}
      </div>
      <Button size="sm" variant="outline" asChild className="h-7">
        <Link to="/devices/$id" params={{ id: d.id }}>
          Open device →
        </Link>
      </Button>
    </div>
  )
}

function MarkerPopover({
  marker: m,
  fields,
  onClose,
}: {
  marker: SiteMapMarker
  /** Shared floor-plan popover config — a marker linked to a device shows the
   * same device details a device pin does. */
  fields?: string[]
  onClose: () => void
}) {
  return (
    <div className="grid gap-2">
      <PopHeader
        title={m.label || m.device?.name || m.type?.name || "Marker"}
        onClose={onClose}
      />
      {m.type && (
        <div className="flex flex-wrap items-center gap-1.5">
          <ColorBadge name={m.type.name} color={m.type.color || undefined} />
        </div>
      )}
      {m.description && (
        <p className="text-[12px] text-muted-foreground">{m.description}</p>
      )}
      {m.device && <DeviceDetails device={m.device} fields={fields} />}
      {m.device && (
        <Button size="sm" variant="outline" asChild className="h-7">
          <Link to="/devices/$id" params={{ id: m.device.id }}>
            Open {m.device.name} →
          </Link>
        </Button>
      )}
    </div>
  )
}

function ConnectionPopover({
  edge: e,
  onClose,
}: {
  edge: SiteMapConnection
  onClose: () => void
}) {
  const rawId = e.id.split(":")[1]
  const detail =
    e.kind === "circuit"
      ? `/circuits/${rawId}`
      : e.kind === "tunnel"
        ? `/tunnels/${rawId}`
        : null
  const meta = e.meta as Record<string, unknown>
  return (
    <div className="grid gap-2">
      <PopHeader title={e.name} mono={e.kind === "circuit"} onClose={onClose} />
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline" className="uppercase">
          {e.kind}
        </Badge>
        {e.status && (
          <ColorBadge
            name={e.status.name}
            color={e.status.color || undefined}
          />
        )}
      </div>
      <div className="text-[12px] text-muted-foreground">
        <Link
          to="/sites/$id"
          params={{ id: e.site_a.id }}
          className="hover:underline"
        >
          {e.site_a.name}
        </Link>
        {" ↔ "}
        <Link
          to="/sites/$id"
          params={{ id: e.site_z.id }}
          className="hover:underline"
        >
          {e.site_z.name}
        </Link>
      </div>
      {e.kind === "circuit" && (
        <div className="grid gap-0.5 text-[12px] text-muted-foreground">
          {meta.provider ? (
            <span>Provider: {String(meta.provider)}</span>
          ) : null}
          {meta.type ? <span>Type: {String(meta.type)}</span> : null}
          {meta.commit_rate_kbps ? (
            <span className="num">
              Commit: {Number(meta.commit_rate_kbps) / 1000} Mbps
            </span>
          ) : null}
        </div>
      )}
      {e.kind === "tunnel" && (
        <div className="grid gap-0.5 text-[12px] text-muted-foreground">
          {meta.encapsulation ? (
            <span className="font-mono">{String(meta.encapsulation)}</span>
          ) : null}
          {meta.group ? <span>Group: {String(meta.group)}</span> : null}
        </div>
      )}
      {e.kind === "cable" && (
        <div className="text-[12px] text-muted-foreground">
          {String(meta.count)} cable{Number(meta.count) === 1 ? "" : "s"}
        </div>
      )}
      {detail && (
        <Button size="sm" variant="outline" asChild className="h-7">
          <Link to={detail}>Open →</Link>
        </Button>
      )}
    </div>
  )
}

function MarkerDeviceLink({
  marker: m,
  onLink,
}: {
  marker: SiteMapMarker
  onLink: (deviceId: string | null) => void
}) {
  return (
    <div className="grid gap-1">
      <div className="text-[11px] tracking-[0.08em] text-muted-foreground uppercase">
        Linked device
      </div>
      {m.device ? (
        <div className="flex items-center gap-2">
          <Link
            to="/devices/$id"
            params={{ id: m.device.id }}
            className="flex-1 truncate font-mono text-[12px] text-primary hover:underline"
          >
            {m.device.name}
          </Link>
          <button
            className="text-[11px] text-destructive hover:underline"
            onClick={() => onLink(null)}
          >
            Unlink
          </button>
        </div>
      ) : (
        <DevicePicker value={null} onChange={(id) => id && onLink(id)} />
      )}
    </div>
  )
}
