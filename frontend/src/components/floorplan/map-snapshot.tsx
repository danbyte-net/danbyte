import { useEffect, useMemo, useRef, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import L from "leaflet"
import "leaflet/dist/leaflet.css"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { FloorPlan, SiteMapPayload } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { Field } from "@/components/forms"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { observeMapSize, setBaseLayer } from "@/components/site-map/map-core"
import { TileReadError } from "@/components/site-map/plan-from-map"
import type { Bbox } from "@/components/site-map/plan-from-map"

import { bboxOf, frameAt } from "./plan-geo"
import { renderPlanMap } from "./plan-map-dialogs"

// A floor's base map: a Site map snapshot under its floor drawing
// (api/floor_plan_layers.py). Rendered in the browser from the configured
// tile server - the server never fetches tiles - and uploaded to
// POST /api/floor-plans/<id>/map/.

export type Basemap = "map" | "sat"

export const BASEMAPS = [
  { value: "map" as const, label: "Map" },
  { value: "sat" as const, label: "Satellite" },
]

const FRAME = "#2563eb"

/** The site map's own query: tiles and the sites' positions. */
function useSiteMap(enabled: boolean) {
  return useQuery({
    queryKey: ["site-map"],
    queryFn: () => api<SiteMapPayload>("/api/site-map/"),
    enabled,
    staleTime: 60_000,
  })
}

/** Every query that draws a floor's background: this floor's and, as the
 * map is shared by a building's levels, the others'. */
export function useRefetchBackgrounds() {
  const qc = useQueryClient()
  return () => {
    for (const key of [
      ["floor-plan"],
      ["floor-plan-scene"],
      ["floor-plan-stack"],
      ["floor-plan-stacks"],
      ["floor-plans"],
      ["site-map"],
    ])
      void qc.invalidateQueries({ queryKey: key })
  }
}

/** Render `bbox` and send it as the plan's map. Throws TileReadError when
 * the tiles can't be read from this browser. */
export async function captureMap(
  plan: Pick<FloorPlan, "id">,
  tiles: SiteMapPayload["tiles"] | undefined,
  basemap: Basemap,
  bbox: Bbox,
  zoom: number,
  frame: boolean
) {
  const img = await renderPlanMap(tiles, basemap, bbox, zoom)
  const fd = new FormData()
  fd.append("basemap", basemap)
  fd.append("zoom", String(img.zoom))
  if (frame)
    fd.append(
      "bbox",
      JSON.stringify([bbox.south, bbox.west, bbox.north, bbox.east])
    )
  fd.append(
    "image",
    img.blob,
    basemap === "sat" ? "site-map.jpg" : "site-map.png"
  )
  return api<FloorPlan>(`/api/floor-plans/${plan.id}/map/`, {
    method: "POST",
    body: fd,
  })
}

/**
 * **From site map…**: pick Map or Satellite and frame the floor on a small
 * map. A plan tied to the map already (a geo anchor) shows its box; one
 * that is not is framed by a box of the grid's real size - its cells at
 * their cell size - that stays in the middle while the map is dragged
 * under it.
 */
export function MapSnapshotDialog({
  plan,
  open,
  onOpenChange,
}: {
  plan: FloorPlan
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        {open && (
          <SnapshotForm plan={plan} onClose={() => onOpenChange(false)} />
        )}
      </DialogContent>
    </Dialog>
  )
}

function SnapshotForm({
  plan,
  onClose,
}: {
  plan: FloorPlan
  onClose: () => void
}) {
  const siteMap = useSiteMap(true)
  const tiles = siteMap.data?.tiles
  const refetch = useRefetchBackgrounds()
  const [basemap, setBasemap] = useState<Basemap>(
    plan.geo?.basemap ?? plan.base_map?.basemap ?? "map"
  )
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const anchored = !!plan.geo
  const widthM = (plan.grid_width * plan.cell_mm) / 1000
  const heightM = (plan.grid_height * plan.cell_mm) / 1000
  // Start on the plan's box, else its site, else any site with a position
  // (a site not placed on the map yet).
  const sites = siteMap.data?.sites
  const site =
    sites?.find((s) => s.id === plan.site.id && s.latitude != null) ??
    sites?.find((s) => s.latitude != null && s.longitude != null)
  const start = useMemo(() => {
    if (plan.geo) {
      const b = bboxOf(plan.geo)
      return { lat: (b.north + b.south) / 2, lng: (b.west + b.east) / 2 }
    }
    if (site?.latitude != null && site.longitude != null)
      return { lat: site.latitude, lng: site.longitude }
    return null
  }, [plan.geo, site?.latitude, site?.longitude])
  const [center, setCenter] = useState<{ lat: number; lng: number } | null>(
    null
  )
  const [zoom, setZoom] = useState(plan.geo?.zoom ?? 18)
  const at = center ?? start
  const bbox: Bbox | null = plan.geo
    ? bboxOf(plan.geo)
    : at
      ? frameAt(at, widthM, heightM)
      : null

  const capture = async () => {
    if (!bbox) return
    setBusy(true)
    try {
      // The deepest tiles: a floor is a building, not a campus (the render
      // steps down when the box needs more pixels than it allows).
      await captureMap(
        plan,
        tiles,
        basemap,
        bbox,
        Math.max(zoom, 19),
        !anchored
      )
      refetch()
      toast.success("Map captured")
      onClose()
    } catch (e) {
      if (e instanceof TileReadError) setFailed(true)
      else apiErrorToast(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>From site map</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <Field label="Basemap">
          <SegmentedTabs<Basemap>
            value={basemap}
            onValueChange={(v) => {
              setBasemap(v)
              setFailed(false)
            }}
            items={BASEMAPS}
          />
        </Field>
        {siteMap.isLoading ? null : start && tiles ? (
          <FrameMap
            start={start}
            startZoom={plan.geo?.zoom ?? 18}
            bbox={bbox}
            fixed={anchored}
            tiles={tiles}
            basemap={basemap}
            onMove={(c, z) => {
              setCenter(c)
              setZoom(z)
            }}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            {tiles ? "No site has a position on the map." : "No map tiles."}
          </p>
        )}
        <p className="text-xs text-muted-foreground" data-testid="frame-size">
          <span className="num">
            {plan.grid_width} × {plan.grid_height}
          </span>{" "}
          cells ·{" "}
          <span className="num">
            {+widthM.toFixed(1)} × {+heightM.toFixed(1)} m
          </span>
        </p>
        {failed && (
          <div
            role="alert"
            className="rounded-md border border-border bg-muted/40 p-3 text-sm"
          >
            The map tiles can&apos;t be read from this browser.
          </div>
        )}
      </div>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="button"
          disabled={busy || !bbox || !tiles}
          onClick={() => void capture()}
        >
          {busy ? "Capturing…" : "Capture"}
        </Button>
      </DialogFooter>
    </>
  )
}

/** The small framing map: the frame drawn over it, fixed to the plan's
 * box when it has one, else kept in the middle as the map moves. */
function FrameMap({
  start,
  startZoom,
  bbox,
  fixed,
  tiles,
  basemap,
  onMove,
}: {
  start: { lat: number; lng: number }
  startZoom: number
  bbox: Bbox | null
  fixed: boolean
  tiles: SiteMapPayload["tiles"]
  basemap: Basemap
  onMove: (center: { lat: number; lng: number }, zoom: number) => void
}) {
  const el = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<L.Map | null>(null)
  const baseRef = useRef<L.TileLayer | null>(null)
  const rectRef = useRef<L.Rectangle | null>(null)
  const move = useRef(onMove)
  move.current = onMove

  useEffect(() => {
    if (!el.current || mapRef.current) return
    const map = L.map(el.current, {
      zoomControl: true,
      attributionControl: true,
    })
    map.setView([start.lat, start.lng], Math.min(19, startZoom))
    if (fixed && bbox)
      map.fitBounds(
        [
          [bbox.south, bbox.west],
          [bbox.north, bbox.east],
        ],
        { padding: [32, 32] }
      )
    const report = () => {
      const c = map.getCenter()
      move.current({ lat: c.lat, lng: c.lng }, Math.round(map.getZoom()))
    }
    map.on("move zoomend", report)
    report()
    mapRef.current = map
    const unobserve = observeMapSize(map, el.current)
    return () => {
      unobserve()
      map.remove()
      mapRef.current = null
    }
  }, [])

  const url = basemap === "sat" ? tiles.satellite.url : tiles.url
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    setBaseLayer(map, baseRef, {
      url,
      attribution:
        basemap === "sat" ? tiles.satellite.attribution : tiles.attribution,
      className: basemap === "sat" ? "" : undefined,
    })
  }, [url, basemap, tiles])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !bbox) return
    const bounds: L.LatLngBoundsExpression = [
      [bbox.south, bbox.west],
      [bbox.north, bbox.east],
    ]
    if (rectRef.current) rectRef.current.setBounds(bounds)
    else
      rectRef.current = L.rectangle(bounds, {
        color: FRAME,
        weight: 2,
        fillOpacity: 0.06,
        interactive: false,
      }).addTo(map)
  }, [bbox])

  return (
    <div
      ref={el}
      className="h-72 w-full overflow-hidden rounded-md border border-border"
      data-testid="frame-map"
    />
  )
}
