import L from "leaflet"

import type { SiteMapConnection } from "@/lib/api"

// Site-to-site connection arcs. Geometry is a quadratic bezier computed in
// lat/lng space (control point offset perpendicular to the chord), sampled
// into a polyline — Leaflet re-projects it every zoom, so arcs stay crisp
// with zero custom rendering. Each edge renders twice: a visible thin line
// and an invisible fat "hit" line that carries hover + click.

export const KIND_COLOR: Record<string, string> = {
  circuit: "#0ea5e9", // sky
  tunnel: "#8b5cf6", // violet
  cable: "#f59e0b", // amber
}

type Pt = [number, number]

export function bezierPoints(a: Pt, z: Pt, bend: number, samples = 24): Pt[] {
  const mid: Pt = [(a[0] + z[0]) / 2, (a[1] + z[1]) / 2]
  const dx = z[1] - a[1]
  const dy = z[0] - a[0]
  const len = Math.sqrt(dx * dx + dy * dy) || 1
  // Perpendicular unit vector (in degree-space) scaled by bend·chord-length.
  const ctrl: Pt = [
    mid[0] + (-dx / len) * bend * len,
    mid[1] + (dy / len) * bend * len,
  ]
  const pts: Pt[] = []
  for (let i = 0; i <= samples; i++) {
    const t = i / samples
    const u = 1 - t
    pts.push([
      u * u * a[0] + 2 * u * t * ctrl[0] + t * t * z[0],
      u * u * a[1] + 2 * u * t * ctrl[1] + t * t * z[1],
    ])
  }
  return pts
}

export interface ConnectionsLayer {
  group: L.LayerGroup
  /** Bezier midpoint per edge id — the popover anchor. */
  midpoints: Map<string, Pt>
}

export function buildConnectionsLayer(
  edges: SiteMapConnection[],
  onSelect: (id: string) => void
): ConnectionsLayer {
  const group = L.layerGroup()
  const midpoints = new Map<string, Pt>()

  // Fan out parallel edges between the same unordered site pair.
  const byPair = new Map<string, SiteMapConnection[]>()
  for (const e of edges) {
    const key = [e.site_a.id, e.site_z.id].sort().join(":")
    byPair.set(key, [...(byPair.get(key) ?? []), e])
  }

  for (const group_edges of byPair.values()) {
    group_edges.sort((a, b) => a.id.localeCompare(b.id))
    const n = group_edges.length
    group_edges.forEach((e, i) => {
      const a: Pt = [e.site_a.latitude, e.site_a.longitude]
      const z: Pt = [e.site_z.latitude, e.site_z.longitude]
      const bend = 0.15 + (i - (n - 1) / 2) * 0.06
      const pts = bezierPoints(a, z, bend)
      midpoints.set(e.id, pts[Math.floor(pts.length / 2)])
      const color = e.color || KIND_COLOR[e.kind] || "#71717a"
      const visible = L.polyline(pts, {
        color,
        weight: 2,
        opacity: 0.8,
        interactive: false,
      })
      const hit = L.polyline(pts, {
        color,
        weight: 14,
        opacity: 0,
        interactive: true,
      })
      hit.on("mouseover", () => visible.setStyle({ weight: 3.5, opacity: 1 }))
      hit.on("mouseout", () => visible.setStyle({ weight: 2, opacity: 0.8 }))
      hit.on("click", (ev: L.LeafletMouseEvent) => {
        L.DomEvent.stopPropagation(ev)
        onSelect(e.id)
      })
      group.addLayer(visible)
      group.addLayer(hit)
    })
  }
  return { group, midpoints }
}
