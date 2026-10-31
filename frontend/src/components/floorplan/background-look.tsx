/**
 * The plan's background image, muted: Display > Muted background (on by
 * default). A map or a scan at full colour competes with the racks, trays
 * and cables drawn over it, so the picture is drained of most of its colour
 * and its contrast squeezed toward the page - pale on light, dark on dark
 * (where it is also inverted, as a dark map is drawn). One SVG filter on
 * the plan (the PNG export carries it), and the same sums per pixel for the
 * 3D floor's texture (`muteRgb`).
 */

/** How much colour the muted picture keeps (0 grey, 1 as it is). */
export const MUTE_SATURATION = 0.15

/** The muted picture's tone curve per channel: out = slope * in +
 * intercept. Light squeezes it toward white; dark inverts it and squeezes
 * it toward the dark page, so white streets go near-black and black text
 * mid-grey. */
export function muteTone(dark: boolean): { slope: number; intercept: number } {
  return dark
    ? { slope: -0.42, intercept: 0.5 }
    : { slope: 0.4, intercept: 0.6 }
}

/** The filter's id on the page - one per plan, so two plans on a page
 * never share one in the other's theme. */
export const muteFilterId = (planId: string) => `fp-bg-mute-${planId}`

/** One pixel through the muted look (0-255 channels): the saturate
 * matrix SVG's feColorMatrix uses, then the tone curve - so the 3D floor's
 * texture, muted on a canvas, matches the 2D plan's filter. */
export function muteRgb(
  r: number,
  g: number,
  b: number,
  dark: boolean
): [number, number, number] {
  const s = MUTE_SATURATION
  const [R, G, B] = [r / 255, g / 255, b / 255]
  const sr =
    (0.213 + 0.787 * s) * R + (0.715 - 0.715 * s) * G + (0.072 - 0.072 * s) * B
  const sg =
    (0.213 - 0.213 * s) * R + (0.715 + 0.285 * s) * G + (0.072 - 0.072 * s) * B
  const sb =
    (0.213 - 0.213 * s) * R + (0.715 - 0.715 * s) * G + (0.072 + 0.928 * s) * B
  const { slope, intercept } = muteTone(dark)
  const out = (v: number) =>
    Math.round(Math.min(1, Math.max(0, slope * v + intercept)) * 255)
  return [out(sr), out(sg), out(sb)]
}

/** The same filter for the on-screen plan, inside its `<defs>`. */
export function MuteFilter({ id, dark }: { id: string; dark: boolean }) {
  const { slope, intercept } = muteTone(dark)
  return (
    <filter id={id} colorInterpolationFilters="sRGB">
      <feColorMatrix type="saturate" values={String(MUTE_SATURATION)} />
      <feComponentTransfer>
        <feFuncR type="linear" slope={slope} intercept={intercept} />
        <feFuncG type="linear" slope={slope} intercept={intercept} />
        <feFuncB type="linear" slope={slope} intercept={intercept} />
      </feComponentTransfer>
    </filter>
  )
}
