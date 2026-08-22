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

// ── Stacking preference ─────────────────────────────────────────────────────
// Stacking (clustering) is the default; turning it off swaps collision
// handling to DENSITY SCALING - markers shrink when they'd collide, so every
// site stays individually visible. Shared by the full map and every mini map.
const STACKING_KEY = "site-map:stacking"

export function stackingEnabled(): boolean {
  try {
    return localStorage.getItem(STACKING_KEY) !== "off"
  } catch {
    return true
  }
}

export function setStackingEnabled(v: boolean): void {
  try {
    localStorage.setItem(STACKING_KEY, v ? "on" : "off")
  } catch {
    /* private mode - session-only */
  }
}

/**
 * Density scaling for unstacked maps: each marker shrinks by how crowded its
 * neighbourhood is on screen, down to 45%, so colliding markers stay apart
 * without collapsing into a chip. Recomputed per zoom. Returns a cleanup.
 */
export function applyDensityScaling(map: L.Map, markers: L.Marker[]): () => void {
  const BASE = 44 // px at which two markers are considered comfortable
  const rescale = () => {
    const pts = markers.map((m) => map.latLngToContainerPoint(m.getLatLng()))
    markers.forEach((m, i) => {
      let nearest = Infinity
      for (let j = 0; j < pts.length; j++) {
        if (j === i) continue
        const d = pts[i].distanceTo(pts[j])
        if (d < nearest) nearest = d
      }
      const f = Math.max(0.45, Math.min(1, nearest / BASE))
      const root = m.getElement()
      if (!root) return
      // Scale ONE wrapper holding the whole icon - pin, health dot, label -
      // never a single child (a full-size status dot beside a shrunken pin
      // reads as a different marker entirely).
      let wrap = root.querySelector<HTMLElement>(":scope > .sm-scale")
      if (!wrap) {
        wrap = document.createElement("span")
        wrap.className = "sm-scale"
        wrap.style.display = "block"
        wrap.style.width = "100%"
        wrap.style.height = "100%"
        while (root.firstChild) wrap.appendChild(root.firstChild)
        root.appendChild(wrap)
      }
      wrap.style.transformOrigin = "center"
      wrap.style.transform = f < 1 ? `scale(${f.toFixed(2)})` : ""
    })
  }
  map.on("zoomend", rescale)
  // First pass after the icons exist in the DOM.
  requestAnimationFrame(rescale)
  return () => map.off("zoomend", rescale)
}
