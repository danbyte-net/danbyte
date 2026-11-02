import { useEffect, useRef } from "react"
import L from "leaflet"
import "leaflet/dist/leaflet.css"

import type { SiteMapPayload } from "@/lib/api"
import { observeMapSize, setBaseLayer } from "@/components/site-map/map-core"

import { frameLayer } from "./frame-layer"
import { bboxOf, frameOfPlan, sidesOfFrame } from "./plan-geo"
import type { AnchoredPlan, Sides } from "./plan-geo"

/**
 * Expand's small map: the plan's box (dashed) and the frame it grows to,
 * with a handle on each corner and edge to drag it out (the shared frame,
 * frame-layer.ts). Each drag snaps to whole cells.
 */
export function ExpandMap({
  plan,
  sides,
  onChange,
  tiles,
  basemap,
}: {
  plan: AnchoredPlan
  sides: Sides
  onChange: (sides: Sides) => void
  tiles: SiteMapPayload["tiles"] | undefined
  basemap: "map" | "sat"
}) {
  const el = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<L.Map | null>(null)
  const baseRef = useRef<L.TileLayer | null>(null)
  const layerRef = useRef<ReturnType<typeof frameLayer> | null>(null)
  const change = useRef(onChange)
  change.current = onChange

  useEffect(() => {
    if (!el.current || mapRef.current) return
    const map = L.map(el.current, {
      zoomControl: true,
      attributionControl: true,
    })
    const b = bboxOf(plan.geo)
    map.fitBounds(
      [
        [b.south, b.west],
        [b.north, b.east],
      ],
      { padding: [48, 48] }
    )
    mapRef.current = map
    layerRef.current = frameLayer(map, frameOfPlan(plan, sides), {
      movable: false,
      innerMovable: false,
      onChange: (f) => change.current(sidesOfFrame(f)),
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

  const url = basemap === "sat" ? tiles?.satellite.url : tiles?.url
  useEffect(() => {
    const map = mapRef.current
    if (!map || !tiles || !url) return
    setBaseLayer(map, baseRef, {
      url,
      attribution:
        basemap === "sat" ? tiles.satellite.attribution : tiles.attribution,
    })
  }, [url])

  useEffect(() => {
    layerRef.current?.update(frameOfPlan(plan, sides))
  }, [plan, sides])

  return (
    <div
      ref={el}
      className="h-64 w-full overflow-hidden rounded-md border border-border"
      data-testid="expand-map"
    />
  )
}
