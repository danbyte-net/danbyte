import { readableText } from "@/lib/color"
import { baselineAt, fit, measureText } from "@/lib/diagram/measure"
import type { Measure, Weight } from "@/lib/diagram/measure"
import type { PlacedText, Rect, Side, SideCount } from "./types"

// The Diagram card's box, computed in code: the canvas gives React Flow an
// explicit width and height from it (offscreen cards are never measured),
// the layout reserves it, and the exporters draw from it. The card DOM
// reads these constants too, so the two cannot drift.
//
// A card is a solid rounded box in its role's colour. The name is bold and
// centred at the top, the configured lines are centred under it, and a
// status pill sits inside the top-left corner. Room for the pill is kept
// whenever the card's field list can show one, so a device going down
// never resizes its card.

export const CARD = {
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
  MIN_W: 88,
  /** Wider names and lines are cut with an ellipsis. Detailed cards grow
   * past it to fit their nubs. */
  MAX_W: 240,
  /** `rounded-lg`. */
  RADIUS: 10,
} as const

/** The status pill: the shared badge shrunk to card scale, inside the
 * card's top-left corner. */
export const PILL = {
  H: 16,
  /** Horizontal padding plus the badge's 1px border. */
  PAD_X: 7,
  SIZE: 9,
  WEIGHT: 500 as Weight,
  MAX_W: 96,
  /** Inset from the card's left edge. */
  X: 6,
  /** Between the pill and a name centred beside it. */
  GAP: 6,
  /** Between the pill row and the name when they are stacked. */
  ROW_GAP: 2,
  RADIUS: 5,
} as const

/** Detailed mode's interface nubs: small tabs outside the card edge, one
 * per cabled interface. */
export const NUB = {
  /** Length along the card edge. */
  ALONG: 10,
  /** How far it stands out from the edge. */
  OUT: 6,
  /** Centre-to-centre spacing. */
  PITCH: 16,
  /** Clear space kept at each end of a side. */
  INSET: 12,
  /** More than this on one side wrap onto the adjacent sides. */
  MAX_PER_SIDE: 48,
  RADIUS: 2,
} as const

export const NO_NUBS: SideCount = { T: 0, R: 0, B: 0, L: 0 }

/** A breakout's junction node: the dot where its trunk splits. */
export const JUNCTION = { w: 6, h: 6 } as const

/**
 * Where the Diagram stacks on the canvas (React Flow `zIndex`). Every line
 * is drawn under the cards, as in every export - a Bendy line no curve
 * gets clear of passes behind them - a hovered or selected one too: the
 * canvas raises that over the other lines to 1000 (topology-canvas), its
 * chip to 1001 (styles.css). Cards, photos, junctions and notes stand at
 * `CARD`, a selected one 1000 higher (React Flow); a photo port's lead,
 * drawn again over its photo, at `LEAD`, over even that.
 */
export const STACK = { CARD: 1002, LEAD: 2003 } as const

export interface CardLayoutInput {
  name: string
  /** The role colour, `#rrggbb` or bare; none paints a neutral card. */
  color?: string | null
  lines: readonly { key: string; text: string }[]
  /** The pill shown now. */
  pill?: { kind: "check" | "status"; text: string } | null
  /** Every pill text the field list can show (`cardContent().pillSlot`). */
  pillSlot?: readonly string[]
}

export interface CardBox {
  w: number
  h: number
  /** `#rrggbb`, or null for the neutral card (theme colours). */
  fill: string | null
  /** Text colour on `fill` (`readableText`); null on the neutral card. */
  ink: string | null
  title: PlacedText
  lines: (PlacedText & { key: string })[]
  pill: { kind: "check" | "status"; text: string; rect: Rect } | null
  /** The pill slot sits on its own row above the name: the name is too
   * long to centre beside it within `CARD.MAX_W`. */
  stacked: boolean
  /** Nubs per side the box was sized for (capped per side). */
  nubs: SideCount
}

/** `#rrggbb` (lower case) from a stored colour, or null. */
export function normalizeHex(color?: string | null): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((color ?? "").trim())
  if (!m) return null
  const hex =
    m[1].length === 3
      ? m[1]
          .split("")
          .map((c) => c + c)
          .join("")
      : m[1]
  return `#${hex.toLowerCase()}`
}

/** A pill's width for `text`. */
export function pillWidth(text: string, measure: Measure = measureText) {
  return Math.min(
    PILL.MAX_W,
    Math.ceil(measure(text, PILL.SIZE, PILL.WEIGHT)) + 2 * PILL.PAD_X
  )
}

/** The side length `n` nubs need. */
export function nubSpan(n: number): number {
  return n > 0 ? (n - 1) * NUB.PITCH + NUB.ALONG + 2 * NUB.INSET : 0
}

/** A nub's box, card-relative, centred `off` px along `side`. */
export function nubRect(w: number, h: number, side: Side, off: number): Rect {
  const a = off - NUB.ALONG / 2
  switch (side) {
    case "T":
      return { x: a, y: -NUB.OUT, w: NUB.ALONG, h: NUB.OUT }
    case "B":
      return { x: a, y: h, w: NUB.ALONG, h: NUB.OUT }
    case "L":
      return { x: -NUB.OUT, y: a, w: NUB.OUT, h: NUB.ALONG }
    case "R":
      return { x: w, y: a, w: NUB.OUT, h: NUB.ALONG }
  }
}

/** The pill's top, card-relative: on the name row, or its own row above
 * the name when the card is `stacked`. */
export function pillTop(stacked: boolean): number {
  return CARD.PAD_Y + (stacked ? 0 : (CARD.TITLE_LH - PILL.H) / 2)
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v))

function placed(
  text: string,
  size: number,
  weight: Weight,
  lh: number,
  x: number,
  top: number,
  maxW: number,
  measure: Measure
): PlacedText {
  const t = fit(text, maxW, size, weight, measure)
  return {
    text: t,
    size,
    weight,
    x,
    y: baselineAt(top, size, lh),
    top,
    lh,
    anchor: "middle",
    w: measure(t, size, weight),
  }
}

/**
 * A card's box and where its text goes. `demand` is Detailed mode's nubs
 * per side (from `anchorLinks`); without it the card is Simple's compact
 * box. Detailed grows the box so every nub fits at full pitch, up to
 * `NUB.MAX_PER_SIDE` a side - the anchors wrap the rest round the corner.
 */
export function cardLayout(
  input: CardLayoutInput,
  demand?: Partial<SideCount> | null,
  measure: Measure = measureText
): CardBox {
  const fill = normalizeHex(input.color)
  const slotTexts = [...(input.pillSlot ?? [])]
  if (input.pill) slotTexts.push(input.pill.text)
  const slotW = Math.max(0, ...slotTexts.map((t) => pillWidth(t, measure)))
  // A name centred on the card clears the pill slot on the left, and the
  // same on the right to stay centred.
  const beside = Math.max(CARD.PAD_X, slotW ? PILL.X + slotW + PILL.GAP : 0)
  const nameW = Math.ceil(
    measure(input.name, CARD.TITLE_SIZE, CARD.TITLE_WEIGHT)
  )
  const stacked = slotW > 0 && nameW + 2 * beside > CARD.MAX_W
  const inset = stacked ? CARD.PAD_X : beside
  const lineW = Math.max(
    0,
    ...input.lines.map((l) =>
      Math.ceil(measure(l.text, CARD.LINE_SIZE, CARD.LINE_WEIGHT))
    )
  )
  const content = Math.max(
    nameW + 2 * inset,
    lineW ? lineW + 2 * CARD.PAD_X : 0,
    stacked ? PILL.X + slotW + CARD.PAD_X : 0
  )

  const nubs: SideCount = { ...NO_NUBS }
  for (const s of ["T", "R", "B", "L"] as const)
    nubs[s] = Math.min(NUB.MAX_PER_SIDE, Math.max(0, demand?.[s] ?? 0))

  const titleTop = CARD.PAD_Y + (stacked ? PILL.H + PILL.ROW_GAP : 0)
  const linesTop =
    titleTop + CARD.TITLE_LH + (input.lines.length ? CARD.LINES_GAP : 0)
  const w = Math.max(
    clamp(content, CARD.MIN_W, CARD.MAX_W),
    nubSpan(Math.max(nubs.T, nubs.B))
  )
  const h = Math.max(
    linesTop + input.lines.length * CARD.LINE_LH + CARD.PAD_Y,
    nubSpan(Math.max(nubs.L, nubs.R))
  )

  const title = placed(
    input.name,
    CARD.TITLE_SIZE,
    CARD.TITLE_WEIGHT,
    CARD.TITLE_LH,
    w / 2,
    titleTop,
    w - 2 * inset,
    measure
  )
  const lines = input.lines.map((l, i) => ({
    key: l.key,
    ...placed(
      l.text,
      CARD.LINE_SIZE,
      CARD.LINE_WEIGHT,
      CARD.LINE_LH,
      w / 2,
      linesTop + i * CARD.LINE_LH,
      w - 2 * CARD.PAD_X,
      measure
    ),
  }))

  let pill: CardBox["pill"] = null
  if (input.pill) {
    const text = fit(
      input.pill.text,
      PILL.MAX_W - 2 * PILL.PAD_X,
      PILL.SIZE,
      PILL.WEIGHT,
      measure
    )
    pill = {
      kind: input.pill.kind,
      text,
      rect: {
        x: PILL.X,
        y: pillTop(stacked),
        w: pillWidth(text, measure),
        h: PILL.H,
      },
    }
  }

  return {
    w,
    h,
    fill,
    ink: fill ? readableText(fill) : null,
    title,
    lines,
    pill,
    stacked,
    nubs,
  }
}
