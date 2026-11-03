import { useEffect, useMemo, useRef, useState } from "react"
import type { ReactNode } from "react"
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
import {
  mercX,
  mercY,
  metresPerPixel,
  TileReadError,
} from "@/components/site-map/plan-from-map"
import type { Bbox } from "@/components/site-map/plan-from-map"

import { frameLayer } from "./frame-layer"
import {
  bboxOf,
  centreInner,
  frameBbox,
  frameError,
  frameOffset,
  moveFrame,
  snapshotFrame,
} from "./plan-geo"
import type { CellFrame } from "./plan-geo"
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
      ["floor-plan-contents"],
      ["site-map"],
    ])
      void qc.invalidateQueries({ queryKey: key })
  }
}

/** A new frame: its size and the cells everything on the plan moves by
 * (the server resizes and re-anchors the grid to it). */
export interface GrowTo {
  grid: [number, number]
  offset: [number, number]
  version?: string
}

/** Render `bbox` and send it as the plan's map. `frame` sends the box (a
 * plan with no anchor yet); `grow` a new frame for the grid - larger,
 * smaller or elsewhere. Throws TileReadError when the tiles can't be read
 * from this browser. */
export async function captureMap(
  plan: Pick<FloorPlan, "id">,
  tiles: SiteMapPayload["tiles"] | undefined,
  basemap: Basemap,
  bbox: Bbox,
  zoom: number,
  frame: boolean,
  grow?: GrowTo
) {
  const img = await renderPlanMap(tiles, basemap, bbox, zoom)
  const fd = new FormData()
  fd.append("basemap", basemap)
  fd.append("zoom", String(img.zoom))
  if (frame || grow)
    fd.append(
      "bbox",
      JSON.stringify([bbox.south, bbox.west, bbox.north, bbox.east])
    )
  if (grow) {
    fd.append("grid", JSON.stringify(grow.grid))
    fd.append("offset", JSON.stringify(grow.offset))
    if (grow.version) fd.append("version", grow.version)
  }
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

/** "30 × 20 cells · 18 × 12 m" for a frame of cells of `cellMm`. */
export function frameReadout(w: number, h: number, cellMm: number) {
  const m = (n: number) => +((n * cellMm) / 1000).toFixed(1)
  return `${w} × ${h} cells · ${m(w)} × ${m(h)} m`
}

/** "≈ 0.16 m/px": the detail of the map rendered for `bbox`. */
export function detailReadout(mpp: number) {
  const v = mpp < 1 ? mpp.toFixed(2) : mpp.toFixed(1)
  return `≈ ${v} m/px`
}

/** What a new frame does to the grid, as the readout's verb. */
export function frameVerb(
  w: number,
  h: number,
  gw: number,
  gh: number
): "Grows" | "Shrinks" | "Resizes" | "Moves" {
  if (w === gw && h === gh) return "Moves"
  if (w >= gw && h >= gh) return "Grows"
  if (w <= gw && h <= gh) return "Shrinks"
  return "Resizes"
}

/** The old box's middle, kept after the map was removed: where the dialog
 * opens, never a lock. */
function lastCentre(plan: FloorPlan) {
  const fm = (plan.state as { from_map?: { bbox?: unknown } } | undefined)
    ?.from_map
  const b = fm?.bbox
  if (!Array.isArray(b) || b.length !== 4 || !b.every(Number.isFinite))
    return null
  const [s, w, n, e] = b as number[]
  return { lat: (s + n) / 2, lng: (w + e) / 2 }
}

/**
 * **From site map…**: pick Map or Satellite and frame the floor on a small
 * map. The frame starts at the grid's real size - its cells at their cell
 * size - on the plan's box when it has one; what is drawn on the plan (and
 * the levels that go with it) shows dashed inside it. The frame is free:
 * its handles grow or shrink it in whole cells (never cutting the dashed
 * box), dragging it moves it - the plan is anchored where it is dropped -
 * and dragging the dashed box places the contents in it. Capture resizes
 * and re-anchors the grid, everything on it moving with the dashed box.
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

export function SnapshotForm({
  plan,
  onClose,
  renderMap = (p) => <FrameMap {...p} />,
}: {
  plan: FloorPlan
  onClose: () => void
  /** The small map (tests swap it: Leaflet needs a real layout). */
  renderMap?: (p: FrameMapProps) => ReactNode
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
  // Start on the plan's box, else the box it had, else its site, else any
  // site with a position (a site not placed on the map yet).
  const sites = siteMap.data?.sites
  const site =
    sites?.find((s) => s.id === plan.site.id && s.latitude != null) ??
    sites?.find((s) => s.latitude != null && s.longitude != null)
  const start = useMemo(() => {
    if (plan.geo) {
      const b = bboxOf(plan.geo)
      return { lat: (b.north + b.south) / 2, lng: (b.west + b.east) / 2 }
    }
    const last = lastCentre(plan)
    if (last) return last
    if (site?.latitude != null && site.longitude != null)
      return { lat: site.latitude, lng: site.longitude }
    return null
  }, [plan.geo, plan.state, site?.latitude, site?.longitude])
  const initial = useMemo(() => {
    if (!start) return null
    return snapshotFrame(plan, start, plan.frame_extent)
  }, [plan, start])
  const [edited, setEdited] = useState<CellFrame | null>(null)
  // On a plan with no anchor the dashed box stays in the middle of a
  // resized frame until it is dragged.
  const [placed, setPlaced] = useState(false)
  const [zoom, setZoom] = useState(plan.geo?.zoom ?? 18)
  const frame = edited ?? initial
  const [ox, oy] = frame ? frameOffset(frame) : [0, 0]
  const moved =
    !!edited && !!initial && (edited.x !== initial.x || edited.y !== initial.y)
  const resized =
    !!frame && (frame.w !== plan.grid_width || frame.h !== plan.grid_height)
  // Anything but the plan's own box as it is: the grid is re-framed.
  const changed = resized || ox !== 0 || oy !== 0 || (anchored && moved)
  const verb = frame
    ? frameVerb(frame.w, frame.h, plan.grid_width, plan.grid_height)
    : "Moves"
  const error = frame ? frameError(frame) : undefined
  const levels = plan.map_levels ?? 1
  const detail = useMemo(
    () => (frame ? metresPerPixel(frameBbox(frame), Math.max(zoom, 19)) : null),
    [frame, zoom]
  )

  const onFrame = (f: CellFrame, what: "resize" | "move" | "inner") => {
    if (what === "inner") setPlaced(true)
    setEdited(what === "resize" && !anchored && !placed ? centreInner(f) : f)
  }

  const capture = async () => {
    if (!frame || error) return
    setBusy(true)
    try {
      // The deepest tiles: a floor is a building, not a campus (the render
      // steps down when the box needs more pixels than it allows).
      await captureMap(
        plan,
        tiles,
        basemap,
        frameBbox(frame),
        Math.max(zoom, 19),
        !anchored,
        changed
          ? {
              grid: [frame.w, frame.h],
              offset: [ox, oy],
              version: plan.updated_at,
            }
          : undefined
      )
      refetch()
      toast.success(
        !changed
          ? "Map captured"
          : verb === "Moves"
            ? "Moved on the map"
            : `${verb === "Grows" ? "Grown" : verb === "Shrinks" ? "Shrunk" : "Resized"} to ${frame.w} × ${frame.h} cells`
      )
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
        {siteMap.isLoading ? null : start && tiles && frame ? (
          renderMap({
            start,
            startZoom: plan.geo?.zoom ?? 18,
            frame,
            anchored,
            tiles,
            basemap,
            onFrame,
            onZoom: setZoom,
          })
        ) : (
          <p className="text-sm text-muted-foreground">
            {tiles ? "No site has a position on the map." : "No map tiles."}
          </p>
        )}
        {frame && (
          <p
            className="flex flex-wrap gap-x-3 text-xs text-muted-foreground"
            data-testid="frame-size"
          >
            <span className="num">
              {frameReadout(frame.w, frame.h, plan.cell_mm)}
            </span>
            {detail != null && Number.isFinite(detail) && (
              <span className="num">{detailReadout(detail)}</span>
            )}
            {error ? (
              <span className="text-destructive">{error}</span>
            ) : changed && levels > 1 ? (
              <span>
                {verb} all {levels} levels
              </span>
            ) : null}
          </p>
        )}
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
          disabled={busy || !frame || !tiles || !!error}
          onClick={() => void capture()}
        >
          {busy ? "Capturing…" : "Capture"}
        </Button>
      </DialogFooter>
    </>
  )
}

export interface FrameMapProps {
  start: { lat: number; lng: number }
  startZoom: number
  frame: CellFrame
  anchored: boolean
  tiles: SiteMapPayload["tiles"]
  basemap: Basemap
  onFrame: (f: CellFrame, what: "resize" | "move" | "inner") => void
  onZoom: (zoom: number) => void
}

/** The small framing map with the shared frame (frame-layer.ts) on it: its
 * handles resize it, the frame and the dashed box are dragged, and a
 * double-click brings the frame there. */
function FrameMap({
  start,
  startZoom,
  frame,
  tiles,
  basemap,
  onFrame,
  onZoom,
}: FrameMapProps) {
  const el = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<L.Map | null>(null)
  const baseRef = useRef<L.TileLayer | null>(null)
  const layerRef = useRef<ReturnType<typeof frameLayer> | null>(null)
  const frameRef = useRef(frame)
  frameRef.current = frame
  const change = useRef(onFrame)
  change.current = onFrame
  const zoomed = useRef(onZoom)
  zoomed.current = onZoom

  useEffect(() => {
    if (!el.current || mapRef.current) return
    const map = L.map(el.current, {
      zoomControl: true,
      attributionControl: true,
      doubleClickZoom: false,
    })
    map.setView([start.lat, start.lng], Math.min(19, startZoom))
    const b = frameBbox(frame)
    map.fitBounds(
      [
        [b.south, b.west],
        [b.north, b.east],
      ],
      { padding: [48, 48], maxZoom: 19 }
    )
    map.on("zoomend", () => zoomed.current(Math.round(map.getZoom())))
    zoomed.current(Math.round(map.getZoom()))
    map.on("dblclick", (e: L.LeafletMouseEvent) => {
      // The frame's middle to where it was double-clicked.
      const f = frameRef.current
      const fb = frameBbox(f)
      const mx = (mercX(fb.west) + mercX(fb.east)) / 2
      const my = (mercY(fb.north) + mercY(fb.south)) / 2
      change.current(
        moveFrame(f, mercX(e.latlng.lng) - mx, mercY(e.latlng.lat) - my),
        "move"
      )
    })
    mapRef.current = map
    layerRef.current = frameLayer(map, frame, {
      movable: true,
      innerMovable: true,

      onChange: (f, what) => change.current(f, what),
    })
    const unobserve = observeMapSize(map, el.current)
    return () => {
      unobserve()
      layerRef.current?.remove()
      layerRef.current = null
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
    layerRef.current?.update(frame)
  }, [frame])

  return (
    <div
      ref={el}
      className="h-80 w-full overflow-hidden rounded-md border border-border"
      data-testid="frame-map"
    />
  )
}
