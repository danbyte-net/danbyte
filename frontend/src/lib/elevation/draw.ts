import { fmt } from "@/lib/diagram/geometry"
import { attrs, el, esc, fontFaces } from "@/lib/diagram/markup"
import type { EmbeddedFont } from "@/lib/diagram/markup"
import { FONT_STACK, PRINT } from "@/lib/diagram/theme"

import type { InlinedPhoto } from "./photos"

// What the rack and cabinet drawings (rack-svg.ts, cabinet-svg.ts) share:
// the document around them, their photos as symbols, and the hatching of
// occupied space - all as plain shapes the PDF's sanitizer keeps
// (api/svg_sanitize.py): no patterns, no gradients, no opacity, no `style=`,
// every colour solid hex from the light print theme (lib/diagram/theme.ts),
// whatever theme the app is in.

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** Photos drawn by reference: each distinct one a `<symbol>` in the
 * drawing's `<defs>`, used by every device that shows it, so a type's photo
 * is in the file once however many devices of it there are. Ids are given
 * in the order the drawing first asks, so the output is deterministic. */
export class PhotoSymbols {
  private ids = new Map<string, string>()

  constructor(
    private readonly photos: ReadonlyMap<string, InlinedPhoto>,
    private readonly prefix: string
  ) {}

  /** The photo at `href` when it was inlined, else null - drawn without. */
  get(href: string | null | undefined): InlinedPhoto | null {
    return (href && this.photos.get(href)) || null
  }

  /** The symbol id for the inlined photo at `href`. */
  id(href: string): string {
    let id = this.ids.get(href)
    if (!id) {
      id = `${this.prefix}ph${this.ids.size}`
      this.ids.set(href, id)
    }
    return id
  }

  /** `<use>` of the photo at `href`, stretched over `box`. */
  use(href: string, box: Box, extra: Record<string, string> = {}): string {
    return el("use", {
      href: `#${this.id(href)}`,
      x: box.x,
      y: box.y,
      width: box.w,
      height: box.h,
      ...extra,
    })
  }

  /** The symbols the drawing used, for its `<defs>`. */
  defs(): string {
    return [...this.ids]
      .map(
        ([href, id]) =>
          `<symbol${attrs({ id, viewBox: "0 0 100 100", preserveAspectRatio: "none" })}>` +
          el("image", {
            width: 100,
            height: 100,
            preserveAspectRatio: "none",
            href: this.photos.get(href)!.src,
          }) +
          `</symbol>`
      )
      .join("")
  }
}

/** Points of `poly` (convex) on the side of the line `u - v = c` where
 * `keep` holds - one step of Sutherland-Hodgman. */
function clipDiagonal(
  poly: [number, number][],
  c: number,
  keep: (d: number) => boolean
): [number, number][] {
  const out: [number, number][] = []
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    const da = a[0] - a[1] - c
    const db = b[0] - b[1] - c
    const ina = keep(da)
    const inb = keep(db)
    if (ina) out.push(a)
    if (ina !== inb) {
      const t = da / (da - db)
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
    }
  }
  return out
}

/**
 * Diagonal stripes over `box`, as the elevation hatches space a device
 * takes from the other face: CSS's `repeating-linear-gradient(45deg, …)` -
 * a stripe `width` px wide every `period` px, running from top left to
 * bottom right - as one path of parallelograms cut to the box. No pattern
 * and no clip path, so it survives the sanitizer and costs one element.
 */
export function hatchPath(box: Box, period = 7, width = 2): string {
  const step = period * Math.SQRT2
  const band = width * Math.SQRT2
  const rect: [number, number][] = [
    [0, 0],
    [box.w, 0],
    [box.w, box.h],
    [0, box.h],
  ]
  const parts: string[] = []
  // u - v runs from -h (bottom left) to w (top right) across the box.
  for (let lo = -box.h + (step - band) / 2; lo < box.w; lo += step) {
    const hi = lo + band
    let poly = clipDiagonal(rect, lo, (d) => d >= 0)
    poly = clipDiagonal(poly, hi, (d) => d <= 0)
    if (poly.length < 3) continue
    parts.push(
      "M " +
        poly
          .map(([u, v]) => `${fmt(box.x + u)},${fmt(box.y + v)}`)
          .join(" L ") +
        " Z"
    )
  }
  return parts.join(" ")
}

/** The drawing's document: the root at `width`×`height` px, its title and
 * description, the fonts and symbols it embeds, white paper, then `body`. */
export function svgDocument({
  width,
  height,
  title,
  desc,
  defs = "",
  embedFont,
  body,
}: {
  width: number
  height: number
  title: string
  desc: string
  defs?: string
  embedFont?: EmbeddedFont[]
  body: string[]
}): string {
  const faces = embedFont?.length ? fontFaces(embedFont) : ""
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg"${attrs({
      width,
      height,
      viewBox: `0 0 ${fmt(width)} ${fmt(height)}`,
      role: "img",
      "font-family": FONT_STACK,
    })}>`,
    `<title>${esc(title)}</title>`,
    `<desc>${esc(desc)}</desc>`,
  ]
  if (faces || defs)
    out.push(`<defs>${faces ? `<style>${faces}</style>` : ""}${defs}</defs>`)
  out.push(el("rect", { x: 0, y: 0, width, height, fill: PRINT.paper }))
  out.push(...body, `</svg>`)
  return out.join("\n")
}
