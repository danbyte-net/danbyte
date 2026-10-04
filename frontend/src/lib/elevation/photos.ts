import { base64 } from "@/lib/diagram/png"

// The photos a rack or cabinet drawing embeds, so its file stands alone: each
// device-type photo fetched once through the media URL the API gives, drawn
// smaller in a canvas when it is wider than it is drawn (twice that, for a
// sharp 2x PNG), and inlined as a `data:` URI of a PNG, JPEG or WebP - the
// formats the PDF's sanitizer reads (api/svg_sanitize.py). Its pixel size is
// read from its own bytes, so a calibrated photo can be placed at its true
// size. Together they stay under a budget that keeps the PDF's request under
// the server's 10 MB.

/** A photo as the drawing embeds it. */
export interface InlinedPhoto {
  /** `data:image/(png|jpeg|webp);base64,…` */
  src: string
  /** Its height over its width. */
  aspect: number
}

export interface InlineResult {
  /** By the URL the device rows name. */
  photos: Map<string, InlinedPhoto>
  /** Photos asked for that would not load, or did not fit the budget. */
  missing: number
}

/** All of a drawing's photos, in characters of their `data:` URIs. */
export const PHOTO_BUDGET = 6 * 1024 * 1024
/** One photo at most: the sanitizer's caps. */
export const MAX_PHOTO_BYTES = 3 * 1024 * 1024
export const MAX_PHOTO_PIXELS = 6000 * 6000

export type ImageKind = "png" | "jpeg" | "webp" | "gif"

export interface ImageSize {
  kind: ImageKind
  width: number
  height: number
}

const be16 = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1]
const be32 = (b: Uint8Array, i: number) =>
  ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0
const le16 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8)
const le24 = (b: Uint8Array, i: number) =>
  b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)
const ascii = (b: Uint8Array, i: number, n: number) =>
  String.fromCharCode(...b.subarray(i, i + n))

/** An image's format and pixel size, read from its header; null for a
 * format the drawing cannot embed or bytes that are not an image. */
export function imageSize(b: Uint8Array): ImageSize | null {
  if (b.length >= 24 && be32(b, 0) === 0x89504e47 && ascii(b, 12, 4) === "IHDR")
    return { kind: "png", width: be32(b, 16), height: be32(b, 20) }
  if (b.length >= 10 && ascii(b, 0, 4) === "GIF8")
    return { kind: "gif", width: le16(b, 6), height: le16(b, 8) }
  if (
    b.length >= 30 &&
    ascii(b, 0, 4) === "RIFF" &&
    ascii(b, 8, 4) === "WEBP"
  ) {
    const chunk = ascii(b, 12, 4)
    if (chunk === "VP8 ")
      return {
        kind: "webp",
        width: le16(b, 26) & 0x3fff,
        height: le16(b, 28) & 0x3fff,
      }
    if (chunk === "VP8L")
      return {
        kind: "webp",
        width: 1 + (((b[22] & 0x3f) << 8) | b[21]),
        height: 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | (b[22] >> 6)),
      }
    if (chunk === "VP8X")
      return { kind: "webp", width: 1 + le24(b, 24), height: 1 + le24(b, 27) }
    return null
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    // JPEG: walk the segments to the frame header.
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null
      const marker = b[i + 1]
      if (marker === 0xff) {
        i++
        continue
      }
      const sof =
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      if (sof)
        return { kind: "jpeg", width: be16(b, i + 7), height: be16(b, i + 5) }
      i += 2 + be16(b, i + 2)
    }
  }
  return null
}

/** An image drawn `width` px wide in a canvas and encoded as `type`; null
 * where the browser cannot (no canvas: tests, old engines). */
async function redraw(
  blob: Blob,
  width: number,
  type: "image/png" | "image/jpeg"
): Promise<Uint8Array | null> {
  if (
    typeof createImageBitmap !== "function" ||
    typeof document === "undefined"
  )
    return null
  const bmp = await createImageBitmap(blob)
  try {
    const w = Math.max(1, Math.round(width))
    const h = Math.max(1, Math.round((bmp.height * w) / bmp.width))
    const canvas = document.createElement("canvas")
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext("2d")
    if (!ctx) return null
    ctx.imageSmoothingQuality = "high"
    ctx.drawImage(bmp, 0, 0, w, h)
    const out = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), type, 0.9)
    )
    return out ? new Uint8Array(await out.arrayBuffer()) : null
  } finally {
    bmp.close()
  }
}

interface Loaded {
  blob: Blob
  bytes: Uint8Array
  size: ImageSize
}

/** A photo's bytes, asked for again once when the first try fails (a
 * network blip mid-export); null when it will not load or is no image. */
async function load(href: string): Promise<Loaded | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (attempt) await new Promise((r) => setTimeout(r, 250))
      const res = await fetch(href, { credentials: "same-origin" })
      if (!res.ok) continue
      const blob = await res.blob()
      const bytes = new Uint8Array(await blob.arrayBuffer())
      const size = imageSize(bytes)
      if (!size || size.width <= 0 || size.height <= 0) return null
      return { blob, bytes, size }
    } catch {
      /* tried again, then given up */
    }
  }
  return null
}

/** The photo as embedded: at most `maxW` px wide, in a format the
 * sanitizer reads, within its caps; null when it cannot be. */
async function embed(p: Loaded, maxW: number): Promise<InlinedPhoto | null> {
  const aspect = p.size.height / p.size.width
  let bytes = p.bytes
  let size: ImageSize | null = p.size
  if (p.size.kind === "gif" || p.size.width > maxW) {
    const type = p.size.kind === "jpeg" ? "image/jpeg" : "image/png"
    const redrawn = await redraw(
      p.blob,
      Math.min(p.size.width, maxW),
      type
    ).catch(() => null)
    if (redrawn) {
      bytes = redrawn
      size = imageSize(redrawn)
    }
  }
  if (!size || size.kind === "gif") return null
  if (
    bytes.length > MAX_PHOTO_BYTES ||
    size.width * size.height > MAX_PHOTO_PIXELS
  )
    return null
  return { src: `data:image/${size.kind};base64,${base64(bytes)}`, aspect }
}

/**
 * The photos at `requests` - each URL with the widest it is drawn, px -
 * inlined at `scale` pixels per px drawn (2). Over `budget` they are drawn
 * again at one pixel per px, and where that is still too much the largest
 * are left out; `missing` counts them with the ones that would not load.
 */
export async function inlinePhotos(
  requests: ReadonlyMap<string, number>,
  { scale = 2, budget = PHOTO_BUDGET }: { scale?: number; budget?: number } = {}
): Promise<InlineResult> {
  const loaded = new Map<string, Loaded>()
  await Promise.all(
    [...requests.keys()].map(async (href) => {
      const p = await load(href)
      if (p) loaded.set(href, p)
    })
  )
  const embedAll = async (s: number) => {
    const out = new Map<string, InlinedPhoto>()
    await Promise.all(
      [...loaded].map(async ([href, p]) => {
        const maxW = Math.ceil((requests.get(href) ?? p.size.width) * s)
        const photo = await embed(p, Math.max(1, maxW))
        if (photo) out.set(href, photo)
      })
    )
    return out
  }
  const total = (m: Map<string, InlinedPhoto>) =>
    [...m.values()].reduce((n, p) => n + p.src.length, 0)

  let photos = await embedAll(scale)
  if (total(photos) > budget && scale > 1) photos = await embedAll(1)
  let sum = total(photos)
  for (const [href, p] of [...photos].sort(
    (a, b) => b[1].src.length - a[1].src.length || (a[0] < b[0] ? -1 : 1)
  )) {
    if (sum <= budget) break
    photos.delete(href)
    sum -= p.src.length
  }
  return { photos, missing: requests.size - photos.size }
}
