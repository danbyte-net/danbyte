import L from "leaflet"

import type { SiteMapDependencyLine } from "@/lib/api"
import {
  DEPENDENCY_DASH,
  UNKNOWN_SPEED_HEX,
} from "@/components/topology/edge-style"
import {
  bezierPoints,
  escapeTip,
} from "@/components/site-map/connections-layer"

// The site map's Dependencies layer (#450), drawn over the basemap (vector
// tiles or raster, #467) like the other line layers: a line per dependency
// between two devices with their own coordinates, and one per site pair,
// medium and kind for the rest - each in its medium's colour and line
// style, with a chevron pointing downstream (none on a peer link). Site
// pairs bow the other way from the connection arcs so the two never lie on
// top of each other.

type Pt = [number, number]

/** Where a line lies: a straight device-to-device run, or a bowed arc
 * between two sites. */
export function dependencyPath(line: SiteMapDependencyLine): Pt[] {
  if (line.kind === "devices")
    return [
      [line.a.lat, line.a.lng],
      [line.z.lat, line.z.lng],
    ]
  return bezierPoints(
    [line.site_a.latitude, line.site_a.longitude],
    [line.site_z.latitude, line.site_z.longitude],
    -0.18
  )
}

/** A chevron at 60% of the way along `pts`, pointing to the far end - two
 * short strokes in the line's own degrees, so it scales with the map. */
export function chevron(pts: Pt[]): Pt[] | null {
  if (pts.length < 2) return null
  const i = Math.min(pts.length - 2, Math.floor((pts.length - 1) * 0.6))
  const [a, b] = [pts[i], pts[i + 1]]
  const dy = b[0] - a[0]
  const dx = b[1] - a[1]
  const seg = Math.hypot(dx, dy)
  if (!seg) return null
  const first = pts[0]
  const last = pts[pts.length - 1]
  const size =
    Math.hypot(last[0] - first[0], last[1] - first[1]) * 0.05 || seg * 0.5
  const ux = dx / seg
  const uy = dy / seg
  const tip: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
  // Two arms back from the tip, 30° either side of the line.
  const arm = (sign: number): Pt => {
    const cos = Math.cos(Math.PI / 6)
    const sin = Math.sin(Math.PI / 6) * sign
    const bx = -ux * cos - -uy * sin
    const by = -uy * cos + -ux * sin
    return [tip[0] + by * size, tip[1] + bx * size]
  }
  return [arm(1), tip, arm(-1)]
}

/** A line's hover text: what depends on what, over which medium. */
export function dependencyTip(line: SiteMapDependencyLine): string {
  const medium = line.medium?.name
  const arrow = line.dependency_kind === "peer" ? "↔" : "→"
  if (line.kind === "devices")
    return escapeTip(
      [`${line.a.device_name} ${arrow} ${line.z.device_name}`, medium]
        .filter(Boolean)
        .join(" · ")
    )
  const head = [
    `${line.site_a.name} ${arrow} ${line.site_z.name}`,
    `${line.count} dependenc${line.count === 1 ? "y" : "ies"}`,
    medium,
  ]
    .filter(Boolean)
    .join(" · ")
  const pairs = line.pairs
    .slice(0, 5)
    .map((p) => `${p.upstream.name} ${arrow} ${p.downstream.name}`)
  const more = line.count - pairs.length
  return [head, ...pairs, ...(more > 0 ? [`+${more} more`] : [])]
    .map(escapeTip)
    .join("<br>")
}

export function buildDependenciesLayer(
  lines: readonly SiteMapDependencyLine[]
): L.LayerGroup {
  const group = L.layerGroup()
  for (const line of lines) {
    const pts = dependencyPath(line)
    const color = line.medium?.color || UNKNOWN_SPEED_HEX
    const dash = DEPENDENCY_DASH[line.medium?.line_style ?? "solid"]
    const weight = line.kind === "sites" ? 2.5 : 2
    const stroke = L.polyline(pts, {
      color,
      weight,
      opacity: 0.85,
      dashArray: dash,
      interactive: false,
    })
    group.addLayer(stroke)
    const head = line.dependency_kind === "peer" ? null : chevron(pts)
    if (head)
      group.addLayer(
        L.polyline(head, {
          color,
          weight,
          opacity: 0.95,
          interactive: false,
        })
      )
    const hit = L.polyline(pts, {
      color,
      weight: 14,
      opacity: 0,
      interactive: true,
    })
    hit.bindTooltip(dependencyTip(line), { sticky: true, direction: "top" })
    hit.on("mouseover", () => stroke.setStyle({ weight: weight + 1.5 }))
    hit.on("mouseout", () => stroke.setStyle({ weight }))
    group.addLayer(hit)
  }
  return group
}
