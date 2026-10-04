import { xmlEscape } from "@/lib/xml"

import { fmt } from "./geometry"

// The few pieces of markup every SVG writer builds by hand - the topology's
// (svg.ts) and the rack and cabinet elevations' (lib/elevation/) - so they
// escape, round and embed fonts the same way, and survive the PDF sanitizer
// (api/svg_sanitize.py) the same way: attributes only, never `style=`.

export type Attrs = Record<string, string | number | undefined>

export const esc = xmlEscape

/** Attributes as markup, skipping undefined values; values escaped. */
export function attrs(a: Attrs): string {
  let s = ""
  for (const [k, v] of Object.entries(a)) {
    if (v === undefined) continue
    s += ` ${k}="${esc(typeof v === "number" ? fmt(v) : v)}"`
  }
  return s
}

export const el = (name: string, a: Attrs) => `<${name}${attrs(a)}/>`

export function text(s: string, a: Attrs): string {
  return `<text${attrs(a)}>${esc(s)}</text>`
}

/** A font face to embed as a `data:` URI - the PNG path needs it, because an
 * SVG drawn as an image cannot reach the page's web fonts. */
export interface EmbeddedFont {
  family: string
  /** `data:font/woff2;base64,…` */
  src: string
  /** CSS `font-weight`, e.g. `"100 900"` for the variable face. */
  weight?: string
  unicodeRange?: string
}

const FONT_SRC =
  /^data:(?:font\/woff2|application\/font-woff2);base64,[A-Za-z0-9+/=]+$/

/** `@font-face` rules for `fonts`, for a `<style>` in the drawing's
 * `<defs>`; a face whose source is not an inlined WOFF2 is left out. */
export function fontFaces(fonts: EmbeddedFont[]): string {
  return fonts
    .filter((f) => FONT_SRC.test(f.src))
    .map((f) => {
      const family = f.family.replace(/[^A-Za-z0-9 -]/g, "")
      const weight = /^\d{3}( \d{3})?$/.test(f.weight ?? "") ? f.weight : "400"
      const range = /^[U+0-9A-Fa-f?,\s-]+$/.test(f.unicodeRange ?? "")
        ? `;unicode-range:${f.unicodeRange}`
        : ""
      return (
        `@font-face{font-family:"${family}";font-style:normal;` +
        `font-weight:${weight};src:url(${f.src}) format("woff2")${range}}`
      )
    })
    .join("")
}

/** `2026-09-26T14:05:00Z` → `2026-09-26 14:05 UTC`. */
export function stamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, "0")
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`
  )
}
