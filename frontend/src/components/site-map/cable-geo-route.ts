import L from "leaflet"

import type { CableRoute, SiteMapCable } from "@/lib/api"
import { routeCable, type Pt } from "@/components/floorplan/cable-route"
import {
  offsetPoint,
  projectToMeters,
  unprojectFromMeters,
} from "@/components/site-map/geo"
import {
  bezierPoints,
  escapeTip,
  lineTip,
  utilTip,
  visibleStrokes,
} from "@/components/site-map/connections-layer"
import { lineColor } from "@/components/site-map/line-style"
import type { LineColorBy } from "@/components/site-map/line-style"
import type { LineUtil } from "@/components/site-map/line-utilization"

// Every cable draws on the map - whether or not it's on a route. A cable on
// a route follows that geometry (Dijkstra through the route graph, run in a
// local meter plane because raw degrees would make the snap ~83 km and skew
// distances by cos(latitude)); a cable without a route draws as a gentle
// curve between its two endpoints. Routes only prettify the geometry.

const SNAP_M = 25

/** Route A→Z through the given route polylines, in lat/lng. Falls back to a
 * straight line when the routes don't connect the ends (routeCable's own
 * fallback). */
export function routeCableGeo(
  a: Pt,
  z: Pt,
  routePolys: Pt[][],
  snapM = SNAP_M
): Pt[] {
  const all = [a, z, ...routePolys.flat()]
  if (all.length === 0) return [a, z]
  const refLat = all.reduce((s, p) => s + p[0], 0) / all.length
  const [pa, pz] = projectToMeters([a, z], refLat)
  const polysM = routePolys.map((poly) => projectToMeters(poly, refLat))
  const path = routeCable(pa, pz, polysM, snapM)
  return unprojectFromMeters(path, refLat)
}

/** A cable to draw: its path plus identity/styling and whether it's routed.
 * `status` and `capacity` feed the Status and Speed colourings, `links` and
 * `ends` (its A and Z device names) the Utilization one. */
export interface DrawnCable {
  id: string
  label: string
  color: string
  path: Pt[]
  routed: boolean
  status?: SiteMapCable["status"]
  capacity?: SiteMapCable["capacity"]
  links?: SiteMapCable["links"]
  ends?: [string, string]
}

/** Compute every cable's map polyline from the /site-map/cables payload.
 * Routed cables follow their route geometry (tails to the endpoints via the
 * meter-plane router); un-routed cables get a curved chord, parallel-fanned
 * when several share the same device pair so a bundle reads as strands. */
export function buildDrawnCables(
  cables: SiteMapCable[],
  routes: CableRoute[]
): DrawnCable[] {
  // route waypoints by id, for routed geometry.
  const routeWaypoints = new Map<string, Pt[]>()
  for (const r of routes) {
    if (Array.isArray(r.waypoints) && r.waypoints.length >= 2)
      routeWaypoints.set(r.id, r.waypoints as Pt[])
  }

  // Group un-routed cables by unordered device pair, to fan parallels.
  const pairIndex = new Map<string, number>()
  const pairTotal = new Map<string, number>()
  for (const c of cables) {
    if (c.route_ids.length) continue
    const key = [c.a.device_id, c.z.device_id].sort().join(":")
    pairTotal.set(key, (pairTotal.get(key) ?? 0) + 1)
  }

  const out: DrawnCable[] = []
  for (const c of cables) {
    const a: Pt = [c.a.lat, c.a.lng]
    const z: Pt = [c.z.lat, c.z.lng]
    const polys = c.route_ids
      .map((id) => routeWaypoints.get(id))
      .filter((p): p is Pt[] => !!p)

    const look = {
      status: c.status,
      capacity: c.capacity,
      links: c.links,
      ends: [c.a.device_name, c.z.device_name] as [string, string],
    }
    if (polys.length) {
      out.push({
        id: c.id,
        label: c.label,
        color: c.color,
        path: routeCableGeo(a, z, polys),
        routed: true,
        ...look,
      })
      continue
    }
    // Un-routed: a curved chord. Same-point cables (A==Z exactly) get a tiny
    // loop so they're still visible + clickable.
    if (c.same_point) {
      out.push({
        id: c.id,
        label: c.label,
        color: c.color,
        path: [a, offsetPoint(a[0], a[1], 45, 12), z],
        routed: false,
        ...look,
      })
      continue
    }
    const key = [c.a.device_id, c.z.device_id].sort().join(":")
    const total = pairTotal.get(key) ?? 1
    const idx = pairIndex.get(key) ?? 0
    pairIndex.set(key, idx + 1)
    // Centered fan: single cable is straight (bend 0), bundles spread out.
    const bend = total > 1 ? (idx - (total - 1) / 2) * 0.12 : 0
    out.push({
      id: c.id,
      label: c.label,
      color: c.color,
      path: bezierPoints(a, z, bend),
      routed: false,
      ...look,
    })
  }
  return out
}

/** Perpendicular meter offset for parallel cables inside one channel, so a
 * bundle reads as distinct strands instead of one overdrawn line. */
export function offsetPath(path: Pt[], meters: number): Pt[] {
  if (meters === 0 || path.length < 2) return path
  return path.map((p, i) => {
    const prev = path[Math.max(0, i - 1)]
    const next = path[Math.min(path.length - 1, i + 1)]
    const bearing =
      (Math.atan2(next[1] - prev[1], next[0] - prev[0]) * 180) / Math.PI
    return offsetPoint(p[0], p[1], bearing + 90, meters)
  })
}

/** Leaflet layer for cables; members of `highlightIds` thicken, the rest dim
 * when anything is highlighted. Un-routed cables draw dashed. A cable with
 * no colour of its own is amber, the legend's Cable. */
export function buildDrawnCablesLayer(
  cables: DrawnCable[],
  opts: {
    highlightIds: Set<string>
    onSelect?: (cableId: string) => void
    /** Color by (the site map's Display popover); Type by default. */
    colorBy?: LineColorBy
    /** Under Utilization: each cable's live traffic, by id. */
    util?: ReadonlyMap<string, LineUtil>
  }
): L.LayerGroup {
  const group = L.layerGroup()
  const anyHi = opts.highlightIds.size > 0
  cables.forEach((c) => {
    const highlighted = opts.highlightIds.has(c.id)
    const dimmed = anyHi && !highlighted
    const colorBy = opts.colorBy ?? "type"
    const util =
      colorBy === "utilization"
        ? (opts.util?.get(c.id) ?? { az: null, za: null, at: null })
        : null
    const opacity = dimmed ? 0.12 : highlighted ? 1 : c.routed ? 0.85 : 0.6
    const strokes = visibleStrokes(
      c.path,
      lineColor({ ...c, kind: "cable" }, colorBy),
      util,
      {
        weight: highlighted ? 4 : 2,
        opacity,
        dashArray: c.routed ? undefined : "5 4",
        lineCap: "round",
        lineJoin: "round",
        interactive: false,
      }
    )
    if (util && dimmed) strokes.layers.forEach((l) => l.setStyle({ opacity }))
    const hit = L.polyline(c.path, { color: "#000", weight: 12, opacity: 0 })
    const tip = lineTip(c.label || "cable", "", c.capacity?.label)
    const [aName, zName] = c.ends ?? ["A", "Z"]
    const utilText = util ? escapeTip(utilTip(aName, zName, util)) : ""
    hit.bindTooltip(util ? `${escapeTip(tip)}<br>${utilText}` : tip, {
      sticky: true,
      direction: "top",
    })
    hit.on("click", (e: L.LeafletMouseEvent) => {
      L.DomEvent.stopPropagation(e)
      opts.onSelect?.(c.id)
    })
    strokes.layers.forEach((l) => group.addLayer(l))
    group.addLayer(hit)
  })
  return group
}
