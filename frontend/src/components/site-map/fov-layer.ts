import L from "leaflet"

import { fovWedge } from "@/components/site-map/geo"

// Field-of-view cones for the site map — devices and free markers alike.
// Geometry lives in lat/lng space (Leaflet re-projects on zoom, so cones
// stay glued to the ground and crisp); styling mirrors the floorplan's
// FovCone: dashed outline, translucent fill, the source's own color.

export interface FovSource {
  lat: number
  lng: number
  color: string
  fov: {
    direction: number | null
    deg: number | null
    distance_m: number | null
    ptz: boolean
  }
}

export function buildFovLayer(sources: FovSource[]): L.LayerGroup {
  const group = L.layerGroup()
  for (const s of sources) {
    const { direction, deg, distance_m, ptz } = s.fov
    if (!distance_m || (!ptz && !deg)) continue
    const style: L.PathOptions = {
      color: s.color || "#71717a",
      weight: 1,
      opacity: 0.45,
      dashArray: "4 3",
      fillColor: s.color || "#71717a",
      fillOpacity: 0.12,
      interactive: false,
    }
    if (ptz) {
      // Pan-tilt-zoom: full coverage ring, radius = reach.
      group.addLayer(L.circle([s.lat, s.lng], { radius: distance_m, ...style }))
    } else {
      group.addLayer(
        L.polygon(
          fovWedge(s.lat, s.lng, direction ?? 0, deg!, distance_m),
          style
        )
      )
    }
  }
  return group
}
