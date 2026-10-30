import { useEffect, useRef } from "react"
import L from "leaflet"

import type { Bbox } from "./plan-from-map"

export function boundsToBbox(b: L.LatLngBounds): Bbox {
  return {
    south: b.getSouth(),
    west: b.getWest(),
    north: b.getNorth(),
    east: b.getEast(),
  }
}

/**
 * While `active`, the map frames an area instead of panning: drag a
 * rectangle, or press Enter for the whole view; Esc cancels. The map pans
 * again as soon as it is done.
 */
export function useFrameTool({
  map,
  active,
  onFrame,
  onCancel,
}: {
  map: L.Map | null
  active: boolean
  onFrame: (bbox: Bbox) => void
  onCancel: () => void
}) {
  const cb = useRef({ onFrame, onCancel })
  cb.current = { onFrame, onCancel }
  useEffect(() => {
    if (!map || !active) return
    let start: L.LatLng | null = null
    let rect: L.Rectangle | null = null
    const container = map.getContainer()
    const cursor = container.style.cursor
    container.style.cursor = "crosshair"
    map.dragging.disable()
    map.boxZoom.disable()
    const onDown = (e: L.LeafletMouseEvent) => {
      start = e.latlng
      rect?.remove()
      rect = L.rectangle(L.latLngBounds(start, start), {
        color: "#2563eb",
        weight: 2,
        dashArray: "6 4",
        fillOpacity: 0.08,
        interactive: false,
      }).addTo(map)
    }
    const onMove = (e: L.LeafletMouseEvent) => {
      if (start && rect) rect.setBounds(L.latLngBounds(start, e.latlng))
    }
    const onUp = (e: L.LeafletMouseEvent) => {
      if (!start) return
      const a = map.latLngToContainerPoint(start)
      const b = map.latLngToContainerPoint(e.latlng)
      const bounds = L.latLngBounds(start, e.latlng)
      start = null
      // A click, not a drag: nothing framed yet.
      if (Math.abs(a.x - b.x) < 8 || Math.abs(a.y - b.y) < 8) {
        rect?.remove()
        rect = null
        return
      }
      cb.current.onFrame(boundsToBbox(bounds))
    }
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return
      if (e.key === "Escape") cb.current.onCancel()
      if (e.key === "Enter") {
        e.preventDefault()
        cb.current.onFrame(boundsToBbox(map.getBounds()))
      }
    }
    map.on("mousedown", onDown)
    map.on("mousemove", onMove)
    map.on("mouseup", onUp)
    window.addEventListener("keydown", onKey)
    return () => {
      map.off("mousedown", onDown)
      map.off("mousemove", onMove)
      map.off("mouseup", onUp)
      window.removeEventListener("keydown", onKey)
      rect?.remove()
      container.style.cursor = cursor
      map.dragging.enable()
      map.boxZoom.enable()
    }
  }, [map, active])
}
