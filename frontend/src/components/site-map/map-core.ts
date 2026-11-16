import L from "leaflet"

import { importChunk } from "@/lib/lazy-chunk"

import type { SiteMapPayload } from "@/lib/api"

import type { LabelLanguage, MapTheme } from "./vector-style"

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

/** True when this browser can give MapLibre a WebGL context. Checked
 * before the vector chunk is even fetched. */
export function webglAvailable(): boolean {
  if (typeof document === "undefined") return false
  try {
    const c = document.createElement("canvas")
    return !!(c.getContext("webgl2") || c.getContext("webgl"))
  } catch {
    return false
  }
}

type VectorModule = typeof import("./vector-basemap")
let vectorModule: Promise<VectorModule> | null = null
/** The vector basemap chunk, fetched once, on the first map that needs it. */
export function loadVectorModule(): Promise<VectorModule> {
  vectorModule ??= importChunk(() => import("./vector-basemap"))
  vectorModule.catch(() => (vectorModule = null))
  return vectorModule
}

/** Why a vector basemap fell back to raster tiles, for the quiet note. */
export type VectorFallback = "webgl" | "source"

export interface BasemapConfig {
  /** Raster street tiles - the basemap itself, or the vector fallback. */
  raster: { url: string; attribution: string; className?: string }
  /** Set to draw vector tiles instead (or, with `labelsOnly`, over the
   * raster layer - satellite). */
  vector?: {
    url: string
    attribution: string
    labels: LabelLanguage
    theme: MapTheme
    labelsOnly?: boolean
  }
}

/** The payload's tile settings as one basemap: the street map (raster or
 * vector, per the deployment) or satellite, which keeps its imagery and
 * gets vector labels on top when the street map is vector. */
export function basemapConfig(
  tiles: SiteMapPayload["tiles"],
  which: "map" | "sat",
  theme: MapTheme
): BasemapConfig {
  const vector =
    tiles.basemap === "vector" && tiles.vector
      ? {
          url: tiles.vector.url,
          attribution: tiles.vector.attribution,
          labels: tiles.labels ?? "en",
          theme,
        }
      : undefined
  if (which === "sat")
    return {
      // Satellite imagery escapes the dark-mode tile filter.
      raster: { ...tiles.satellite, className: "" },
      vector: vector && { ...vector, labelsOnly: true },
    }
  return {
    raster: { url: tiles.url, attribution: tiles.attribution },
    vector,
  }
}

/**
 * The basemap for `map`: raster tiles, vector tiles, or satellite with a
 * vector label layer. Replaces whatever `ref` held. A vector basemap that
 * can't run (no WebGL, an unreadable source, tiles blocked) leaves the raster
 * tiles up and calls `onFallback`. Returns a cancel function for an effect
 * cleanup: a swap that lands after it is undone.
 */
export function setBasemap(
  map: L.Map,
  ref: { current: L.Layer[] },
  cfg: BasemapConfig,
  onFallback?: (why: VectorFallback) => void
): () => void {
  for (const l of ref.current) l.remove()
  ref.current = []
  let cancelled = false
  const raster = () => {
    const layer = L.tileLayer(cfg.raster.url, {
      attribution: cfg.raster.attribution,
      maxZoom: 19,
      className: cfg.raster.className ?? "sm-tiles",
      referrerPolicy: "strict-origin-when-cross-origin",
    })
    layer.addTo(map)
    ref.current.push(layer)
  }
  const vec = cfg.vector
  if (!vec) {
    raster()
    return () => {}
  }
  // Satellite keeps its imagery; the labels go on top.
  if (vec.labelsOnly) raster()
  if (!webglAvailable()) {
    if (!vec.labelsOnly) raster()
    onFallback?.("webgl")
    return () => {}
  }
  const fallBack = (why: VectorFallback) => {
    if (cancelled) return
    if (!vec.labelsOnly) {
      for (const l of ref.current) l.remove()
      ref.current = []
      raster()
    }
    onFallback?.(why)
  }
  let layer: L.Layer = L.layerGroup()
  loadVectorModule()
    .then((m) =>
      m.addVectorLayer(map, vec, () => {
        // Started, but no tile ever came: blocked or unreachable.
        const idx = ref.current.indexOf(layer)
        if (idx >= 0) ref.current.splice(idx, 1)
        layer.remove()
        fallBack("source")
      })
    )
    .then((l) => {
      layer = l
      if (cancelled) l.remove()
      else ref.current.push(l)
    })
    .catch((err: unknown) => {
      const gpu = err instanceof Error && err.name === "GPUInitializationError"
      fallBack(gpu ? "webgl" : "source")
    })
  return () => {
    cancelled = true
  }
}

/** Keep Leaflet's notion of the container size current. Leaflet only watches
 * window resizes, so a dashboard tile resized by the grid (or a collapsible
 * strip opening) left the map half-painted until something else nudged it. */
export function observeMapSize(map: L.Map, el: HTMLElement): () => void {
  const ro = new ResizeObserver(() => map.invalidateSize())
  ro.observe(el)
  return () => ro.disconnect()
}
