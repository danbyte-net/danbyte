import L from "leaflet"

import type { CableRoute } from "@/lib/api"

// Geographic cable routes drawn as the floor planner draws trays: a wide,
// faint "channel" polyline (so routed cables can read *inside* it) plus an
// invisible fat hit line for hover/click. Same visible/hit pattern as
// connections-layer.ts.

const DEFAULT_COLOR = "#71717a"

export function buildRoutesLayer(
  routes: CableRoute[],
  opts: {
    selectedId: string | null
    onSelect: (id: string) => void
  }
): L.LayerGroup {
  const group = L.layerGroup()
  for (const r of routes) {
    if (!Array.isArray(r.waypoints) || r.waypoints.length < 2) continue
    const color = r.color || DEFAULT_COLOR
    const selected = r.id === opts.selectedId
    const pts = r.waypoints.map(([lat, lng]) => [lat, lng] as [number, number])
    const channel = L.polyline(pts, {
      color,
      weight: selected ? 12 : 10,
      opacity: selected ? 0.45 : 0.25,
      lineCap: "round",
      lineJoin: "round",
      interactive: false,
    })
    const core = L.polyline(pts, {
      color,
      weight: selected ? 2.5 : 1.5,
      opacity: selected ? 0.9 : 0.6,
      dashArray: "6 5",
      interactive: false,
    })
    const hit = L.polyline(pts, {
      color: "#000",
      weight: 14,
      opacity: 0,
    })
    hit.on("mouseover", () => channel.setStyle({ opacity: 0.4 }))
    hit.on("mouseout", () =>
      channel.setStyle({ opacity: selected ? 0.45 : 0.25 })
    )
    hit.on("click", (e: L.LeafletMouseEvent) => {
      L.DomEvent.stopPropagation(e)
      opts.onSelect(r.id)
    })
    hit.bindTooltip(
      `${r.name}${r.kind ? ` · ${r.kind}` : ""} · ${r.cables.length} cable${
        r.cables.length === 1 ? "" : "s"
      }`,
      { sticky: true, direction: "top" }
    )
    group.addLayer(channel)
    group.addLayer(core)
    group.addLayer(hit)
  }
  return group
}
