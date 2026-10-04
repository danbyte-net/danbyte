import cyrillicExt from "@fontsource-variable/inter/files/inter-cyrillic-ext-wght-normal.woff2?url"
import cyrillic from "@fontsource-variable/inter/files/inter-cyrillic-wght-normal.woff2?url"
import greekExt from "@fontsource-variable/inter/files/inter-greek-ext-wght-normal.woff2?url"
import greek from "@fontsource-variable/inter/files/inter-greek-wght-normal.woff2?url"
import latinExt from "@fontsource-variable/inter/files/inter-latin-ext-wght-normal.woff2?url"
import latin from "@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url"
import vietnamese from "@fontsource-variable/inter/files/inter-vietnamese-wght-normal.woff2?url"

import { canvasWidth } from "./measure"
import type { Measure } from "./measure"

// Text measurement in a worker, where the page's fonts are not loaded and
// there is no document: Inter is loaded into the worker from the same
// files the app's stylesheet uses (@fontsource-variable/inter, same
// subsets and ranges) and measured on an OffscreenCanvas - the same font
// and the same text engine as the page's canvas (`measureText`), so a
// diagram laid out here matches one laid out on the page.

/** Inter's subsets as the stylesheet declares them. */
const FACES: [string, string][] = [
  [
    cyrillicExt,
    "U+0460-052F,U+1C80-1C8A,U+20B4,U+2DE0-2DFF,U+A640-A69F,U+FE2E-FE2F",
  ],
  [cyrillic, "U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116"],
  [greekExt, "U+1F00-1FFF"],
  [greek, "U+0370-0377,U+037A-037F,U+0384-038A,U+038C,U+038E-03A1,U+03A3-03FF"],
  [
    vietnamese,
    "U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1," +
      "U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329," +
      "U+1EA0-1EF9,U+20AB",
  ],
  [
    latinExt,
    "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304," +
      "U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020," +
      "U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF",
  ],
  [
    latin,
    "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC," +
      "U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193," +
      "U+2212,U+2215,U+FEFF,U+FFFD",
  ],
]

/**
 * A measure backed by Inter on an OffscreenCanvas, once the font has
 * loaded in this worker; null where the worker has no OffscreenCanvas or
 * font loading, or Inter does not load within `wait` ms - the caller then
 * measures with `approxMeasure`.
 */
export async function offscreenMeasure(wait = 5000): Promise<Measure | null> {
  const fonts = (globalThis as { fonts?: FontFaceSet }).fonts
  if (
    typeof OffscreenCanvas === "undefined" ||
    typeof FontFace === "undefined" ||
    !fonts
  )
    return null
  const ctx = new OffscreenCanvas(1, 1).getContext("2d")
  if (!ctx) return null
  try {
    const faces = FACES.map(
      ([url, unicodeRange]) =>
        new FontFace(
          "Inter Variable",
          `url(${url}) format("woff2-variations")`,
          { weight: "100 900", style: "normal", unicodeRange }
        )
    )
    for (const face of faces) fonts.add(face)
    let timer: ReturnType<typeof setTimeout> | undefined
    const loaded = await Promise.race([
      Promise.all(faces.map((f) => f.load())).then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), wait)
      }),
    ])
    clearTimeout(timer)
    if (!loaded) return null
  } catch {
    return null
  }
  const cache = new Map<string, number>()
  return (text, size, weight = 400, exact = false) => {
    const key = `${weight}|${size}|${exact ? 1 : 0}|${text}`
    let w = cache.get(key)
    if (w === undefined) {
      w = canvasWidth(ctx, text, size, weight, exact)
      cache.set(key, w)
    }
    return w
  }
}
