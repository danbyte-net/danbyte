// A CAD drawing's colours against the floor it sits on. The renderer
// (api/cad_engine.py) writes the drawing's default colour - ACI 7 and
// near-black / near-white strokes - as `currentColor`, which the canvas
// draws in the theme's foreground. Every other colour is the drawing's own,
// kept as drawn unless it would be too faint on the floor: then only its
// lightness moves (darker on the light floor, lighter on the dark one) until
// it reads, so a yellow stays a yellow and two layers never swap colours.
// api/floor_plan_pdf.py does the same for paper, which is the light floor.

export type CadTheme = "light" | "dark"

/** The floor surface the drawing sits on: the canvas's `bg-background`
 * under `fill-muted/30`, per theme (styles.css tokens, as sRGB). */
export const CAD_SURFACE: Record<CadTheme, string> = {
  light: "#f8f8f9",
  dark: "#19191c",
}

/** WCAG's floor for graphics: lines and shapes need 3:1 to be seen. */
export const CAD_MIN_CONTRAST = 3

type Rgb = [number, number, number]

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i

export function parseHex(hex: string): Rgb | null {
  const m = HEX.exec(hex.trim())
  if (!m) return null
  let h = m[1]
  if (h.length === 3) h = [...h].map((c) => c + c).join("")
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb
}

const toHex = (rgb: Rgb) =>
  "#" +
  rgb
    .map((v) =>
      Math.round(Math.min(255, Math.max(0, v)))
        .toString(16)
        .padStart(2, "0")
    )
    .join("")

function luminance([r, g, b]: Rgb): number {
  const lin = (v: number) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

export function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

function toHsl([r, g, b]: Rgb): [number, number, number] {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0)
  else if (max === gn) h = (bn - rn) / d + 2
  else h = (rn - gn) / d + 4
  return [h / 6, s, l]
}

function fromHsl([h, s, l]: [number, number, number]): Rgb {
  if (s === 0) return [l * 255, l * 255, l * 255]
  const hue = (p: number, q: number, t: number) => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return [hue(p, q, h + 1 / 3), hue(p, q, h), hue(p, q, h - 1 / 3)].map(
    (v) => v * 255
  ) as Rgb
}

/**
 * `hex` as drawn when it has `min` contrast against `surface`; otherwise
 * the same hue and saturation at the nearest lightness that has it. Values
 * that are not plain hex colours (`none`, `currentColor`) pass through.
 */
export function contrastSafe(
  hex: string,
  surface: string,
  min = CAD_MIN_CONTRAST
): string {
  const rgb = parseHex(hex)
  const bg = parseHex(surface)
  if (!rgb || !bg) return hex
  if (contrast(rgb, bg) >= min) return hex.toLowerCase()
  const [h, s, l] = toHsl(rgb)
  const darker = luminance(bg) > 0.18
  let lo = darker ? 0 : l
  let hi = darker ? l : 1
  // Binary search for the lightness closest to the original that reads.
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2
    const ok = contrast(fromHsl([h, s, mid]), bg) >= min
    if (darker) {
      if (ok) lo = mid
      else hi = mid
    } else if (ok) hi = mid
    else lo = mid
  }
  return toHex(fromHsl([h, s, darker ? lo : hi]))
}

/** One mapping per colour and surface - a drawing repeats a few colours
 * many thousand times. */
export function colourMapper(surface: string): (value: string) => string {
  const seen = new Map<string, string>()
  return (value) => {
    let out = seen.get(value)
    if (out === undefined) {
      out = contrastSafe(value, surface)
      seen.set(value, out)
    }
    return out
  }
}

const PAINTS = ["stroke", "fill"] as const

/** Re-colour a drawing's elements in place for `theme`'s floor. */
export function themeCadColours(root: Element, theme: CadTheme): void {
  const map = colourMapper(CAD_SURFACE[theme])
  const walk = (el: Element) => {
    for (const attr of PAINTS) {
      const v = el.getAttribute(attr)
      if (v && v[0] === "#") el.setAttribute(attr, map(v))
    }
    for (const child of Array.from(el.children)) walk(child)
  }
  walk(root)
}

const PAINT_ATTR = /\b(stroke|fill)="(#[0-9a-fA-F]{3,6})"/g

/** The same for a drawing as text (the large-drawing image path): every
 * colour mapped, and the default colour set to the theme's foreground on
 * the root, since an `<image>` does not inherit the page's. */
export function themeCadSvgText(
  text: string,
  theme: CadTheme,
  foreground: string
): string {
  const map = colourMapper(CAD_SURFACE[theme])
  const coloured = text.replace(
    PAINT_ATTR,
    (_all, attr: string, hex: string) => `${attr}="${map(hex)}"`
  )
  return coloured.replace(/<svg\b([^>]*)>/, (_all, attrs: string) => {
    const rest = attrs.replace(/\scolor="[^"]*"/, "")
    return `<svg${rest} color="${foreground}">`
  })
}

/** The theme's foreground, as `currentColor` resolves on the canvas. */
export const CAD_FOREGROUND: Record<CadTheme, string> = {
  light: "#18181b",
  dark: "#fafafa",
}
