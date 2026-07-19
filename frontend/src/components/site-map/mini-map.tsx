import { useEffect, useMemo, useRef } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import L from "leaflet"
import "leaflet/dist/leaflet.css"

import { TileBadge } from "@/components/floorplan/tile-badge"

import {
  api,
  type CableRoute,
  type Paginated,
  type SiteMapCable,
  type SiteMapConnection,
  type SiteMapPayload,
} from "@/lib/api"
import { buildConnectionsLayer } from "@/components/site-map/connections-layer"
import {
  buildDrawnCables,
  buildDrawnCablesLayer,
} from "@/components/site-map/cable-geo-route"
import { cn } from "@/lib/utils"

// A read-only OSM mini-map: real tiles, your sites/devices as dots, cables +
// connection arcs drawn like the full Site map. Reused by the dashboard
// widget, the circuits strip, the site locator, and device pages. Clicking a
// site or device navigates to it; the surrounding card carries the "open the
// full map" affordance.

const HEALTH: Record<string, string> = {
  up: "#10b981",
  degraded: "#f59e0b",
  down: "#ef4444",
  stale: "#a1a1aa",
  unknown: "#a1a1aa",
}

export function MiniMap({
  highlightSiteId,
  onlyConnectionsOf,
  focusDeviceId,
  className,
}: {
  /** Emphasize + fit to one site (locator on site detail pages). */
  highlightSiteId?: string
  /** Limit arcs/cables to those touching this site id. */
  onlyConnectionsOf?: string
  /** Center + fit to one device (device detail pages). */
  focusDeviceId?: string
  className?: string
}) {
  const nav = useNavigate()
  const el = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<L.Map | null>(null)
  const layersRef = useRef<L.LayerGroup | null>(null)

  const mapQ = useQuery({
    queryKey: ["site-map"],
    queryFn: () => api<SiteMapPayload>("/api/site-map/"),
    staleTime: 60_000,
  })
  const connQ = useQuery({
    queryKey: ["site-map-connections"],
    queryFn: () =>
      api<{ connections: SiteMapConnection[] }>("/api/site-map/connections/"),
    staleTime: 60_000,
  })
  const cablesQ = useQuery({
    queryKey: ["site-map-cables"],
    queryFn: () => api<{ cables: SiteMapCable[] }>("/api/site-map/cables/"),
    staleTime: 60_000,
  })
  const routesQ = useQuery({
    queryKey: ["cable-routes"],
    queryFn: () =>
      api<Paginated<CableRoute>>("/api/cable-routes/?page_size=500"),
    staleTime: 60_000,
  })

  const data = mapQ.data
  const drawnCables = useMemo(
    () =>
      buildDrawnCables(cablesQ.data?.cables ?? [], routesQ.data?.results ?? []),
    [cablesQ.data, routesQ.data]
  )

  // Create the map once.
  useEffect(() => {
    if (!el.current || mapRef.current) return
    const map = L.map(el.current, {
      zoomControl: false,
      attributionControl: true,
      worldCopyJump: true,
    })
    map.setView([30, 10], 2)
    mapRef.current = map
    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [])

  // Tiles (from the deployment config, same as the full map).
  useEffect(() => {
    const map = mapRef.current
    if (!map || !data) return
    L.tileLayer(data.tiles.url, {
      attribution: data.tiles.attribution,
      maxZoom: 19,
      className: "sm-tiles",
      referrerPolicy: "strict-origin-when-cross-origin",
    }).addTo(map)
  }, [data])

  // Draw everything + fit.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !data) return
    layersRef.current?.remove()
    const group = L.layerGroup()

    const placedSites = data.sites.filter((s) => s.latitude !== null)
    const sitesToShow = onlyConnectionsOf
      ? placedSites.filter((s) => s.id === onlyConnectionsOf)
      : placedSites

    // connection arcs
    let conns = connQ.data?.connections ?? []
    if (onlyConnectionsOf)
      conns = conns.filter(
        (c) =>
          c.site_a.id === onlyConnectionsOf || c.site_z.id === onlyConnectionsOf
      )
    buildConnectionsLayer(conns, () => {}).group.eachLayer((l) =>
      group.addLayer(l)
    )

    // cables (dashed/solid), un-highlighted
    buildDrawnCablesLayer(drawnCables, {
      highlightIds: new Set<string>(),
    }).eachLayer((l) => group.addLayer(l))

    const bounds: [number, number][] = []

    for (const s of sitesToShow) {
      const hl = s.id === highlightSiteId
      const m = L.circleMarker([s.latitude!, s.longitude!], {
        radius: hl ? 7 : 5,
        color: "#fff",
        weight: 1.5,
        fillColor: HEALTH[s.check ?? "unknown"] ?? "#0ea5e9",
        fillOpacity: 1,
      })
      m.bindTooltip(s.name, { direction: "top" })
      m.on("click", () => nav({ to: "/sites/$id", params: { id: s.id } }))
      group.addLayer(m)
      bounds.push([s.latitude!, s.longitude!])
    }

    for (const d of data.devices) {
      const focused = d.id === focusDeviceId
      // Same floor-planner badge square as the full map; the focused device
      // gets the primary ring (via sm-sel) so it's obvious which one this is.
      const badge = renderToStaticMarkup(<TileBadge color={d.role?.color} />)
      const m = L.marker([d.latitude, d.longitude], {
        icon: L.divIcon({
          className: "sm-marker" + (focused ? " sm-sel" : ""),
          html: `<span class="sm-badge">${badge}</span>`,
          iconAnchor: [12, 12],
        }),
        zIndexOffset: focused ? 200 : 0,
      })
      m.bindTooltip(d.name, { direction: "top" })
      m.on("click", () => nav({ to: "/devices/$id", params: { id: d.id } }))
      group.addLayer(m)
      if (focusDeviceId ? focused : true) bounds.push([d.latitude, d.longitude])
    }

    group.addTo(map)
    layersRef.current = group

    // Fit — to the focused device, the located site + its arcs, or everything.
    if (focusDeviceId) {
      const d = data.devices.find((x) => x.id === focusDeviceId)
      if (d) map.setView([d.latitude, d.longitude], 15)
    } else if (bounds.length === 1) {
      map.setView(bounds[0], 13)
    } else if (bounds.length > 1) {
      map.fitBounds(L.latLngBounds(bounds).pad(0.3), { maxZoom: 15 })
    }
    // A tick later, in case the container just became visible.
    setTimeout(() => map.invalidateSize(), 100)
  }, [
    data,
    connQ.data,
    drawnCables,
    highlightSiteId,
    onlyConnectionsOf,
    focusDeviceId,
    nav,
  ])

  const nonesPlaced =
    data &&
    data.sites.every((s) => s.latitude === null) &&
    data.devices.length === 0

  return (
    <div className={cn("relative", className)}>
      <div ref={el} className="absolute inset-0" />
      {mapQ.isLoading && (
        <div className="absolute inset-0 animate-pulse bg-muted/30" />
      )}
      {nonesPlaced && (
        <div className="absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-muted-foreground">
          Nothing placed yet — open the Site map and drop your first site.
        </div>
      )}
    </div>
  )
}
