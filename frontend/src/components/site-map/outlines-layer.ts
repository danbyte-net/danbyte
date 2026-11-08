import L from "leaflet"

import type { SiteMapOutline } from "@/lib/api"

import {
  centroid,
  edgeMidpoints,
  insertVertex,
  moveVertex,
  removeVertex,
} from "./outline-geometry"
import type { Pt } from "./outline-geometry"

// Building outlines on the Site map: a filled polygon with an outline and a
// label at its centre. Under every marker and line (the overlay pane's own
// order puts it below the markers), above the region boundaries. SVG can't
// resolve CSS variables, so the neutral fallback is a literal zinc, like the
// cable routes' and region boundaries'.

export const OUTLINE_NEUTRAL = "#71717a"

const FILL = 0.18
const FILL_HOVER = 0.32

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!
  )
}

export function outlineColor(o: Pick<SiteMapOutline, "display_color">) {
  return o.display_color || OUTLINE_NEUTRAL
}

export function buildOutlinesLayer(
  outlines: SiteMapOutline[],
  opts: {
    selectedId: string | null
    /** Labels always (Display → Labels → Names), or on hover/selection. */
    showLabels: boolean
    onSelect: (id: string) => void
    /** The pane the polygons draw in (under the lines and markers). */
    pane?: string
    /** Off while an outline is being drawn, so clicks reach the map. */
    interactive?: boolean
  }
): L.LayerGroup {
  const group = L.layerGroup()
  const ordered = [...outlines].sort((a, b) => a.z - b.z)
  for (const o of ordered) {
    if (!Array.isArray(o.points) || o.points.length < 3) continue
    const color = outlineColor(o)
    const selected = o.id === opts.selectedId
    const poly = L.polygon(o.points, {
      color,
      weight: selected ? 3 : 1.5,
      opacity: 0.9,
      fillColor: color,
      fillOpacity: selected ? FILL_HOVER : FILL,
      className: "sm-outline",
      interactive: opts.interactive ?? true,
      ...(opts.pane ? { pane: opts.pane } : {}),
    })
    const label = o.display_label
    let chip: L.Marker | null = null
    if (label) {
      chip = L.marker(centroid(o.points), {
        interactive: false,
        keyboard: false,
        icon: L.divIcon({
          className: "sm-outline-label-wrap",
          html: `<span class="sm-outline-label">${escapeHtml(label)}</span>`,
          iconSize: [0, 0],
        }),
      })
    }
    const labelShown = opts.showLabels || selected
    poly.on("mouseover", () => {
      poly.setStyle({ fillOpacity: FILL_HOVER, weight: selected ? 3 : 2.5 })
      if (chip && !labelShown) chip.addTo(group)
    })
    poly.on("mouseout", () => {
      poly.setStyle({
        fillOpacity: selected ? FILL_HOVER : FILL,
        weight: selected ? 3 : 1.5,
      })
      if (chip && !labelShown) group.removeLayer(chip)
    })
    poly.on("click", (e: L.LeafletMouseEvent) => {
      L.DomEvent.stopPropagation(e)
      opts.onSelect(o.id)
    })
    group.addLayer(poly)
    if (chip && labelShown) group.addLayer(chip)
  }
  return group
}

function dotIcon(cls: string): L.DivIcon {
  return L.divIcon({
    className: "sm-marker",
    html: `<span class="${cls}"></span>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  })
}

/** The dashed outline being drawn, its points as dots. */
export function buildOutlineDraftLayer(points: Pt[]): L.LayerGroup {
  const group = L.layerGroup()
  if (points.length >= 3) {
    group.addLayer(
      L.polygon(points, {
        color: "#0ea5e9",
        weight: 2,
        dashArray: "6 5",
        fillOpacity: 0.08,
        interactive: false,
      })
    )
  } else if (points.length === 2) {
    group.addLayer(
      L.polyline(points, {
        color: "#0ea5e9",
        weight: 2,
        dashArray: "6 5",
        interactive: false,
      })
    )
  }
  for (const p of points)
    group.addLayer(
      L.marker(p, { icon: dotIcon("sm-vertex"), interactive: false })
    )
  return group
}

/** Reshape handles for the selected outline: drag a point, click an edge's
 * "+" to add one, right-click a point to remove it (three always stay).
 * Every change calls `onChange` with the whole ring - the page checks it and
 * saves it. */
export function buildOutlineReshapeLayer(
  points: Pt[],
  onChange: (points: Pt[]) => void
): L.LayerGroup {
  const group = L.layerGroup()
  const pts = points.map((p) => [p[0], p[1]] as Pt)
  pts.forEach((p, i) => {
    const m = L.marker(p, { icon: dotIcon("sm-vertex"), draggable: true })
    m.on("dragend", () => {
      const ll = m.getLatLng()
      onChange(moveVertex(pts, i, [ll.lat, ll.lng]))
    })
    m.on("contextmenu", (e: L.LeafletMouseEvent) => {
      L.DomEvent.stopPropagation(e)
      e.originalEvent.preventDefault()
      const next = removeVertex(pts, i)
      if (next) onChange(next)
    })
    m.on("click", (e: L.LeafletMouseEvent) => L.DomEvent.stopPropagation(e))
    group.addLayer(m)
  })
  edgeMidpoints(pts).forEach((mid, i) => {
    const m = L.marker(mid, { icon: dotIcon("sm-vertex-add") })
    m.on("click", (e: L.LeafletMouseEvent) => {
      L.DomEvent.stopPropagation(e)
      onChange(insertVertex(pts, i))
    })
    group.addLayer(m)
  })
  return group
}
