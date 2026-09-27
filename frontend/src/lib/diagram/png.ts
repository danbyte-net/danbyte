import interLatinExtUrl from "@fontsource-variable/inter/files/inter-latin-ext-wght-normal.woff2?url"
import interLatinUrl from "@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url"

import { toSvg } from "./svg"
import type { EmbeddedFont, SvgOptions } from "./svg"
import type { DiagramDocument } from "./types"

// PNG by rasterising the SVG writer's output: the image matches the SVG and
// PDF exactly, carries every card (not just the ones on screen), and is
// light-themed whatever the app theme. An SVG drawn as an image loads
// nothing external, so fonts and photos go in as `data:` URIs first - the
// CSP already allows `img-src blob: data:` and `font-src data:`.

/** Canvas area cap: Safari refuses a canvas above 4096² pixels (16.7M) and
 * silently draws nothing. */
export const MAX_PIXELS = 4096 * 4096
/** Longest side any browser rasterises reliably. */
export const MAX_SIDE = 16384

/** The pixel size for a `w`×`h` px drawing at `scale`, stepped down until
 * it fits the caps. `scale` in the result is what was actually used. */
export function rasterSize(
  w: number,
  h: number,
  scale = 2,
  maxPixels = MAX_PIXELS
): { width: number; height: number; scale: number } {
  let s = Math.max(0.01, scale)
  if (w * h * s * s > maxPixels) s = Math.sqrt(maxPixels / (w * h))
  if (Math.max(w, h) * s > MAX_SIDE) s = MAX_SIDE / Math.max(w, h)
  return {
    width: Math.max(1, Math.floor(w * s)),
    height: Math.max(1, Math.floor(h * s)),
    scale: s,
  }
}

const ROOT = /<svg\b[^>]*>/
const num = (tag: string, name: string) => {
  const m = new RegExp(`\\s${name}="([\\d.]+)"`).exec(tag)
  return m ? parseFloat(m[1]) : NaN
}

/** The root `width`/`height` of an SVG string, in px. */
export function svgSize(svg: string): { w: number; h: number } {
  const tag = ROOT.exec(svg)?.[0] ?? ""
  return { w: num(tag, "width"), h: num(tag, "height") }
}

/** The same SVG with its root drawn at `w`×`h` - the viewBox keeps the
 * drawing, so it rasterises at full resolution instead of being scaled up
 * from its natural size (Safari does the latter). */
function resized(svg: string, w: number, h: number): string {
  return svg.replace(ROOT, (tag) =>
    tag
      .replace(/\swidth="[^"]*"/, ` width="${w}"`)
      .replace(/\sheight="[^"]*"/, ` height="${h}"`)
  )
}

/** Bytes as base64, in chunks (a spread of a large array overflows the
 * call stack). */
export function base64(bytes: Uint8Array): string {
  let bin = ""
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

async function fetchDataUri(url: string, mime?: string): Promise<string> {
  const res = await fetch(url, { credentials: "same-origin" })
  if (!res.ok) throw new Error(`${res.status} fetching ${url}`)
  const blob = await res.blob()
  const bytes = new Uint8Array(await blob.arrayBuffer())
  return `data:${mime ?? (blob.type || "application/octet-stream")};base64,${base64(bytes)}`
}

// From @fontsource-variable/inter's own @font-face rules.
const LATIN =
  "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304," +
  "U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215," +
  "U+FEFF,U+FFFD"
const LATIN_EXT =
  "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304," +
  "U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB," +
  "U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF"

let interPromise: Promise<EmbeddedFont[]> | null = null

/** The app's Inter (variable, latin and latin-ext) as embeddable faces -
 * fetched once from the bundled files, then cached. */
export function interFonts(): Promise<EmbeddedFont[]> {
  interPromise ??= Promise.all([
    fetchDataUri(interLatinUrl, "font/woff2"),
    fetchDataUri(interLatinExtUrl, "font/woff2"),
  ]).then(
    ([latin, ext]) => [
      { family: "Inter", src: latin, weight: "100 900", unicodeRange: LATIN },
      { family: "Inter", src: ext, weight: "100 900", unicodeRange: LATIN_EXT },
    ],
    (err: unknown) => {
      interPromise = null
      throw err
    }
  )
  return interPromise
}

/** An image no wider than `maxW` px, redrawn smaller in a canvas; null
 * when it is already small enough or the browser cannot (no canvas). */
async function downscale(blob: Blob, maxW: number): Promise<Blob | null> {
  if (
    typeof createImageBitmap !== "function" ||
    typeof document === "undefined"
  )
    return null
  const bmp = await createImageBitmap(blob)
  try {
    if (!(bmp.width > maxW)) return null
    const w = Math.max(1, Math.round(maxW))
    const h = Math.max(1, Math.round((bmp.height * w) / bmp.width))
    const canvas = document.createElement("canvas")
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext("2d")
    if (!ctx) return null
    ctx.imageSmoothingQuality = "high"
    ctx.drawImage(bmp, 0, 0, w, h)
    // A JPEG photo stays JPEG; anything else keeps its transparency.
    const type = blob.type === "image/jpeg" ? "image/jpeg" : "image/png"
    return await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), type, 0.9)
    )
  } finally {
    bmp.close()
  }
}

/** A photo as a `data:` URI at most `maxW` px wide: an upload can be
 * 2000 px across and is drawn at 480. */
export async function photoDataUri(url: string, maxW: number): Promise<string> {
  const res = await fetch(url, { credentials: "same-origin" })
  if (!res.ok) throw new Error(`${res.status} fetching ${url}`)
  const blob = await res.blob()
  const out = (await downscale(blob, maxW).catch(() => null)) ?? blob
  const bytes = new Uint8Array(await out.arrayBuffer())
  return `data:${out.type || blob.type || "application/octet-stream"};base64,${base64(bytes)}`
}

export interface InlineOptions {
  /** Pixels kept per px the photo is drawn at (2: sharp in a 2x PNG). */
  scale?: number
}

/** The document with every photo inlined as a `data:` URI, downscaled to
 * the size it is drawn at. A photo that will not load is drawn as its
 * card instead - never an empty frame. */
export async function inlinePhotos(
  doc: DiagramDocument,
  opts: InlineOptions = {}
): Promise<DiagramDocument> {
  const widest = new Map<string, number>()
  for (const n of doc.nodes)
    if (n.photo && !n.photo.href.startsWith("data:"))
      widest.set(
        n.photo.href,
        Math.max(widest.get(n.photo.href) ?? 0, n.photo.w)
      )
  if (!widest.size) return doc
  const scale = opts.scale ?? 2
  const inlined = new Map<string, string | null>()
  await Promise.all(
    [...widest].map(async ([href, w]) => {
      inlined.set(
        href,
        await photoDataUri(href, Math.ceil(w * scale)).catch(() => null)
      )
    })
  )
  return {
    ...doc,
    nodes: doc.nodes.map((n) => {
      if (!n.photo || n.photo.href.startsWith("data:")) return n
      const href = inlined.get(n.photo.href)
      if (href) return { ...n, photo: { ...n.photo, href } }
      return { ...n, kind: "card" as const, photo: undefined }
    }),
  }
}

export interface PngOptions {
  /** Pixels per diagram px (2). Stepped down to fit `maxPixels`. */
  scale?: number
  maxPixels?: number
}

/** An SVG string rasterised to a PNG blob. Browser only. */
export async function svgToPng(
  svg: string,
  opts: PngOptions = {}
): Promise<Blob> {
  const { w, h } = svgSize(svg)
  if (!(w > 0 && h > 0)) throw new Error("SVG has no width and height")
  const size = rasterSize(w, h, opts.scale ?? 2, opts.maxPixels)
  const url = URL.createObjectURL(
    new Blob([resized(svg, size.width, size.height)], {
      type: "image/svg+xml;charset=utf-8",
    })
  )
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const canvas = document.createElement("canvas")
    canvas.width = size.width
    canvas.height = size.height
    const ctx = canvas.getContext("2d")
    if (!ctx) throw new Error("No 2D canvas")
    ctx.drawImage(img, 0, 0, size.width, size.height)
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("PNG encoding failed"))),
        "image/png"
      )
    )
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** A document straight to PNG: photos and Inter inlined, then rasterised.
 * Without the font (offline asset, blocked fetch) it still renders, on the
 * fallback stack. */
export async function diagramToPng(
  doc: DiagramDocument,
  opts: Omit<SvgOptions, "embedFont"> & PngOptions = {}
): Promise<Blob> {
  const [withPhotos, fonts] = await Promise.all([
    inlinePhotos(doc, { scale: opts.scale ?? 2 }),
    interFonts().catch(() => [] as EmbeddedFont[]),
  ])
  return svgToPng(toSvg(withPhotos, { ...opts, embedFont: fonts }), opts)
}
