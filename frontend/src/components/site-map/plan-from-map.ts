// "New floor plan from this view": the map box as a plan grid at true
// scale, and the view rendered into one image from the tile server.
//
// The map is Web Mercator. Across one view (a campus, at most 512 cells of
// at most 5 m) the projection's scale is taken as constant at the box's
// middle latitude: a metre on the map is cos(latitude) of one at the
// equator. The server (api/floor_plan_from_map.py) does the same sums and
// is the one that decides; this side snaps the box to whole cells, so the
// image it renders covers the grid exactly, and previews the grid.

import type { SiteMapOutline, SiteMapSite } from "@/lib/api"

export const EARTH_CIRCUMFERENCE_M = 40_075_016.686
export const MAX_GRID = 512
export const MIN_CELL_MM = 50
export const MAX_CELL_MM = 5000
const MAX_LAT = 85.05112878
/** The longest side of the rendered background, in pixels. */
export const MAX_IMAGE_EDGE = 4096
/** Tiles fetched for one render, at most. */
export const MAX_TILES = 400
const TILE = 256

export interface Bbox {
  south: number
  west: number
  north: number
  east: number
}

export const mercX = (lng: number) => (lng + 180) / 360
export function mercY(lat: number): number {
  const phi = (Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180
  return (1 - Math.asinh(Math.tan(phi)) / Math.PI) / 2
}
export const lngOf = (mx: number) => mx * 360 - 180
export const latOf = (my: number) =>
  (Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) * 180) / Math.PI

/** Metres per Mercator world-width unit at the box's middle latitude. */
export function metresPerUnit(b: Bbox): number {
  const mid = latOf((mercY(b.north) + mercY(b.south)) / 2)
  return EARTH_CIRCUMFERENCE_M * Math.cos((mid * Math.PI) / 180)
}

export interface PlanFrame {
  /** The box grown east and south to whole cells - what is rendered and
   * sent. */
  bbox: Bbox
  widthM: number
  heightM: number
  /** The cell size asked for, raised when the box needs more than 512
   * cells across. */
  cellMm: number
  gridWidth: number
  gridHeight: number
}

/** The grid for `b` at `cellMm`, or an error for a box too large for a
 * floor plan. */
export function planFrame(
  b: Bbox,
  cellMm: number
): PlanFrame | { error: string } {
  const per = metresPerUnit(b)
  const widthM = (mercX(b.east) - mercX(b.west)) * per
  const heightM = (mercY(b.south) - mercY(b.north)) * per
  if (!(widthM > 0 && heightM > 0)) return { error: "The area is empty." }
  const asked = Math.max(MIN_CELL_MM, Math.round(cellMm) || 1000)
  const cell = Math.max(
    asked,
    Math.ceil((Math.max(widthM, heightM) * 1000) / MAX_GRID)
  )
  if (cell > MAX_CELL_MM)
    return {
      error: `Too large for a floor plan: zoom in to ${(MAX_GRID * MAX_CELL_MM) / 1e6} km across or less.`,
    }
  const gridWidth = Math.max(1, Math.ceil((widthM * 1000) / cell - 1e-6))
  const gridHeight = Math.max(1, Math.ceil((heightM * 1000) / cell - 1e-6))
  const x0 = mercX(b.west)
  const y0 = mercY(b.north)
  const bbox: Bbox = {
    north: b.north,
    west: b.west,
    east: lngOf(x0 + (gridWidth * cell) / 1000 / per),
    south: latOf(y0 + (gridHeight * cell) / 1000 / per),
  }
  return {
    bbox,
    widthM: (gridWidth * cell) / 1000,
    heightM: (gridHeight * cell) / 1000,
    cellMm: cell,
    gridWidth,
    gridHeight,
  }
}

/** The box in world pixels at zoom `z` (256-pixel tiles). */
export function pixelBox(b: Bbox, z: number) {
  const n = TILE * 2 ** z
  return {
    x0: mercX(b.west) * n,
    y0: mercY(b.north) * n,
    x1: mercX(b.east) * n,
    y1: mercY(b.south) * n,
  }
}

/** The tile zoom to render at: the map's (whole) zoom, lowered until the
 * image fits `maxEdge` pixels a side. */
export function renderZoom(
  b: Bbox,
  mapZoom: number,
  maxZoom = 19,
  maxEdge = MAX_IMAGE_EDGE
): number {
  let z = Math.max(0, Math.min(maxZoom, Math.round(mapZoom)))
  while (z > 0) {
    const p = pixelBox(b, z)
    if (Math.max(p.x1 - p.x0, p.y1 - p.y0) <= maxEdge) break
    z--
  }
  return z
}

/** The tiles covering the box at `z`, each with where it lands in the
 * image. */
export function tilesFor(b: Bbox, z: number) {
  const p = pixelBox(b, z)
  const n = 2 ** z
  const out: { x: number; y: number; dx: number; dy: number }[] = []
  const tx0 = Math.floor(p.x0 / TILE)
  const tx1 = Math.floor((p.x1 - 1e-9) / TILE)
  const ty0 = Math.max(0, Math.floor(p.y0 / TILE))
  const ty1 = Math.min(n - 1, Math.floor((p.y1 - 1e-9) / TILE))
  for (let ty = ty0; ty <= ty1; ty++)
    for (let tx = tx0; tx <= tx1; tx++)
      out.push({
        x: ((tx % n) + n) % n,
        y: ty,
        dx: tx * TILE - p.x0,
        dy: ty * TILE - p.y0,
      })
  return {
    tiles: out,
    width: Math.max(1, Math.round(p.x1 - p.x0)),
    height: Math.max(1, Math.round(p.y1 - p.y0)),
  }
}

/** A tile URL from a `{z}/{x}/{y}` template (Leaflet's placeholders; `{s}`
 * takes the first subdomain, `{r}` stays plain resolution). */
export function tileUrl(template: string, z: number, x: number, y: number) {
  return template
    .replace(/\{z\}/g, String(z))
    .replace(/\{x\}/g, String(x))
    .replace(/\{y\}/g, String(y))
    .replace(/\{s\}/g, "a")
    .replace(/\{r\}/g, "")
}

/** A tile attribution as plain text, without the "Report a map issue"
 * link - a link, not a credit. */
export function plainAttribution(raw: string): string {
  const doc = new DOMParser().parseFromString(raw || "", "text/html")
  const text = doc.body.textContent
  return text
    .split("·")
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p && p.toLowerCase() !== "report a map issue")
    .join(" · ")
}

/** The site a plan of `b` most likely belongs to: the one with most
 * outlines (by their middle) and pins in the box; null when none is. */
export function defaultPlanSite(
  b: Bbox,
  sites: SiteMapSite[],
  outlines: SiteMapOutline[]
): string | null {
  const inBox = (lat: number, lng: number) =>
    lat >= b.south && lat <= b.north && lng >= b.west && lng <= b.east
  const score = new Map<string, number>()
  const bump = (id: string) => score.set(id, (score.get(id) ?? 0) + 1)
  for (const o of outlines) {
    const n = o.points.length || 1
    const lat = o.points.reduce((s, p) => s + p[0], 0) / n
    const lng = o.points.reduce((s, p) => s + p[1], 0) / n
    if (inBox(lat, lng)) bump(o.site_id)
  }
  for (const s of sites)
    if (
      s.latitude !== null &&
      s.longitude !== null &&
      inBox(Number(s.latitude), Number(s.longitude))
    )
      bump(s.id)
  let best: string | null = null
  for (const [id, n] of score)
    if (best === null || n > (score.get(best) ?? 0)) best = id
  return best
}

// ── rendering ─────────────────────────────────────────────────────────────

/** The browser could not read the tiles: unreachable, or a tile server
 * that does not allow reading them (CORS). */
export class TileReadError extends Error {
  constructor(message = "The map tiles could not be read.") {
    super(message)
    this.name = "TileReadError"
  }
}

type TileImage = CanvasImageSource

function loadTile(url: string, timeoutMs = 15_000): Promise<TileImage> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    // Read back from a canvas only works for tiles served with CORS; this
    // asks for them so, and a server that won't fails the load instead of
    // tainting the canvas.
    img.crossOrigin = "anonymous"
    img.referrerPolicy = "strict-origin-when-cross-origin"
    const timer = window.setTimeout(() => {
      img.src = ""
      reject(new TileReadError())
    }, timeoutMs)
    img.onload = () => {
      window.clearTimeout(timer)
      resolve(img)
    }
    img.onerror = () => {
      window.clearTimeout(timer)
      reject(new TileReadError())
    }
    img.src = url
  })
}

/**
 * Render `b` from the tile server into one image: the tiles at
 * `renderZoom`, cropped to the box, with the attribution in the bottom
 * right corner. Rejects with `TileReadError` when any tile can't be read.
 */
export async function renderMapImage({
  bbox,
  mapZoom,
  template,
  attribution,
  jpeg = false,
  load = loadTile,
}: {
  bbox: Bbox
  mapZoom: number
  template: string
  attribution: string
  /** Satellite imagery compresses far better as JPEG. */
  jpeg?: boolean
  load?: (url: string) => Promise<TileImage>
}): Promise<{ blob: Blob; zoom: number; width: number; height: number }> {
  const zoom = renderZoom(bbox, mapZoom)
  const { tiles, width, height } = tilesFor(bbox, zoom)
  if (tiles.length > MAX_TILES) throw new TileReadError("Too many tiles.")
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new TileReadError("This browser can't draw the map.")
  const once = async (url: string) => {
    try {
      return await load(url)
    } catch {
      // One retry for a dropped request; a second failure is the tiles'.
      return await load(url).catch(() => {
        throw new TileReadError()
      })
    }
  }
  // A few at a time, like the map itself loads them.
  let next = 0
  const worker = async () => {
    while (next < tiles.length) {
      const t = tiles[next++]
      const img = await once(tileUrl(template, zoom, t.x, t.y))
      ctx.drawImage(img, Math.round(t.dx), Math.round(t.dy), TILE, TILE)
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker))
  const text = plainAttribution(attribution)
  if (text) {
    const size = Math.max(11, Math.round(width / 160))
    ctx.font = `${size}px sans-serif`
    const pad = Math.round(size / 3)
    const w = ctx.measureText(text).width + pad * 2
    ctx.fillStyle = "rgba(255,255,255,0.8)"
    ctx.fillRect(width - w, height - size - pad * 2, w, size + pad * 2)
    ctx.fillStyle = "#18181b"
    ctx.textBaseline = "bottom"
    ctx.fillText(text, width - w + pad, height - pad)
  }
  let blob: Blob | null
  try {
    blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, jpeg ? "image/jpeg" : "image/png", 0.9)
    )
  } catch {
    // A tainted canvas: a tile that came without CORS after all.
    throw new TileReadError()
  }
  if (!blob) throw new TileReadError()
  return { blob, zoom, width, height }
}
