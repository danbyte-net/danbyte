// The vector basemap (#467), loaded only when a map with a vector basemap
// mounts (map-core.ts imports it through importChunk). MapLibre draws the
// tiles into a Leaflet layer, under every existing overlay, and renders the
// "floor plan from map" capture offscreen.
//
// Nothing here turns tile data into HTML: the attribution is Danbyte's own
// setting (`customAttribution`), and MapLibre's own controls and popups are
// not used.

import L from "leaflet"
import * as maplibregl from "maplibre-gl"
import { MaplibreGL } from "@maplibre/maplibre-gl-leaflet"
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url"
import "maplibre-gl/dist/maplibre-gl.css"

import {
  buildVectorStyle,
  classifySource,
  relabelStyle,
  type LabelLanguage,
  type MapTheme,
  type VectorStyle,
} from "./vector-style"

// The worker is a hashed file of this build, served from Danbyte's origin
// (worker-src 'self'); MapLibre's own guess points next to a chunk that was
// renamed by the bundler.
maplibregl.setWorkerUrl(workerUrl)

export class VectorSourceError extends Error {
  constructor(message = "The vector tiles could not be loaded.") {
    super(message)
    this.name = "VectorSourceError"
  }
}

const sourceCache = new Map<string, Promise<unknown>>()

/** The TileJSON or style behind `url`, fetched once per page. */
function fetchSource(url: string): Promise<unknown> {
  let p = sourceCache.get(url)
  if (!p) {
    p = fetch(url, {
      credentials: "omit",
      referrerPolicy: "strict-origin-when-cross-origin",
    }).then((r) => {
      if (!r.ok) throw new VectorSourceError()
      return r.json()
    })
    p.catch(() => sourceCache.delete(url))
    sourceCache.set(url, p)
  }
  return p
}

/** The style to draw: the bundled one over a TileJSON's tiles, or a full
 * third-party style with its name labels in the chosen language. */
export async function resolveStyle({
  url,
  theme,
  labels,
  labelsOnly = false,
}: {
  url: string
  theme: MapTheme
  labels: LabelLanguage
  labelsOnly?: boolean
}): Promise<VectorStyle> {
  const got = classifySource(await fetchSource(url).catch(() => null))
  if (got.kind === "tilejson")
    return buildVectorStyle({ theme, source: got.source, labels, labelsOnly })
  if (got.kind === "style") {
    const style = relabelStyle(got.style, labels)
    return labelsOnly
      ? { ...style, layers: style.layers.filter((l) => l.type === "symbol") }
      : style
  }
  throw new VectorSourceError()
}

let fontsReady: Promise<unknown> | null = null
/** Load the label font's faces before MapLibre rasterises glyphs with it:
 * the @font-face subsets load lazily, and a glyph drawn before its face
 * arrives stays in the fallback font. */
function loadFonts(): Promise<unknown> {
  if (typeof document === "undefined" || !document.fonts?.load)
    return Promise.resolve()
  fontsReady ??= Promise.all(
    ["400", "600"].map((w) =>
      document.fonts
        .load(`${w} 16px "Inter Variable"`, "Aa ÆØÅ Ωω Жж ăđ")
        .catch(() => null)
    )
  )
  return fontsReady
}

export interface VectorLayerOptions {
  url: string
  attribution: string
  theme: MapTheme
  labels: LabelLanguage
  /** Labels only, over satellite imagery. */
  labelsOnly?: boolean
}

/**
 * Add the vector basemap to `map`. Rejects when the source can't be read
 * or WebGL can't start; `onFail` fires when it started but no tile ever
 * arrived (a CSP that blocks the tile host, or the worker) - the caller
 * then falls back to raster tiles.
 */
export async function addVectorLayer(
  map: L.Map,
  opts: VectorLayerOptions,
  onFail: (err: unknown) => void
): Promise<L.Layer> {
  const [style] = await Promise.all([resolveStyle(opts), loadFonts()])
  // Labels over satellite sit in a pane of their own, above the imagery and
  // under every overlay (overlayPane is 400).
  let pane = "tilePane"
  if (opts.labelsOnly) {
    pane = "smVectorLabels"
    if (!map.getPane(pane)) {
      const el = map.createPane(pane)
      el.style.zIndex = "250"
      el.style.pointerEvents = "none"
    }
  }
  const layer = new MaplibreGL({
    pane,
    style: style as maplibregl.StyleSpecification,
    // Danbyte's attribution setting, never the tile server's HTML.
    attributionControl: { customAttribution: opts.attribution },
    interactive: false,
    className: opts.labelsOnly ? "sm-vector-labels" : "sm-vector",
    localIdeographFontFamily: "sans-serif",
  } as L.LeafletMaplibreGLOptions)
  try {
    layer.addTo(map)
  } catch (err) {
    try {
      layer.remove()
    } catch {
      // half-added: nothing more to undo
    }
    throw err
  }
  const gl = layer.getMaplibreMap()
  let tiles = false
  gl.on("sourcedata", (e) => {
    if ((e as { tile?: unknown }).tile) tiles = true
  })
  gl.on("error", (e) => {
    if (!tiles) onFail(e.error ?? e)
  })
  return layer
}

/** A box rendered to an image at `width` × `height` pixels. Web Mercator
 * at 512-pixel tiles, as MapLibre counts zoom. */
export async function renderVectorBox({
  url,
  labels,
  bbox,
  width,
  height,
  timeoutMs = 30_000,
}: {
  url: string
  labels: LabelLanguage
  bbox: { south: number; west: number; north: number; east: number }
  width: number
  height: number
  timeoutMs?: number
}): Promise<HTMLCanvasElement> {
  const [style] = await Promise.all([
    resolveStyle({ url, theme: "light", labels }),
    loadFonts(),
  ])
  const mx = (lng: number) => (lng + 180) / 360
  const my = (lat: number) => {
    const phi =
      (Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI) / 180
    return (1 - Math.asinh(Math.tan(phi)) / Math.PI) / 2
  }
  const span = mx(bbox.east) - mx(bbox.west)
  const zoom = Math.log2(width / (span * 512))
  const cy = (my(bbox.north) + my(bbox.south)) / 2
  const center: [number, number] = [
    (mx(bbox.west) + span / 2) * 360 - 180,
    (Math.atan(Math.sinh(Math.PI * (1 - 2 * cy))) * 180) / Math.PI,
  ]
  const host = document.createElement("div")
  host.style.cssText = `position:fixed;left:-${width + 100}px;top:0;width:${width}px;height:${height}px;pointer-events:none`
  host.setAttribute("aria-hidden", "true")
  document.body.appendChild(host)
  let gl: maplibregl.Map | null = null
  try {
    gl = new maplibregl.Map({
      container: host,
      style: style as maplibregl.StyleSpecification,
      center,
      zoom,
      interactive: false,
      attributionControl: false,
      fadeDuration: 0,
      pixelRatio: 1,
      maxCanvasSize: [Math.max(width, 1), Math.max(height, 1)],
      // Read back after the frame is drawn.
      canvasContextAttributes: { preserveDrawingBuffer: true },
      localIdeographFontFamily: "sans-serif",
    })
    const m = gl
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(
        () => reject(new VectorSourceError()),
        timeoutMs
      )
      m.on("error", (e) => {
        window.clearTimeout(timer)
        reject(new VectorSourceError(String(e.error?.message ?? "")))
      })
      m.once("idle", () => {
        window.clearTimeout(timer)
        resolve()
      })
    })
    const out = document.createElement("canvas")
    out.width = width
    out.height = height
    const ctx = out.getContext("2d")
    if (!ctx) throw new VectorSourceError("This browser can't draw the map.")
    ctx.drawImage(m.getCanvas(), 0, 0, width, height)
    return out
  } finally {
    gl?.remove()
    host.remove()
  }
}
