import L from "leaflet"
import "leaflet.markercluster"
// Structural CSS only (cluster animation transitions). The Default.css with
// the green/yellow blobs is deliberately never imported - the chip below is
// 100% our own styling.
import "leaflet.markercluster/dist/MarkerCluster.css"

import {
  CHECK_COLOR,
  dominantColor,
  worstCheck,
  type MarkerKind,
} from "./status-colors"

// Close-marker handling (issue #32): markers that genuinely collide collapse
// into a themed cluster chip; clicking zooms to its bounds, and at max zoom
// identical coordinates spiderfy so every marker becomes clickable. Clustering
// is view-mode only - edit modes keep the flat group so dragging/placement
// stay untouched.

/** Per-marker metadata the cluster chip aggregates. */
export interface SmMeta {
  kind: MarkerKind
  check: string | null
  /** Site color (sites only) - the chip border takes the dominant one. */
  color?: string
}

type MetaOptions = L.MarkerOptions & { smMeta?: SmMeta }

export function tagMarker(m: L.Marker, meta: SmMeta): void {
  ;(m.options as MetaOptions).smMeta = meta
}

function clusterIcon(cluster: L.MarkerCluster, mini: boolean): L.DivIcon {
  const metas = cluster
    .getAllChildMarkers()
    .map((m) => (m.options as MetaOptions).smMeta)
    .filter((x): x is SmMeta => !!x)
  const worst = worstCheck(metas.map((x) => x.check))
  const color = dominantColor(
    metas.filter((x) => x.kind === "site").map((x) => x.color)
  )
  // The health dot is the honest signal (worst child status); the dominant
  // color is border-only so a mixed cluster can't masquerade as one site.
  const health =
    worst && worst !== "up" && worst !== "unknown"
      ? `<span class="sm-cluster-health" style="background:${
          CHECK_COLOR[worst] ?? CHECK_COLOR.unknown
        }"></span>`
      : ""
  const size = mini ? 24 : 28
  return L.divIcon({
    className: "sm-marker",
    html:
      `<span class="sm-cluster${mini ? " sm-cluster-mini" : ""}"` +
      `${color ? ` style="border-color:${color}"` : ""}>` +
      `${cluster.getChildCount()}${health}</span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  })
}

/** A marker container: clustered in view mode, a plain LayerGroup otherwise.
 * Both share the addLayer surface, so the redraw loop doesn't care which. */
export function createMarkerGroup(opts: {
  cluster: boolean
  mini?: boolean
  radius?: number
}): L.LayerGroup {
  if (!opts.cluster) return L.layerGroup()
  return L.markerClusterGroup({
    // Small radius: engage only on genuine collision, not mere proximity.
    maxClusterRadius: opts.radius ?? 44,
    spiderfyOnMaxZoom: true,
    zoomToBoundsOnClick: true,
    showCoverageOnHover: false,
    removeOutsideVisibleBounds: true,
    // SVG strokes can't resolve CSS variables - literal zinc-400.
    spiderLegPolylineOptions: { color: "#a1a1aa", weight: 1.5, opacity: 0.6 },
    iconCreateFunction: (c) => clusterIcon(c, opts.mini ?? false),
  })
}

/** Zoom/spiderfy until the marker is actually visible (deep links, search,
 * sidebar picks into a cluster). No-op on a plain group. */
export function zoomToRevealMarker(
  group: L.LayerGroup,
  marker: L.Marker,
  done?: () => void
): void {
  const g = group as L.LayerGroup & {
    zoomToShowLayer?: (m: L.Marker, cb?: () => void) => void
  }
  if (typeof g.zoomToShowLayer === "function") g.zoomToShowLayer(marker, done)
  else done?.()
}
