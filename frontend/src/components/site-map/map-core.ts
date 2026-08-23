import L from "leaflet"

// Shared Leaflet plumbing for the full site map and the MiniMap. Anything
// both need lives here so the two can't drift apart again. (The z-tier
// function and status palette live in ./status-colors, which stays
// leaflet-free so tests and sidebars can import it.)

export { markerZ, type MarkerKind } from "./status-colors"

/** Zoom thresholds below which name chips hide (hover/selection always show).
 * Site names carry from far out; device names only matter once you're close
 * enough that they wouldn't shingle over each other. */
// Site names show at EVERY zoom while the Labels toggle is on - the map is
// an estate overview, and its site names are the point. Devices wait until
// a site roughly fills the screen.
export const LABEL_ZOOM = { sites: 0, devices: 12 } as const

/** Swap the basemap in place. Always removes the previous layer first - the
 * MiniMap once keyed this on the payload object and stacked a new tile layer
 * (and attribution line) on every refetch. `className: ""` is meaningful:
 * satellite imagery passes it to escape the dark-mode tile filter. */
export function setBaseLayer(
  map: L.Map,
  ref: { current: L.TileLayer | null },
  cfg: { url: string; attribution: string; className?: string }
): L.TileLayer {
  ref.current?.remove()
  const layer = L.tileLayer(cfg.url, {
    attribution: cfg.attribution,
    maxZoom: 19,
    className: cfg.className ?? "sm-tiles",
    referrerPolicy: "strict-origin-when-cross-origin",
  })
  layer.addTo(map)
  ref.current = layer
  return layer
}

/** Keep Leaflet's notion of the container size current. Leaflet only watches
 * window resizes, so a dashboard tile resized by the grid (or a collapsible
 * strip opening) left the map half-painted until something else nudged it. */
export function observeMapSize(map: L.Map, el: HTMLElement): () => void {
  const ro = new ResizeObserver(() => map.invalidateSize())
  ro.observe(el)
  return () => ro.disconnect()
}
