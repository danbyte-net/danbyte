import { useEffect, useRef } from "react"
import L from "leaflet"
import "leaflet/dist/leaflet.css"

import { observeMapSize, setBaseLayer } from "@/components/site-map/map-core"
import { mercX, mercY } from "@/components/site-map/plan-from-map"

import { frameLayer } from "./frame-layer"
import type { FrameMapProps } from "./map-snapshot"
import { frameBbox, moveFrame } from "./plan-geo"

// Loaded in the browser only, by map-snapshot.tsx: Leaflet reads `window`
// as it loads.

/** The small framing map with the shared frame (frame-layer.ts) on it: its
 * handles resize it, the frame and the dashed box are dragged, and a
 * double-click brings the frame there. */
export default function FrameMap({
  start,
  startZoom,
  frame,
  locked = false,
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
      if (locked) return
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
      movable: !locked,
      innerMovable: !locked,

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
