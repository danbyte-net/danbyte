import { createFileRoute, Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import L from "leaflet"
import "leaflet/dist/leaflet.css"
import { toast } from "sonner"
import {
  Building2,
  Expand,
  MapPin,
  Maximize,
  PanelRight,
  Satellite,
  Search,
  Shrink,
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
import {
  DetailRowList,
  DeviceExtraRows,
  SiteDetailRows,
  type DetailRow,
} from "@/components/site-map/detail-rows"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { InfoTip } from "@/components/ui/info-tip"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FormCheckbox } from "@/components/forms"
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
import {
  buildConnectionsLayer,
  KIND_COLOR,
} from "@/components/site-map/connections-layer"
import { CHECK_COLOR } from "@/components/site-map/status-colors"
import { TileBadge } from "@/components/floorplan/tile-badge"
import {
  LABEL_ZOOM,
  markerZ,
  observeMapSize,
  setBaseLayer,
} from "@/components/site-map/map-core"
import {
  applyDensityScaling,
  createMarkerGroup,
  setStackingEnabled,
  stackingEnabled,
  tagMarker,
  zoomToRevealMarker,
} from "@/components/site-map/cluster"
import {
  deviceIcon,
  freeMarkerIcon,
  siteIcon,
} from "@/components/site-map/map-icons"
import { MapPaletteRail } from "@/components/site-map/palette-rail"
import { buildFovLayer, type FovSource } from "@/components/site-map/fov-layer"
import { useMe } from "@/lib/use-me"
import { cn } from "@/lib/utils"

// The geographic floor plan. Same shell as /floorplans/$id - h-14 header with
// View|Edit tabs + search + view tools, left palette rail in edit mode, the
// canvas replaced by a Leaflet map, right inspector when something is
// selected, and an "On this map" objects sidebar on the far right. Tiles come
// from the deployment's configured tile server (OSM + Esri World Imagery by
// default, per their usage policies: exact HTTPS URLs, visible attribution).

export const Route = createFileRoute("/site-map")({
  // ?focus=<deviceId> - arrive centered on a device (the "Show on site map"
  // quick button on device detail pages).
  // ?focus=<deviceId> · ?trace=<cableId> - arrive centered on a device, or
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
  const { canDo } = useMe()
  const canView = canDo("site", "view")
  const q = useQuery({
    queryKey: ["site-map"],
    queryFn: () => api<SiteMapPayload>("/api/site-map/"),
    enabled: canView,
  })
  if (!canView)
    return (
      <p className="p-6 text-sm text-muted-foreground">
        You don't have permission to view the site map.
      </p>
    )
  if (q.isLoading)
    return <p className="p-6 text-sm text-muted-foreground">Loading map…</p>
  if (q.isError) return <QueryError error={q.error} />
  return <MapBody data={q.data!} />
}

// ── the map ───────────────────────────────────────────────────────────────

type Placing =
  | { kind: "site"; id: string; name: string }
  | { kind: "device"; id: string; name: string }
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
  // Layer toggles survive the visit (per browser, like the other map prefs).
  type LayerToggles = {
    sites: boolean
    devices: boolean
    links: boolean
    /** Plain cables. Off = only circuits and tunnels draw between sites. */
    cables: boolean
    routes: boolean
    regions: boolean
  }
  const [layers, setLayers] = useState<LayerToggles>(() => {
    const all = {
      sites: true,
      devices: true,
      links: true,
      cables: true,
      routes: true,
      regions: true,
    }
    try {
      const stored = JSON.parse(
        localStorage.getItem("site-map:layers")!
      ) as Partial<LayerToggles>
      return { ...all, ...stored }
    } catch {
      return all
    }
  })
  useEffect(() => {
    localStorage.setItem("site-map:layers", JSON.stringify(layers))
  }, [layers])
  const [showFov, setShowFovState] = useState(
    () => localStorage.getItem("site-map:fov") !== "off"
  )
  const setShowFov = (v: boolean) => {
    localStorage.setItem("site-map:fov", v ? "on" : "off")
    setShowFovState(v)
  }
  // Labels: on = name chips appear once zoomed close enough (LABEL_ZOOM);
  // off = hover/selection only. Either way they never shingle at low zoom.
  const [showLabels, setShowLabelsState] = useState(
    () => localStorage.getItem("site-map:labels") !== "off"
  )
  const setShowLabels = (v: boolean) => {
    localStorage.setItem("site-map:labels", v ? "on" : "off")
    setShowLabelsState(v)
  }
  // Stacking: cluster colliding markers (default) or shrink them in place.
  const [stacking, setStackingState] = useState(stackingEnabled)
  const setStacking = (v: boolean) => {
    setStackingEnabled(v)
    setStackingState(v)
  }
  const modeCleanupRef = useRef<(() => void) | null>(null)
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
  // Fullscreen: the map wrapper alone (header/sidebars stay behind), so the
  // popovers/banners inside it keep working.
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  useEffect(() => {
    const onChange = () => setFullscreen(!!document.fullscreenElement)
    document.addEventListener("fullscreenchange", onChange)
    return () => document.removeEventListener("fullscreenchange", onChange)
  }, [])
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void wrapRef.current?.requestFullscreen()
  }
  const [legendOpen, setLegendOpen] = useState(
    () => localStorage.getItem("site-map:legend") === "open"
  )
  const toggleLegend = () =>
    setLegendOpen((v) => {
      localStorage.setItem("site-map:legend", v ? "closed" : "open")
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

  // Label declutter: pure CSS driven by container classes - no marker
  // rebuilds. Chips show at/above their zoom threshold (when Labels is on);
  // hover and selection always show regardless.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const el = map.getContainer()
    el.classList.add("sm-zl")
    const applyZoom = () => {
      const z = map.getZoom()
      el.classList.toggle("sm-zl-sites", showLabels && z >= LABEL_ZOOM.sites)
      el.classList.toggle(
        "sm-zl-devices",
        showLabels && z >= LABEL_ZOOM.devices
      )
    }
    applyZoom()
    map.on("zoomend", applyZoom)
    return () => {
      map.off("zoomend", applyZoom)
    }
  }, [showLabels, mapReady])

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
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  // Marker handles by "kind:id" - selection restyles exactly two markers via
  // these instead of rebuilding (and re-clustering) the whole group.
  const markerHandles = useRef(
    new Map<string, { m: L.Marker; apply: (sel: boolean) => void }>()
  )
  // True while a programmatic zoom (cluster reveal) is in flight - the
  // map-wide "any move clears the selection" rule must not eat it.
  const revealingRef = useRef(false)

  const placed = useMemo(
    () => data.sites.filter((s) => s.latitude !== null),
    [data.sites]
  )
  const canEditAny =
    data.sites.some((s) => s.can_edit) || canDo("device", "change")

  // Shared popover config - the SAME effective floorplan-popover settings the
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
          icon: string
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
        icon: r.icon,
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
  const regionsRef = useRef<L.Layer | null>(null)
  const draftRef = useRef<L.LayerGroup | null>(null)
  const reshapeRef = useRef<L.LayerGroup | null>(null)
  const drawnCablesRef = useRef<L.LayerGroup | null>(null)

  // Every cable with two placeable ends - drawn whether or not it's routed.
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
    L.control.scale({ imperial: false }).addTo(map)
    // Come back where you left off: the last view is remembered per browser.
    // Claiming the one-shot auto-fit keeps the marker draw from resetting it;
    // Fit to view is one click away when you do want everything.
    try {
      const v = JSON.parse(localStorage.getItem("site-map:view")!)
      if (Number.isFinite(v.lat) && Number.isFinite(v.lng) && v.z >= 1) {
        map.setView([v.lat, v.lng], v.z)
        ;(map as unknown as { _smFitted?: boolean })._smFitted = true
      }
    } catch {
      /* first visit - the marker draw fits to everything */
    }
    map.on("moveend zoomend", () => {
      const c = map.getCenter()
      localStorage.setItem(
        "site-map:view",
        JSON.stringify({
          lat: +c.lat.toFixed(5),
          lng: +c.lng.toFixed(5),
          z: map.getZoom(),
        })
      )
    })
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
        } else if (target.kind === "device") {
          moveDeviceRef.current.mutate({
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
    map.on("movestart zoomstart", () => {
      if (!revealingRef.current) setSelected(null)
    })
    mapRef.current = map
    setMapReady(true)

    // Detect CSP-blocked tiles for BOTH basemaps (street + satellite) - the
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
    const unobserve = observeMapSize(map, mapEl.current)
    return () => {
      unobserve()
      document.removeEventListener("securitypolicyviolation", onCspViolation)
      map.remove()
      mapRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Basemap - street tiles or satellite imagery, swapped in place.
  const baseRef = useRef<L.TileLayer | null>(null)
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    setTilesBlocked(false) // re-detect per basemap
    const cfg =
      basemap === "sat"
        ? data.tiles.satellite
        : { url: data.tiles.url, attribution: data.tiles.attribution }
    setBaseLayer(map, baseRef, {
      url: cfg.url,
      attribution: cfg.attribution,
      // Satellite imagery escapes the dark-mode tile filter.
      className: basemap === "sat" ? "" : "sm-tiles",
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    basemap,
    data.tiles.url,
    data.tiles.attribution,
    data.tiles.satellite.url,
    data.tiles.satellite.attribution,
  ])

  // Region boundaries - OSM-sourced polygons shaded under everything else.
  // Non-interactive so clicks fall through to markers and the map itself;
  // SVG attributes can't resolve CSS vars, so the no-color fallback is a
  // literal muted zinc (same constraint as the cluster spider legs).
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    regionsRef.current?.remove()
    regionsRef.current = null
    const regions = data.regions ?? []
    if (!layers.regions || regions.length === 0) return
    const group = L.layerGroup()
    for (const r of regions) {
      const color = r.color || "#71717a"
      L.geoJSON(r.boundary as unknown as GeoJSON.GeoJsonObject, {
        interactive: false,
        style: {
          color,
          weight: 1.5,
          opacity: 0.55,
          fillColor: color,
          fillOpacity: 0.08,
        },
      }).addTo(group)
    }
    group.addTo(map)
    regionsRef.current = group
  }, [data.regions, layers.regions, mapReady])

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
  // the "routes" layer hides the routed geometry but not the raw cables - so
  // cabling is always visible.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    drawnCablesRef.current?.remove()
    if (!layers.cables || drawnCables.length === 0) return
    const layer = buildDrawnCablesLayer(drawnCables, {
      highlightIds: highlightCableIds,
      onSelect: (id) => {
        setHighlightCableIds((prev) =>
          prev.size === 1 && prev.has(id) ? new Set() : new Set([id])
        )
        setSelected((prev) =>
          prev?.kind === "cable" && prev.id === id
            ? null
            : { kind: "cable", id }
        )
      },
    })
    layer.addTo(map)
    drawnCablesRef.current = layer
  }, [drawnCables, highlightCableIds, layers.cables])

  // Arriving with ?trace=<cableId>: highlight the cable and fit the view -
  // once, when the data lands.
  const tracedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!trace || tracedRef.current === trace) return
    const rc = drawnCables.find((c) => c.id === trace)
    if (!rc) return // cables still loading - effect re-runs
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

  // FOV cones - devices + free markers, live drafts overlaid.
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

  // (Re)draw markers whenever data / edit mode / layers change. Selection is
  // deliberately NOT a dependency: it restyles two markers via markerHandles
  // in its own effect, because rebuilding here would re-cluster the whole map
  // (a visible flash) on every click.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    markersRef.current?.remove()
    markerHandles.current.clear()
    // View mode clusters colliding markers; edit modes keep the flat group so
    // dragging and click-to-place work exactly as before.
    const group = createMarkerGroup({ cluster: mode === "view" && stacking })
    const sel = selectedRef.current

    if (layers.sites) {
      for (const s of placed) {
        const isSel = sel?.kind === "site" && sel.id === s.id
        const m = L.marker([s.latitude!, s.longitude!], {
          icon: siteIcon(s, { selected: isSel }),
          draggable: editing && s.can_edit,
          zIndexOffset: markerZ("site", s.check, isSel),
        })
        tagMarker(m, { kind: "site", check: s.check, color: s.color })
        m.on("dragend", () => {
          const p = m.getLatLng()
          moveSiteRef.current.mutate({ id: s.id, lat: p.lat, lng: p.lng })
        })
        m.on("click", (e: L.LeafletMouseEvent) => {
          L.DomEvent.stopPropagation(e)
          setSelected({ kind: "site", id: s.id })
        })
        markerHandles.current.set(`site:${s.id}`, {
          m,
          apply: (on) => {
            m.setIcon(siteIcon(s, { selected: on }))
            m.setZIndexOffset(markerZ("site", s.check, on))
          },
        })
        group.addLayer(m)
      }
    }
    if (layers.devices) {
      for (const d of data.devices) {
        const isSel = sel?.kind === "device" && sel.id === d.id
        const m = L.marker([d.latitude, d.longitude], {
          icon: deviceIcon(d, { selected: isSel }),
          draggable: editing && d.can_edit,
          zIndexOffset: markerZ("device", d.check, isSel),
        })
        tagMarker(m, { kind: "device", check: d.check })
        m.on("dragend", () => {
          const p = m.getLatLng()
          moveDeviceRef.current.mutate({ id: d.id, lat: p.lat, lng: p.lng })
        })
        m.on("click", (e: L.LeafletMouseEvent) => {
          L.DomEvent.stopPropagation(e)
          setSelected({ kind: "device", id: d.id })
        })
        markerHandles.current.set(`device:${d.id}`, {
          m,
          apply: (on) => {
            m.setIcon(deviceIcon(d, { selected: on }))
            m.setZIndexOffset(markerZ("device", d.check, on))
          },
        })
        group.addLayer(m)
      }
    }
    for (const mk of data.markers) {
      const isSel = sel?.kind === "marker" && sel.id === mk.id
      const m = L.marker([mk.latitude, mk.longitude], {
        icon: freeMarkerIcon(mk, { selected: isSel }),
        draggable: editing,
        zIndexOffset: markerZ("marker", null, isSel),
      })
      tagMarker(m, { kind: "marker", check: null })
      m.on("dragend", () => {
        const p = m.getLatLng()
        moveMarker.mutate({ id: mk.id, lat: p.lat, lng: p.lng })
      })
      m.on("click", (e: L.LeafletMouseEvent) => {
        L.DomEvent.stopPropagation(e)
        setSelected({ kind: "marker", id: mk.id })
      })
      markerHandles.current.set(`marker:${mk.id}`, {
        m,
        apply: (on) => {
          m.setIcon(freeMarkerIcon(mk, { selected: on }))
          m.setZIndexOffset(markerZ("marker", null, on))
        },
      })
      group.addLayer(m)
    }

    group.addTo(map)
    markersRef.current = group
    // Unstacked view mode: crowded markers shrink instead of clustering.
    modeCleanupRef.current?.()
    modeCleanupRef.current = null
    if (mode === "view" && !stacking) {
      const ms: L.Marker[] = []
      group.eachLayer((l) => {
        if (l instanceof L.Marker) ms.push(l)
      })
      modeCleanupRef.current = applyDensityScaling(map, ms)
    }

    if (!(map as unknown as { _smFitted?: boolean })._smFitted) {
      fitAll(map)
      ;(map as unknown as { _smFitted?: boolean })._smFitted = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, editing, mode, placed, layers, stacking])

  // Selection restyle + reveal: touch exactly the old and new selected
  // markers, and when the new one sits inside a cluster, zoom/spiderfy until
  // it's actually visible (deep links, search, sidebar picks).
  const prevSelKey = useRef<string | null>(null)
  useEffect(() => {
    const key = selected ? `${selected.kind}:${selected.id}` : null
    if (prevSelKey.current && prevSelKey.current !== key)
      markerHandles.current.get(prevSelKey.current)?.apply(false)
    if (key) {
      const h = markerHandles.current.get(key)
      h?.apply(true)
      const el = h && (h.m as unknown as { _icon?: HTMLElement })._icon
      if (h && !el && markersRef.current) {
        revealingRef.current = true
        zoomToRevealMarker(markersRef.current, h.m, () => {
          revealingRef.current = false
        })
      }
    }
    prevSelKey.current = key
  }, [selected])

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
  const selCable =
    selected?.kind === "cable"
      ? ((cablesQuery.data?.cables ?? []).find((c) => c.id === selected.id) ??
        null)
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
    if (!map || (!target && !selConn && !selCable)) {
      setPopPos(null)
      return
    }
    const cablePath = selCable
      ? (drawnCables.find((c) => c.id === selCable.id)?.path ?? null)
      : null
    const ll: [number, number] = target
      ? [Number(target.latitude), Number(target.longitude)]
      : selConn
        ? (midpointsRef.current.get(selConn.id) ?? [0, 0])
        : (cablePath?.[Math.floor(cablePath.length / 2)] ?? [0, 0])
    const update = () => {
      const p = map.latLngToContainerPoint(ll)
      setPopPos({ x: p.x, y: p.y })
    }
    update()
    map.on("move zoom", update)
    return () => {
      map.off("move zoom", update)
    }
  }, [selSite, selDevice, selMarker, selConn, selCable, drawnCables])

  const removeFromMap = (d: SiteMapDevice) => {
    moveDevice.mutate({ id: d.id, lat: null, lng: null })
    setSelected(null)
  }
  const flyTo = (lat: number, lng: number) => {
    const map = mapRef.current
    if (map) map.flyTo([lat, lng], Math.max(map.getZoom(), 12))
  }

  // Everything on the map that's currently down or degraded - the pill in the
  // corner steps through them, worst first, so triage is click-click-click.
  const problems = useMemo(() => {
    const list: {
      kind: "site" | "device"
      id: string
      check: string
      lat: number
      lng: number
    }[] = []
    for (const s of placed)
      if (s.check === "down" || s.check === "degraded")
        list.push({
          kind: "site",
          id: s.id,
          check: s.check,
          lat: s.latitude!,
          lng: s.longitude!,
        })
    for (const d of data.devices)
      if (d.check === "down" || d.check === "degraded")
        list.push({
          kind: "device",
          id: d.id,
          check: d.check,
          lat: d.latitude,
          lng: d.longitude,
        })
    return list.sort((a, b) =>
      a.check === b.check ? 0 : a.check === "down" ? -1 : 1
    )
  }, [placed, data.devices])
  const problemIdx = useRef<Record<string, number>>({})
  const nextProblem = (check: "down" | "degraded") => {
    const list = problems.filter((p) => p.check === check)
    if (list.length === 0) return
    const i = problemIdx.current[check] ?? 0
    const p = list[i % list.length]
    problemIdx.current[check] = i + 1
    flyTo(p.lat, p.lng)
    setSelected({ kind: p.kind, id: p.id })
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
  // you select a camera you can change - not only in Edit mode.
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
            onClick={toggleFullscreen}
            title={fullscreen ? "Exit fullscreen" : "Fullscreen map"}
          >
            {fullscreen ? (
              <Shrink className="h-3.5 w-3.5" />
            ) : (
              <Expand className="h-3.5 w-3.5" />
            )}
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
              <FormCheckbox
                label="Sites"
                checked={layers.sites}
                onChange={(v) => setLayers((l) => ({ ...l, sites: v }))}
                className="items-center rounded px-2 py-1.5 text-[13px] hover:bg-muted/60"
              />
              <FormCheckbox
                label="Devices"
                checked={layers.devices}
                onChange={(v) => setLayers((l) => ({ ...l, devices: v }))}
                className="items-center rounded px-2 py-1.5 text-[13px] hover:bg-muted/60"
              />
              <FormCheckbox
                label="Links (circuits · tunnels)"
                checked={layers.links}
                onChange={(v) => setLayers((l) => ({ ...l, links: v }))}
                className="items-center rounded px-2 py-1.5 text-[13px] hover:bg-muted/60"
              />
              <FormCheckbox
                label="Cables"
                checked={layers.cables}
                onChange={(v) => setLayers((l) => ({ ...l, cables: v }))}
                className="items-center rounded px-2 py-1.5 text-[13px] hover:bg-muted/60"
              />
              <FormCheckbox
                label="Cable routes"
                checked={layers.routes}
                onChange={(v) => setLayers((l) => ({ ...l, routes: v }))}
                className="items-center rounded px-2 py-1.5 text-[13px] hover:bg-muted/60"
              />
              <FormCheckbox
                label="Stack nearby markers"
                checked={stacking}
                onChange={setStacking}
                className="items-center rounded px-2 py-1.5 text-[13px] hover:bg-muted/60"
              />
              <FormCheckbox
                label="Region boundaries"
                checked={layers.regions}
                onChange={(v) => setLayers((l) => ({ ...l, regions: v }))}
                className="items-center rounded px-2 py-1.5 text-[13px] hover:bg-muted/60"
              />
              <div className="my-1 h-px bg-border" />
              <FormCheckbox
                label="Camera FOV cones"
                checked={showFov}
                onChange={setShowFov}
                className="items-center rounded px-2 py-1.5 text-[13px] hover:bg-muted/60"
              />
              <FormCheckbox
                label={
                  <span className="flex items-center gap-1">
                    Labels
                    <InfoTip>
                      On: name chips appear as you zoom in. Off: names only on
                      hover or selection.
                    </InfoTip>
                  </span>
                }
                checked={showLabels}
                onChange={setShowLabels}
                className="items-center rounded px-2 py-1.5 text-[13px] hover:bg-muted/60"
              />
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
            onArmDevice={(id, name) => setPlacing({ kind: "device", id, name })}
          />
        )}

        <div ref={wrapRef} className="relative isolate z-0 min-w-0 flex-1">
          <div ref={mapEl} className="absolute inset-0" />

          {problems.length > 0 && mode === "view" && (
            // Two separate Badge-primitive chips (never a pill) on a solid
            // backdrop so the tints read over tiles; each steps through its
            // own severity.
            // left-14 clears Leaflet's zoom control in the corner.
            <div className="absolute top-3 left-14 z-[900] flex items-center gap-1 rounded-md border border-border bg-background/95 p-1 shadow-sm backdrop-blur">
              {problems.some((p) => p.check === "down") && (
                <Badge variant="destructive" asChild>
                  <button
                    onClick={() => nextProblem("down")}
                    title="Step through what's down"
                  >
                    <span className="num">
                      {problems.filter((p) => p.check === "down").length}
                    </span>{" "}
                    down
                  </button>
                </Badge>
              )}
              {problems.some((p) => p.check === "degraded") && (
                <Badge variant="warning" asChild>
                  <button
                    onClick={() => nextProblem("degraded")}
                    title="Step through what's degraded"
                  >
                    <span className="num">
                      {problems.filter((p) => p.check === "degraded").length}
                    </span>{" "}
                    degraded
                  </button>
                </Badge>
              )}
            </div>
          )}

          <MapLegend open={legendOpen} onToggle={toggleLegend} />

          {mode === "view" &&
            placed.length === 0 &&
            data.devices.length === 0 &&
            data.markers.length === 0 && (
              <div className="pointer-events-none absolute inset-0 z-[900] flex items-center justify-center">
                <div className="pointer-events-auto flex flex-col items-center gap-2 rounded-lg border border-border bg-background/95 px-6 py-5 text-center shadow-sm backdrop-blur">
                  <MapPin className="size-5 text-muted-foreground" />
                  <p className="text-sm font-medium">Nothing placed yet</p>
                  <p className="max-w-64 text-[12px] text-muted-foreground">
                    Drop your sites on the map, or type coordinates into the
                    site form.
                  </p>
                  {canEditAny && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-1"
                      onClick={() => setMode("layout")}
                    >
                      Start placing
                    </Button>
                  )}
                </div>
              </div>
            )}

          {tilesBlocked && (
            <div className="absolute inset-x-0 top-3 z-[1000] mx-auto w-fit max-w-xl rounded-lg border border-amber-500/40 bg-background/95 px-4 py-3 text-[13px] shadow-sm backdrop-blur">
              <p className="font-medium">
                {basemap === "sat" ? "Satellite imagery is" : "Map tiles are"}{" "}
                blocked by this server's Content-Security-Policy.
              </p>
              <p className="mt-1 text-muted-foreground">
                The reverse proxy's <span className="font-mono">img-src</span>{" "}
                directive doesn't allow the tile server - see{" "}
                <a
                  href="/docs/features/site-map/"
                  target="_blank"
                  rel="noreferrer"
                  className="link"
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
                {placing.kind === "marker" && " - stays armed"} · Esc to cancel
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
          {popPos &&
            (selSite || selDevice || selMarker || selConn || selCable) && (
            <div
              className="absolute z-[900] max-h-[65vh] w-max max-w-[22rem] min-w-[15rem] -translate-x-1/2 overflow-y-auto rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg"
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
              {!selectedRoute && selCable && (
                <CablePopover
                  cable={selCable}
                  onClose={() => {
                    setSelected(null)
                    setHighlightCableIds(new Set())
                  }}
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
            regions={data.regions ?? []}
            onFocusRegion={(r) => {
              const map = mapRef.current
              if (!map) return
              const b = L.geoJSON(
                r.boundary as unknown as GeoJSON.GeoJsonObject
              ).getBounds()
              if (b.isValid()) map.fitBounds(b.pad(0.05))
            }}
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
 * optional - an unnamed marker displays its linked device's name, then the
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
            hint="Optional - defaults to the linked device's name"
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

/** Header search - jump to a site / device / marker, like the plan's search. */
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

function MapLegend({
  open,
  onToggle,
}: {
  open: boolean
  onToggle: () => void
}) {
  // Sits above the Leaflet scale control; collapsed it's just a pill.
  if (!open)
    return (
      <Badge
        variant="outline"
        asChild
        className="absolute bottom-9 left-3 z-[900] bg-background/95 shadow-sm backdrop-blur"
      >
        <button onClick={onToggle}>Legend</button>
      </Badge>
    )
  const line = (color: string, dashed = false) => (
    <span
      aria-hidden
      className="inline-block h-0 w-6 shrink-0"
      style={{
        borderTop: `2px ${dashed ? "dashed" : "solid"} ${color}`,
      }}
    />
  )
  return (
    <div className="absolute bottom-9 left-3 z-[900] w-fit rounded-lg border border-border bg-background/95 p-3 text-[11px] shadow-sm backdrop-blur">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-medium">Legend</span>
        <button
          onClick={onToggle}
          className="text-muted-foreground hover:text-foreground"
          aria-label="Close legend"
        >
          <X className="size-3" />
        </button>
      </div>
      <div className="grid gap-1.5 whitespace-nowrap text-muted-foreground">
        <span className="flex items-center gap-2">
          <span className="flex size-5 shrink-0 items-center justify-center rounded-full border-2 border-background bg-primary text-primary-foreground shadow-[0_0_0_1px_var(--border)]">
            <Building2 className="size-3" />
          </span>
          Site
        </span>
        <span className="flex items-center gap-2">
          <TileBadge color="#8b5cf6" />
          Device / marker
        </span>
        <span className="flex items-center gap-2">
          <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full border-2 border-primary bg-background px-1 text-[10px] font-semibold text-foreground shadow-[0_0_0_1px_var(--border)]">
            5
          </span>
          Cluster - click to zoom
        </span>
        <span className="flex items-center gap-2">
          <span className="flex shrink-0 items-center gap-1">
            {(["up", "degraded", "down"] as const).map((c) => (
              <span
                key={c}
                className="size-2 rounded-full"
                style={{ background: CHECK_COLOR[c] }}
              />
            ))}
          </span>
          Up · degraded · down
        </span>
        <span className="flex items-center gap-2">
          {line(KIND_COLOR.circuit)}
          Circuit
        </span>
        <span className="flex items-center gap-2">
          {line(KIND_COLOR.tunnel)}
          Tunnel
        </span>
        <span className="flex items-center gap-2">
          {line(KIND_COLOR.cable)}
          Cable
        </span>
        <span className="flex items-center gap-2">
          {line(KIND_COLOR.cable, true)}
          Cable without a drawn route
        </span>
      </div>
    </div>
  )
}

function PopHeader({
  title,
  mono,
  dot,
  onClose,
}: {
  title: string
  mono?: boolean
  /** Identity colour (site colour, role colour, marker-type colour) - a 10px
   * dot before the name, same colour the marker itself wears. */
  dot?: string
  onClose: () => void
}) {
  return (
    <div className="flex items-start justify-between gap-2">
      <span
        className={
          "flex min-w-0 items-center gap-1.5 text-[13px] font-semibold " +
          (mono ? "font-mono" : "")
        }
      >
        {dot && (
          <span
            aria-hidden
            className="size-2.5 shrink-0 rounded-full border border-background shadow-[0_0_0_1px_var(--border)]"
            style={{ background: dot }}
          />
        )}
        <span className="truncate">{title}</span>
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
      <PopHeader
        title={s.name}
        dot={s.color || "var(--primary)"}
        onClose={onClose}
      />
      <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground">
        <span>
          {s.device_count} device{s.device_count === 1 ? "" : "s"}
          {s.floor_plan_count > 0 &&
            ` · ${s.floor_plan_count} floor plan${s.floor_plan_count === 1 ? "" : "s"}`}
        </span>
        {s.check && <CheckStatusBadge status={s.check as CheckStatus} />}
      </div>
      <SiteDetailRows site={s} />
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
): DetailRow | null {
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
              <Link to="/sites/$id" params={{ id: d.site.id }} className="link">
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
                className="link font-mono"
              >
                {d.primary_ip.ip_address}
              </Link>
            ),
            copy: d.primary_ip.ip_address,
          }
        : null
    case "linked_serial":
      return d.serial_number
        ? {
            label: "Serial",
            node: <span className="font-mono">{d.serial_number}</span>,
            copy: d.serial_number,
          }
        : null
    case "linked_asset_tag":
      return d.asset_tag
        ? {
            label: "Asset tag",
            node: <span className="font-mono">{d.asset_tag}</span>,
            copy: d.asset_tag,
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

const DEFAULT_DEVICE_KEYS = [
  "type",
  "linked_status",
  "linked_primary_ip",
  "linked_site",
]

// The device detail block (front image + the configured field rows), shared by
// a placed device pin and a marker linked to a device - so both show the same
// details the floor-plan popover config sets.
function DeviceDetails({
  device: d,
  fields,
}: {
  device: SiteMapDeviceInfo
  fields?: string[]
}) {
  const cfDefs = useCustomFieldDefs("device").data?.results
  const keys = fields ?? DEFAULT_DEVICE_KEYS
  const rows = keys
    .map((key) => ({ key, row: deviceFieldRow(key, d, cfDefs) }))
    .filter((r): r is { key: string; row: DetailRow } => !!r.row)
  return (
    <>
      {d.front_image && (
        <img
          src={d.front_image}
          alt={d.device_type ?? "device"}
          className="max-h-14 w-full rounded-md border border-border object-contain"
        />
      )}
      <DetailRowList rows={rows.map((r) => r.row)} />
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
      <PopHeader
        title={d.name}
        mono
        dot={d.role?.color || undefined}
        onClose={onClose}
      />
      <DeviceDetails device={d} fields={fields} />
      <DeviceExtraRows
        id={d.id}
        shownKeys={fields ?? DEFAULT_DEVICE_KEYS}
        lat={d.latitude}
        lng={d.longitude}
      />
      <div className="flex items-center justify-between text-[12px]">
        <span className="text-muted-foreground">
          <span className="num">{cableIds.length}</span> cable
          {cableIds.length === 1 ? "" : "s"}
        </span>
        {cableIds.length > 0 && (
          <button
            className="link inline-flex items-center gap-1"
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
  /** Shared floor-plan popover config - a marker linked to a device shows the
   * same device details a device pin does. */
  fields?: string[]
  onClose: () => void
}) {
  return (
    <div className="grid gap-2">
      <PopHeader
        title={m.label || m.device?.name || m.type?.name || "Marker"}
        dot={m.type?.color || undefined}
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
        <DeviceExtraRows
          id={m.device.id}
          shownKeys={fields ?? DEFAULT_DEVICE_KEYS}
        />
      )}
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

function CablePopover({
  cable: c,
  onClose,
}: {
  cable: SiteMapCable
  onClose: () => void
}) {
  return (
    <div className="grid gap-2">
      <PopHeader title={c.label || "Cable"} mono onClose={onClose} />
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline" className="uppercase">
          cable
        </Badge>
        {c.type && <Badge variant="outline">{c.type}</Badge>}
        {c.status && (
          <ColorBadge name={c.status.name} color={c.status.color || undefined} />
        )}
        {c.fiber_count ? (
          <Badge variant="outline" className="num">
            ×{c.fiber_count}
          </Badge>
        ) : null}
      </div>
      <div className="text-[12px] text-muted-foreground">
        <Link to="/devices/$id" params={{ id: c.a.device_id }} className="link">
          {c.a.device_name}
        </Link>
        <span className="font-mono">:{c.a.port}</span>
        {" ↔ "}
        <Link to="/devices/$id" params={{ id: c.z.device_id }} className="link">
          {c.z.device_name}
        </Link>
        <span className="font-mono">:{c.z.port}</span>
      </div>
      <Button size="sm" variant="outline" className="h-7 text-xs" asChild>
        <Link to="/cables/$id" params={{ id: c.id }}>
          Open cable
        </Link>
      </Button>
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
        <Link to="/sites/$id" params={{ id: e.site_a.id }} className="link">
          {e.site_a.name}
        </Link>
        {" ↔ "}
        <Link to="/sites/$id" params={{ id: e.site_z.id }} className="link">
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
            className="link flex-1 truncate font-mono text-[12px]"
          >
            {m.device.name}
          </Link>
          <button
            className="link text-[11px] text-destructive"
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
