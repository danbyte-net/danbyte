import type { Weight } from "./measure"
import type { DiagramBand, LinkSem, Pt } from "./types"

// The light print theme every diagram export draws with, whatever theme the
// app is in: solid hex only (no CSS variables, no alpha - some printers choke
// on transparency groups), the zinc greys of the light tokens in styles.css,
// and colour only where it means something (role fills, pills, cable
// colours). The card and label measurements live here too, so the canvas
// card and the writers read one set of numbers.

/** The light theme's tokens as hex (styles.css `:root`, Tailwind zinc). */
export const PRINT = {
  paper: "#ffffff",
  /** zinc-900: names on neutral surfaces, the title block. */
  text: "#18181b",
  /** zinc-700: band labels, middle labels, notes. */
  body: "#3f3f46",
  /** zinc-600: end labels, secondary title-block text. */
  muted: "#52525c",
  /** zinc-500 (`--muted-foreground`): the default line colour. */
  subtle: "#71717b",
  /** zinc-400: nubs, LLDP ghosts. */
  faint: "#9f9fa9",
  /** zinc-300: photo frames. */
  rule: "#d4d4d8",
  /** zinc-200 (`--border`): hairlines, label chip edges. */
  border: "#e4e4e7",
  /** zinc-100: the card of a device without a role colour. */
  wash: "#f4f4f5",
  /** zinc-50: a neutral band's fill. */
  tint: "#fafafa",
  /** `--primary` (sky-700): photo port markers, BGP. */
  primary: "#0069a8",
} as const

/** The card of a device whose role has no colour (or no role). */
export const NEUTRAL_CARD = { fill: PRINT.wash, ink: PRINT.text } as const

/** The CSS variables the canvas styles reference, as print hex - for
 * builders turning an `edgeLook` stroke into a document colour. */
export const PRINT_VARS: Record<string, string> = {
  "--primary": PRINT.primary,
  "--map-accent": PRINT.primary,
  "--muted-foreground": PRINT.subtle,
  "--border": PRINT.border,
  "--foreground": "#09090b",
  "--card": PRINT.paper,
  "--background": PRINT.paper,
}

/** `#rgb`, `#rrggbb` or a bare hex as `#rrggbb`; null for anything else. */
export function hex6(color: string | null | undefined): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((color ?? "").trim())
  if (!m) return null
  const h = m[1].toLowerCase()
  return h.length === 3
    ? `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`
    : `#${h}`
}

/** A colour as print hex: hex passes through normalised, `var(--x)` resolves
 * through PRINT_VARS, anything else is the fallback. */
export function printColor(
  color: string | null | undefined,
  fallback: string
): string {
  const hex = hex6(color)
  if (hex) return hex
  const v = /^var\((--[\w-]+)\)$/.exec((color ?? "").trim())
  return (v && PRINT_VARS[v[1]]) || fallback
}

/** `t` of colour `a` over colour `b`, as solid hex - how the writers tint
 * without alpha. Unparsable colours count as white. */
export function mix(a: string, b: string, t: number): string {
  const rgb = (c: string) => {
    const v = parseInt((hex6(c) ?? "#ffffff").slice(1), 16)
    return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]
  }
  const [x, y] = [rgb(a), rgb(b)]
  return (
    "#" +
    x
      .map((c, i) =>
        Math.round(c * t + y[i] * (1 - t))
          .toString(16)
          .padStart(2, "0")
      )
      .join("")
  )
}

/** Card geometry, the same numbers as the canvas card
 * (components/topology/diagram/card-layout.ts).
 *
 * Layout, top to bottom: the name row (bold, centred), then one row per
 * card line (regular, centred). The pill sits inside the card at the
 * top-left, on the name row; when the name cannot stay centred clear of it,
 * the pill takes a row of its own above the name ("stacked"). */
export const CARD = {
  /** `rounded-lg`. */
  RADIUS: 10,
  PAD_X: 10,
  PAD_Y: 6,
  TITLE_SIZE: 12,
  TITLE_WEIGHT: 700 as Weight,
  TITLE_LH: 16,
  LINE_SIZE: 10,
  LINE_WEIGHT: 400 as Weight,
  LINE_LH: 14,
  /** Between the name and the first line. */
  LINES_GAP: 1,
  /** The 1px edge: the fill this far toward black. */
  EDGE_DARKEN: 0.14,
  /** Card lines: the ink this much over the fill, a step quieter than the
   * name. */
  LINE_INK: 0.82,
  /** Photo nodes: gap between the image and the caption under it. */
  CAPTION_GAP: 4,
} as const

/** The card's pill (the shared status pill at card scale). */
export const PILL = {
  H: 16,
  /** Horizontal padding plus the badge's 1px border. */
  PAD_X: 7,
  SIZE: 9,
  WEIGHT: 500 as Weight,
  /** From the card's left edge. */
  X: 6,
  MAX_W: 96,
  RADIUS: 5,
  /** Between the pill and a name centred beside it. */
  GAP: 6,
  /** Between the pill row and the name when they are stacked. */
  ROW_GAP: 2,
} as const

/** On screen, a pill on a colored card or rail keeps a white edge, as the
 * writers stroke it in paper white, so a pill of a similar color still
 * stands apart. */
export const PILL_ON_FILL = "outline-1 outline-white/80"

/** A card's height for `lines` card lines, with the pill on its own row
 * when `stacked`. */
export function cardTextHeight(lines: number, stacked = false): number {
  return (
    2 * CARD.PAD_Y +
    (stacked ? PILL.H + PILL.ROW_GAP : 0) +
    CARD.TITLE_LH +
    (lines ? CARD.LINES_GAP + lines * CARD.LINE_LH : 0)
  )
}

export const NUB = { RADIUS: 2 } as const

/** Link labels. */
export const LABEL = {
  MID_SIZE: 10,
  MID_LH: 13,
  END_SIZE: 9,
  PAD_X: 3,
  RADIUS: 3,
  /** End labels (port names, addresses) sit ON their line, which breaks
   * for them: it runs this far out of its nub (or its end) first, and this
   * far again between two labels… */
  LEAD: 6,
  /** …and stops this far short of the text on either side, the page
   * showing through. */
  GAP: 3,
  /** A middle chip moved off its line sits this far beside it. */
  BESIDE: 3,
} as const

/** Corner radius of an elbow route (draw.io `arcSize` = twice this). */
export const ELBOW_RADIUS = 6

/** Bands, as the canvas draws them (components/topology/diagram/bands.ts
 * and band-node.tsx): a row's title centred in a strip across its top (a
 * draw.io swimlane), a side band's big label running up its middle, a
 * zone's in a tab. */
export const BAND = {
  /** A row's title strip - the canvas's `BAND.TITLE`. */
  ROW_TITLE: 32,
  ZONE_HEADER: 22,
  /** A zone's label. */
  LABEL_SIZE: 12,
  /** A row's title. */
  TITLE_SIZE: 13,
  /** A side band's label. */
  SIDE_SIZE: 20,
  /** A virtual chassis' name, on its strip - the canvas's
   * `CHASSIS.STRIP` thick. */
  CHASSIS_SIZE: 11,
  CHASSIS_STRIP: 20,
  LABEL_WEIGHT: 600 as Weight,
  RADIUS: 8,
  /** A stacked row's sub-row badge - the canvas's ColorBadge (`BAND.SUB_*`
   * in bands.ts): height, text, the room either side of the text (with
   * the badge's border), corner, and its distance from the row's left
   * edge (the rule between sub-rows keeps it from both edges). */
  SUB_H: 20,
  SUB_SIZE: 12,
  SUB_WEIGHT: 500 as Weight,
  SUB_PAD: 9,
  SUB_RADIUS: 5,
  SUB_EDGE: 12,
} as const

/** Default line looks per link kind, matching `edgeLook` in
 * components/topology/edge-style.ts with print colours. */
export const LINK_DEFAULTS: Record<
  LinkSem,
  { width: number; stroke: string; dash?: string }
> = {
  cable: { width: 1.25, stroke: PRINT.subtle },
  bundle: { width: 2.5, stroke: PRINT.subtle },
  ghost: { width: 1.5, stroke: PRINT.faint, dash: "6 4" },
  bgp: {
    width: 1.25,
    stroke: mix(PRINT.primary, PRINT.paper, 0.6),
    dash: "3 5",
  },
}

/** The zone palette - mirrors ZONE_COLORS in
 * components/topology/view-positions.ts (a test holds them equal). */
export const ZONE_COLORS = [
  "#64748b",
  "#0ea5e9",
  "#10b981",
  "#f59e0b",
  "#ec4899",
  "#8b5cf6",
] as const

export interface BandPaint {
  fill: string
  /** A zone's label tab. */
  header: string
  edge: string
  ink: string
  /** Zones outline; bands only separate. */
  edgeWidth: number
}

/** A band's print tints. Rows and columns are neutral unless they carry a
 * zone swatch - the canvas's light grey (`--muted` toward `--border`), or
 * a pastel of the swatch; a zone always has one (the first when its own is
 * unknown). */
export function bandPaint(band: Pick<DiagramBand, "kind" | "fill">): BandPaint {
  const own = hex6(band.fill)
  const swatch = own ?? (band.kind === "zone" ? ZONE_COLORS[0] : null)
  if (!swatch)
    return {
      fill: mix(PRINT.wash, PRINT.border, 0.7),
      header: PRINT.wash,
      edge: PRINT.border,
      ink: PRINT.body,
      edgeWidth: 1,
    }
  return band.kind === "zone"
    ? {
        fill: mix(swatch, PRINT.paper, 0.07),
        header: mix(swatch, PRINT.paper, 0.22),
        edge: mix(swatch, PRINT.paper, 0.75),
        ink: PRINT.body,
        edgeWidth: 1.5,
      }
    : {
        fill: mix(swatch, PRINT.paper, 0.12),
        header: mix(swatch, PRINT.paper, 0.22),
        edge: mix(swatch, PRINT.paper, 0.4),
        ink: PRINT.body,
        edgeWidth: 1,
      }
}

/** The colour under a point: the fill of the top band there (`bands` back
 * to front), else the page. An end label breaks its line over it, so the
 * gap reads as a gap on a band as on the page. */
export function groundAt(
  bands: readonly DiagramBand[],
  p: Pt,
  page: string
): string {
  for (let i = bands.length - 1; i >= 0; i--) {
    const b = bands[i]
    if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h)
      return bandPaint(b).fill
  }
  return page
}

/** The font stack the writers name. Inter first; the fallbacks keep a
 * machine without it on a sans-serif. */
export const FONT_STACK =
  "Inter, Inter Variable, Segoe UI, Roboto, Helvetica, Arial, sans-serif"
