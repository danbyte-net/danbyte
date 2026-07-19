import L from "leaflet"

// Leaflet-native port of the floor planner's tray draw/reshape UX.
//
// Draw:    the page collects waypoints on map clicks; this module renders the
//          dashed live preview (polyline + vertex dots).
// Reshape: draggable vertex handles, "+" handles on segment midpoints to add
//          a bend, right-click a vertex to remove it (min 2 stay).

type Pt = [number, number]

function dotIcon(cls: string): L.DivIcon {
  return L.divIcon({
    className: "sm-marker",
    html: `<span class="${cls}"></span>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  })
}

/** Dashed in-progress polyline while drawing a new route. */
export function buildDraftLayer(points: Pt[]): L.LayerGroup {
  const group = L.layerGroup()
  if (points.length >= 2) {
    group.addLayer(
      L.polyline(points, {
        color: "#0ea5e9",
        weight: 2,
        dashArray: "6 5",
        interactive: false,
      })
    )
  }
  for (const p of points) {
    group.addLayer(
      L.marker(p, { icon: dotIcon("sm-vertex"), interactive: false })
    )
  }
  return group
}

/** Reshape handles for the selected route: drag vertices, click a midpoint
 * "+" to add a bend, right-click a vertex to remove. Every change calls
 * `onChange` with the full waypoint list (the page PATCHes it). */
export function buildReshapeLayer(
  waypoints: Pt[],
  onChange: (waypoints: Pt[]) => void
): L.LayerGroup {
  const group = L.layerGroup()
  const pts = waypoints.map((p) => [p[0], p[1]] as Pt)

  pts.forEach((p, i) => {
    const m = L.marker(p, { icon: dotIcon("sm-vertex"), draggable: true })
    m.on("dragend", () => {
      const ll = m.getLatLng()
      const next = pts.map((q, j) => (j === i ? ([ll.lat, ll.lng] as Pt) : q))
      onChange(next)
    })
    m.on("contextmenu", (e: L.LeafletMouseEvent) => {
      L.DomEvent.stopPropagation(e)
      e.originalEvent.preventDefault()
      if (pts.length <= 2) return
      onChange(pts.filter((_, j) => j !== i))
    })
    group.addLayer(m)
  })

  // Midpoint "+" handles — click to splice a new vertex into the segment.
  for (let i = 0; i < pts.length - 1; i++) {
    const mid: Pt = [
      (pts[i][0] + pts[i + 1][0]) / 2,
      (pts[i][1] + pts[i + 1][1]) / 2,
    ]
    const m = L.marker(mid, { icon: dotIcon("sm-vertex-add") })
    m.on("click", (e: L.LeafletMouseEvent) => {
      L.DomEvent.stopPropagation(e)
      const next = [...pts.slice(0, i + 1), mid, ...pts.slice(i + 1)]
      onChange(next)
    })
    group.addLayer(m)
  }
  return group
}
