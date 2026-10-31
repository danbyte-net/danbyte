import L from "leaflet"

import type { SiteMapPlanFootprint } from "@/lib/api"

// The boxes of the floor plans made from the Site map: a faint dashed
// rectangle each, under the outlines, named on hover; a click opens the
// plan. SVG can't resolve CSS variables, so the colour is a literal zinc,
// like the outlines' neutral.

export const FOOTPRINT_COLOR = "#71717a"

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!
  )
}

/** "Campus · Ground" - the floor plan and the floor, when they differ. */
export function footprintName(f: SiteMapPlanFootprint): string {
  return f.stack && f.stack !== f.name ? `${f.stack} · ${f.name}` : f.name
}

export function buildPlanFootprintsLayer(
  footprints: SiteMapPlanFootprint[],
  opts: {
    onOpen: (id: string) => void
    /** The pane the rectangles draw in (under the outlines). */
    pane?: string
    /** Off while a tool is drawing, so clicks reach the map. */
    interactive?: boolean
  }
): L.LayerGroup {
  const group = L.layerGroup()
  for (const f of footprints) {
    const [s, w, n, e] = f.bbox
    const bounds: L.LatLngBoundsExpression = [
      [s, w],
      [n, e],
    ]
    const pane = opts.pane ? { pane: opts.pane } : {}
    // The faint fill never takes a click: clicks inside a campus box
    // still reach the map and what is on it. Only the edge opens the plan.
    L.rectangle(bounds, {
      stroke: false,
      fillColor: FOOTPRINT_COLOR,
      fillOpacity: 0.04,
      interactive: false,
      ...pane,
    }).addTo(group)
    const rect = L.rectangle(bounds, {
      color: FOOTPRINT_COLOR,
      weight: 1.5,
      opacity: 0.7,
      dashArray: "4 4",
      fill: false,
      className: "sm-plan-footprint",
      interactive: opts.interactive ?? true,
      ...pane,
    })
    if (opts.interactive ?? true) {
      rect.bindTooltip(escapeHtml(footprintName(f)), {
        sticky: true,
        direction: "top",
      })
      rect.on("click", () => opts.onOpen(f.id))
    }
    rect.addTo(group)
  }
  return group
}
