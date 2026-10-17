import L from "leaflet"

import type { SiteMapConnection } from "@/lib/api"
import { KIND_COLOR, lineColor } from "@/components/site-map/line-style"
import type { LineColorBy } from "@/components/site-map/line-style"
import {
  directionLabel,
  halfLook,
  splitAtMidpoint,
} from "@/components/site-map/line-utilization"
import type { LineUtil } from "@/components/site-map/line-utilization"

export { KIND_COLOR }

// Site-to-site connection arcs. Geometry is a quadratic bezier computed in
// lat/lng space (control point offset perpendicular to the chord), sampled
// into a polyline - Leaflet re-projects it every zoom, so arcs stay crisp
// with zero custom rendering. Each edge renders twice: a visible thin line
// and an invisible fat "hit" line that carries hover + click.

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

/** Each edge's arc, parallel edges between one site pair fanned apart - the
 * geometry the layer draws, and where the map anchors a popover or a speed
 * label. */
export function connectionPaths(
  edges: readonly SiteMapConnection[]
): Map<string, Pt[]> {
  const byPair = new Map<string, SiteMapConnection[]>()
  for (const e of edges) {
    const key = [e.site_a.id, e.site_z.id].sort().join(":")
    byPair.set(key, [...(byPair.get(key) ?? []), e])
  }
  const out = new Map<string, Pt[]>()
  for (const pairEdges of byPair.values()) {
    pairEdges.sort((a, b) => a.id.localeCompare(b.id))
    const n = pairEdges.length
    pairEdges.forEach((e, i) => {
      const a: Pt = [e.site_a.latitude, e.site_a.longitude]
      const z: Pt = [e.site_z.latitude, e.site_z.longitude]
      out.set(e.id, bezierPoints(a, z, 0.15 + (i - (n - 1) / 2) * 0.06))
    })
  }
  return out
}

/** Halfway between a connection's two sites - where a line the arcs layer
 * doesn't draw (a site pair's cables, drawn cable by cable) anchors its
 * popover. */
export function chordMidpoint(e: SiteMapConnection): Pt {
  return [
    (e.site_a.latitude + e.site_z.latitude) / 2,
    (e.site_a.longitude + e.site_z.longitude) / 2,
  ]
}

export interface ConnectionsLayer {
  group: L.LayerGroup
  /** Bezier midpoint per edge id - the popover anchor. */
  midpoints: Map<string, Pt>
}

/** A line's hover text: its name and kind, and its speed when known. */
export function lineTip(name: string, kind: string, speed?: string): string {
  return [name, kind, speed].filter(Boolean).join(" · ")
}

/** Text made safe for a Leaflet tooltip, which takes HTML. */
export function escapeTip(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!
  )
}

/** The Utilization hover line: each direction, named by its ends. */
export function utilTip(a: string, z: string, u: LineUtil | undefined): string {
  return [
    `${a} → ${z} ${directionLabel(u?.az ?? null)}`,
    `${z} → ${a} ${directionLabel(u?.za ?? null)}`,
  ].join(" · ")
}

/**
 * The visible stroke of a line: one polyline, or - under Utilization - two
 * halves, the half at A in its A → Z band and the half at Z in its Z → A
 * band. `emphasis` lifts it on hover.
 */
export function visibleStrokes(
  pts: [number, number][],
  color: string,
  util: LineUtil | null,
  base: L.PolylineOptions
): { layers: L.Polyline[]; emphasis: (on: boolean) => void } {
  if (!util) {
    const line = L.polyline(pts, { ...base, color })
    const weight = base.weight ?? 2
    const opacity = base.opacity ?? 0.8
    return {
      layers: [line],
      emphasis: (on) =>
        line.setStyle(
          on ? { weight: weight + 1.5, opacity: 1 } : { weight, opacity }
        ),
    }
  }
  const [first, second] = splitAtMidpoint(pts)
  const halves = [
    { path: first, look: halfLook(util.az) },
    { path: second, look: halfLook(util.za) },
  ].map(({ path, look }) => ({
    line: L.polyline(path, {
      ...base,
      color: look.color,
      weight: look.weight,
      opacity: 0.9,
      lineCap: "butt",
    }),
    weight: look.weight,
  }))
  return {
    layers: halves.map((h) => h.line),
    emphasis: (on) =>
      halves.forEach((h) =>
        h.line.setStyle({
          weight: on ? h.weight + 1.5 : h.weight,
          opacity: on ? 1 : 0.9,
        })
      ),
  }
}

export function buildConnectionsLayer(
  edges: SiteMapConnection[],
  onSelect: (id: string) => void,
  /** Color by (the site map's Display popover); the MiniMap leaves it at
   * Type, the kinds' own colours. */
  colorBy: LineColorBy = "type",
  /** Under Utilization: each line's live traffic, by id. */
  util?: ReadonlyMap<string, LineUtil>
): ConnectionsLayer {
  const group = L.layerGroup()
  const midpoints = new Map<string, Pt>()
  const byId = new Map(edges.map((e) => [e.id, e]))

  // In the paths' order: each site pair's arcs together, as always drawn.
  for (const [id, pts] of connectionPaths(edges)) {
    const e = byId.get(id)!
    midpoints.set(e.id, pts[Math.floor(pts.length / 2)])
    const color = lineColor(e, colorBy)
    const lineUtil =
      colorBy === "utilization"
        ? (util?.get(e.id) ?? { az: null, za: null, at: null })
        : null
    const visible = visibleStrokes(pts, color, lineUtil, {
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
    // Same hover identity the drawn cables carry - every line names
    // itself before you commit to a click.
    const tip = lineTip(e.name, e.kind, e.capacity?.label)
    hit.bindTooltip(
      lineUtil
        ? `${escapeTip(tip)}<br>${escapeTip(utilTip(e.site_a.name, e.site_z.name, lineUtil))}`
        : tip,
      { sticky: true, direction: "top" }
    )
    hit.on("mouseover", () => visible.emphasis(true))
    hit.on("mouseout", () => visible.emphasis(false))
    hit.on("click", (ev: L.LeafletMouseEvent) => {
      L.DomEvent.stopPropagation(ev)
      onSelect(e.id)
    })
    visible.layers.forEach((l) => group.addLayer(l))
    group.addLayer(hit)
  }
  return { group, midpoints }
}
