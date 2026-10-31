import { useEffect, useRef } from "react"
import L from "leaflet"
import "leaflet/dist/leaflet.css"

import type { SiteMapPayload } from "@/lib/api"
import { observeMapSize, setBaseLayer } from "@/components/site-map/map-core"

import { bboxOf, grownBbox, sideFromDrag } from "./plan-geo"
import type { AnchoredPlan, Sides } from "./plan-geo"

const SIDES: (keyof Sides)[] = ["north", "east", "south", "west"]
// SVG can't resolve CSS variables: literal zinc and blue, like the Site
// map's own outlines and frame.
const OLD = "#71717a"
const NEW = "#2563eb"

/**
 * Expand's small map: the plan's box (dashed) and the box it grows to, with
 * a handle on each side to drag it out. Each drag snaps to whole cells.
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
  onChange: (side: keyof Sides, cells: number) => void
  tiles: SiteMapPayload["tiles"] | undefined
  basemap: "map" | "sat"
}) {
  const el = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<L.Map | null>(null)
  const baseRef = useRef<L.TileLayer | null>(null)
  const layerRef = useRef<L.LayerGroup | null>(null)
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
    const unobserve = observeMapSize(map, el.current)
    return () => {
      unobserve()
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
    const map = mapRef.current
    if (!map) return
    layerRef.current?.remove()
    const group = L.layerGroup()
    const o = bboxOf(plan.geo)
    const n = grownBbox(plan, sides)
    L.rectangle(
      [
        [o.south, o.west],
        [o.north, o.east],
      ],
      {
        color: OLD,
        weight: 1.5,
        dashArray: "4 4",
        fill: false,
        interactive: false,
      }
    ).addTo(group)
    L.rectangle(
      [
        [n.south, n.west],
        [n.north, n.east],
      ],
      { color: NEW, weight: 2, fillOpacity: 0.06, interactive: false }
    ).addTo(group)
    const midLat = (n.north + n.south) / 2
    const midLng = (n.west + n.east) / 2
    const at: Record<keyof Sides, [number, number]> = {
      north: [n.north, midLng],
      south: [n.south, midLng],
      west: [midLat, n.west],
      east: [midLat, n.east],
    }
    for (const side of SIDES) {
      const handle = L.marker(at[side], {
        draggable: true,
        keyboard: false,
        icon: L.divIcon({
          className: "",
          html: `<span data-side="${side}" style="display:block;width:12px;height:12px;border-radius:3px;background:#fff;border:2px solid ${NEW};cursor:${side === "north" || side === "south" ? "ns" : "ew"}-resize"></span>`,
          iconSize: [12, 12],
          iconAnchor: [6, 6],
        }),
      })
      handle.on("dragend", () =>
        change.current(side, sideFromDrag(plan, side, handle.getLatLng()))
      )
      handle.addTo(group)
    }
    group.addTo(map)
    layerRef.current = group
  }, [plan, sides])

  return (
    <div
      ref={el}
      className="h-64 w-full overflow-hidden rounded-md border border-border"
      data-testid="expand-map"
    />
  )
}
