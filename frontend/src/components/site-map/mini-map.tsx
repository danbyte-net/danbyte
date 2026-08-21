import { useEffect, useMemo, useRef } from "react"
import { useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import L from "leaflet"
import "leaflet/dist/leaflet.css"

import {
  api,
  type CableRoute,
  type GeoBoundary,
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
import {
  markerZ,
  observeMapSize,
  setBaseLayer,
} from "@/components/site-map/map-core"
import {
  createMarkerGroup,
  tagMarker,
  zoomToRevealMarker,
} from "@/components/site-map/cluster"
import { deviceIcon, siteIcon } from "@/components/site-map/map-icons"
import { cn } from "@/lib/utils"

// A read-only OSM mini-map: real tiles, your sites/devices as the full map's
// pins (mini variant), cables + connection arcs drawn like the full Site map.
// Reused by the dashboard widget, the circuits strip, the site locator, and
// device pages. Clicking a site or device navigates to it; the surrounding
// card carries the "open the full map" affordance.

export function MiniMap({
  highlightSiteId,
  onlyConnectionsOf,
  focusDeviceId,
  boundary,
  className,
}: {
  /** Emphasize + fit to one site (locator on site detail pages). */
  highlightSiteId?: string
  /** Limit arcs/cables to those touching this site id. */
  onlyConnectionsOf?: string
  /** Center + fit to one device (device detail pages). */
  focusDeviceId?: string
  /** Shade + fit to a region's OSM boundary (region detail pages). */
  boundary?: { geometry: GeoBoundary; color: string } | null
  className?: string
}) {
  const nav = useNavigate()
  const el = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<L.Map | null>(null)
  const layersRef = useRef<L.LayerGroup | null>(null)
  const boundaryRef = useRef<L.GeoJSON | null>(null)

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
    // Dashboard tiles resize under the grid's hands - keep Leaflet current.
    const unobserve = observeMapSize(map, el.current)
    return () => {
      unobserve()
      map.remove()
      mapRef.current = null
    }
  }, [])

  // Tiles (from the deployment config, same as the full map). setBaseLayer
  // swaps in place - keyed on the URL, not the payload object, so a refetch
  // doesn't stack another tile layer + attribution line.
  const baseRef = useRef<L.TileLayer | null>(null)
  const tileUrl = data?.tiles.url
  const tileAttribution = data?.tiles.attribution
  useEffect(() => {
    const map = mapRef.current
    if (!map || !tileUrl) return
    setBaseLayer(map, baseRef, {
      url: tileUrl,
      attribution: tileAttribution ?? "",
    })
  }, [tileUrl, tileAttribution])

  // Draw everything + fit.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !data) return
    layersRef.current?.remove()
    // Clustered like the full map's view mode (the MiniMap is view-only);
    // polylines added below land in the plugin's non-point group untouched.
    const group = createMarkerGroup({ cluster: true, mini: true, radius: 40 })

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
      // The full map's site pin, mini variant: site colour + icon + health
      // dot. The highlighted site gets the primary ring via sm-sel.
      const m = L.marker([s.latitude!, s.longitude!], {
        icon: siteIcon(s, { selected: hl, mini: true }),
        zIndexOffset: markerZ("site", s.check, hl),
      })
      tagMarker(m, { kind: "site", check: s.check, color: s.color })
      m.bindTooltip(s.name, { direction: "top" })
      m.on("click", () => nav({ to: "/sites/$id", params: { id: s.id } }))
      group.addLayer(m)
      bounds.push([s.latitude!, s.longitude!])
    }

    let focusMarker: L.Marker | null = null
    for (const d of data.devices) {
      const focused = d.id === focusDeviceId
      // Same floor-planner badge square as the full map; the focused device
      // gets the primary ring (via sm-sel) so it's obvious which one this is.
      const m = L.marker([d.latitude, d.longitude], {
        icon: deviceIcon(d, { selected: focused, mini: true }),
        zIndexOffset: markerZ("device", d.check, focused),
      })
      tagMarker(m, { kind: "device", check: d.check })
      m.bindTooltip(d.name, { direction: "top" })
      m.on("click", () => nav({ to: "/devices/$id", params: { id: d.id } }))
      group.addLayer(m)
      if (focused) focusMarker = m
      if (focusDeviceId ? focused : true) bounds.push([d.latitude, d.longitude])
    }

    // Region boundary (region locator): shaded under the pins,
    // non-interactive so pin clicks still land. Added to the map directly -
    // a polygon has no business inside the marker clusterer.
    boundaryRef.current?.remove()
    boundaryRef.current = null
    let boundaryLayer: L.GeoJSON | null = null
    if (boundary) {
      const color = boundary.color || "#71717a"
      boundaryLayer = L.geoJSON(
        boundary.geometry as unknown as GeoJSON.GeoJsonObject,
        {
          interactive: false,
          style: {
            color,
            weight: 1.5,
            opacity: 0.55,
            fillColor: color,
            fillOpacity: 0.08,
          },
        }
      ).addTo(map)
      boundaryRef.current = boundaryLayer
    }

    group.addTo(map)
    layersRef.current = group

    // Fit - to the focused device, the boundary, the located site + its
    // arcs, or everything.
    if (focusDeviceId) {
      const d = data.devices.find((x) => x.id === focusDeviceId)
      if (d) map.setView([d.latitude, d.longitude], 15)
    } else if (boundaryLayer) {
      map.fitBounds(boundaryLayer.getBounds().pad(0.1), { maxZoom: 12 })
    } else if (bounds.length === 1) {
      map.setView(bounds[0], 13)
    } else if (bounds.length > 1) {
      map.fitBounds(L.latLngBounds(bounds).pad(0.3), { maxZoom: 15 })
    }
    // A tick later, in case the container just became visible. Then, if the
    // focused device sits inside a cluster (stacked coordinates), zoom or
    // spiderfy until its pin is actually the thing with the ring on it.
    const reveal = focusMarker
    setTimeout(() => {
      map.invalidateSize()
      if (reveal && !(reveal as unknown as { _icon?: HTMLElement })._icon)
        zoomToRevealMarker(group, reveal)
    }, 100)
  }, [
    data,
    connQ.data,
    drawnCables,
    highlightSiteId,
    onlyConnectionsOf,
    focusDeviceId,
    boundary,
    nav,
  ])

  const nonesPlaced =
    data &&
    !boundary &&
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
          Nothing placed yet - open the Site map and drop your first site.
        </div>
      )}
    </div>
  )
}
