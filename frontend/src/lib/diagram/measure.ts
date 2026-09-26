// Text measurement for diagram layout. Card sizes, truncation and label
// boxes are computed in code rather than read back from the DOM (offscreen
// cards are never mounted), so the screen, the SVG, PNG and PDF exports and
// the draw.io file all lay text out from the same numbers.
//
// In a browser the widths come from a 2D canvas once the app font (Inter)
// has loaded. Everywhere else - SSR, jsdom, vitest - and until the font is
// ready they come from Inter's own advance widths, embedded below, which is
// deterministic and within a few percent of the canvas (no kerning, so it
// errs on the wide side and never clips).

export type Weight = 400 | 500 | 600 | 700

/** Width in px of `text` set at `size` px and `weight`. */
export type Measure = (text: string, size: number, weight?: Weight) => number

/** The family the canvas measures - the app font from `styles.css`. */
export const DIAGRAM_FONT = '"Inter Variable", Inter, sans-serif'

/** Inter's vertical metrics as fractions of the em (hhea ascender and
 * descender, units per em 2048). */
export const INTER_ASCENT = 1984 / 2048
export const INTER_DESCENT = 494 / 2048

/** The baseline of a single-line box of line height `lh` starting at
 * `top`, as CSS places it: half the leading above the content area. */
export function baselineAt(top: number, size: number, lh: number): number {
  const content = (INTER_ASCENT + INTER_DESCENT) * size
  return top + (lh - content) / 2 + INTER_ASCENT * size
}

// Advance widths (units of 1/2048 em) of printable ASCII, U+0020..U+007E,
// read from the bundled @fontsource-variable/inter latin file at wght 400
// and 700. The axis is linear in between.
const W400 = [
  576, 589, 954, 1297, 1314, 2011, 1319, 614, 747, 747, 1026, 1355, 590, 942,
  590, 738, 1292, 833, 1249, 1265, 1323, 1215, 1270, 1159, 1267, 1270, 590, 618,
  1355, 1355, 1355, 1047, 1978, 1413, 1340, 1496, 1478, 1231, 1209, 1528, 1522,
  550, 1169, 1376, 1158, 1850, 1543, 1566, 1308, 1566, 1318, 1314, 1322, 1524,
  1413, 2018, 1397, 1390, 1288, 747, 738, 747, 965, 934, 661, 1150, 1254, 1170,
  1254, 1194, 758, 1256, 1211, 496, 496, 1124, 496, 1794, 1210, 1228, 1254,
  1254, 771, 1081, 670, 1211, 1151, 1676, 1118, 1151, 1131, 873, 681, 873, 1355,
]
const W700 = [
  485, 692, 1129, 1329, 1341, 2080, 1376, 694, 772, 772, 1145, 1390, 684, 958,
  684, 795, 1381, 883, 1289, 1322, 1385, 1274, 1330, 1191, 1333, 1330, 684, 702,
  1390, 1390, 1390, 1146, 2081, 1529, 1355, 1515, 1479, 1244, 1202, 1537, 1530,
  575, 1197, 1473, 1158, 1908, 1561, 1578, 1327, 1591, 1345, 1341, 1367, 1499,
  1529, 2125, 1512, 1497, 1360, 772, 795, 772, 997, 975, 748, 1189, 1291, 1205,
  1291, 1220, 815, 1294, 1275, 555, 555, 1188, 555, 1869, 1275, 1256, 1291,
  1291, 834, 1147, 750, 1275, 1228, 1741, 1188, 1233, 1173, 960, 761, 960, 1390,
]
/** "…" and "·", which the diagram writes itself. */
const EXTRA: Partial<Record<string, [number, number]>> = {
  "…": [1770, 2052],
  "·": [590, 684],
}
/** A letter outside the table (after stripping accents): a wide lowercase
 * letter, so the estimate stays on the safe side. */
const OTHER: [number, number] = [1256, 1294]

function advance(ch: string, t: number): number {
  const c = ch.charCodeAt(0)
  let pair: [number, number]
  if (c >= 32 && c <= 126) pair = [W400[c - 32], W700[c - 32]]
  else {
    const base = ch.normalize("NFD").charAt(0)
    const b = base.charCodeAt(0)
    pair =
      EXTRA[ch] ??
      (b >= 32 && b <= 126 && base !== ch
        ? [W400[b - 32], W700[b - 32]]
        : OTHER)
  }
  return pair[0] + (pair[1] - pair[0]) * t
}

/** Deterministic width from Inter's advance-width table - no DOM needed. */
export const approxMeasure: Measure = (text, size, weight = 400) => {
  const t = (Math.min(700, Math.max(400, weight)) - 400) / 300
  let units = 0
  for (const ch of text) units += advance(ch, t)
  return (units / 2048) * size
}

// ── Canvas ──────────────────────────────────────────────────────────────────

let ctx: CanvasRenderingContext2D | null | undefined
const ready = new Set<Weight>()
/** Some text was measured with the estimate while a canvas could have
 * measured it once Inter loads. */
let estimated = false
const loading = new Set<Weight>()
const cache = new Map<string, number>()

function fontSpec(size: number, weight: Weight): string {
  return `${weight} ${size}px ${DIAGRAM_FONT}`
}

/** A 2D context to measure with, or null where there is none. jsdom has a
 * canvas element without a context and reports each attempt as an error, so
 * it is recognised by its user agent and never asked. */
function context(): CanvasRenderingContext2D | null {
  if (ctx !== undefined) return ctx
  ctx = null
  if (typeof document === "undefined") return ctx
  if (typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent))
    return ctx
  try {
    ctx = document.createElement("canvas").getContext("2d")
  } catch {
    ctx = null
  }
  return ctx
}

/** Whether the app font is loaded at this weight; starts loading it when
 * it isn't. Until then the canvas would measure a fallback font. */
function fontReady(weight: Weight): boolean {
  if (ready.has(weight)) return true
  const fonts = typeof document !== "undefined" ? document.fonts : undefined
  if (!fonts) return false
  const spec = fontSpec(12, weight)
  if (fonts.check(spec)) {
    ready.add(weight)
    return true
  }
  if (!loading.has(weight)) {
    loading.add(weight)
    fonts.load(spec).then(
      () => {
        if (fonts.check(spec)) ready.add(weight)
      },
      () => undefined
    )
  }
  return false
}

/**
 * The measure the diagram uses: the canvas when there is one and Inter has
 * loaded at that weight, else `approxMeasure`. Canvas results are cached.
 */
export const measureText: Measure = (text, size, weight = 400) => {
  const c = context()
  if (!c) return approxMeasure(text, size, weight)
  if (!fontReady(weight)) {
    estimated = true
    return approxMeasure(text, size, weight)
  }
  const key = `${weight}|${size}|${text}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  c.font = fontSpec(size, weight)
  const w = c.measureText(text).width
  cache.set(key, w)
  return w
}

/** Resolves once Inter is loaded at the diagram's weights, to whether
 * anything was measured with the estimate before - so a caller that laid
 * out then measures again, and one that did not is spared the work. False
 * at once where there is no canvas to measure with. */
export async function diagramFontsReady(
  weights: Weight[] = [400, 500, 700]
): Promise<boolean> {
  const fonts = typeof document !== "undefined" ? document.fonts : undefined
  if (!context() || !fonts) return false
  await Promise.all(
    weights.map((w) =>
      fonts.load(fontSpec(12, w)).then(
        () => {
          if (fonts.check(fontSpec(12, w))) ready.add(w)
        },
        () => undefined
      )
    )
  )
  const changed = estimated
  estimated = false
  return changed
}

/**
 * `text` cut to fit `maxW` with an ellipsis (binary search on the prefix),
 * or unchanged when it fits. Returns "" when not even the ellipsis fits.
 */
export function fit(
  text: string,
  maxW: number,
  size: number,
  weight: Weight,
  measure: Measure
): string {
  if (measure(text, size, weight) <= maxW) return text
  const ell = "…"
  if (measure(ell, size, weight) > maxW) return ""
  const chars = Array.from(text)
  let lo = 0
  let hi = chars.length - 1
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    const cut = chars.slice(0, mid).join("").trimEnd() + ell
    if (measure(cut, size, weight) <= maxW) lo = mid
    else hi = mid - 1
  }
  return chars.slice(0, lo).join("").trimEnd() + ell
}
