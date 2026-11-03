import { readableText } from "@/lib/color"
import { baselineAt, fit, measureText, wrapText } from "@/lib/diagram/measure"
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
  /** The card lines' widest: a wider line is cut with an ellipsis. Detailed
   * cards grow past it to fit their nubs. */
  MAX_W: 240,
  /** The name's widest: a card grows to fit its whole name up to this, and
   * a longer name wraps onto more rows. A name is never cut. */
  NAME_MAX_W: 480,
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
  /** The name's first row… */
  title: PlacedText
  /** …and every row of it, top to bottom: one unless the name is wider
   * than `CARD.NAME_MAX_W` allows. */
  titleRows: PlacedText[]
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
 * `least` makes the box at least that wide or tall (a virtual chassis'
 * members are as wide, or as tall, as each other): the text stays centred
 * across it, at the top.
 *
 * The card grows to fit its whole name, up to `CARD.NAME_MAX_W` (or
 * `most`: a fixed box's width); a longer name wraps onto more rows and the
 * card grows taller. The name is never cut; the card lines are cut to the
 * card's width.
 */
export function cardLayout(
  input: CardLayoutInput,
  demand?: Partial<SideCount> | null,
  measure: Measure = measureText,
  least?: { w?: number; h?: number },
  most: number = CARD.NAME_MAX_W
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
  const names = nameRows(input.name, Math.max(1, most - 2 * inset), measure)
  const namesW = Math.max(
    ...names.map((t) =>
      Math.ceil(measure(t, CARD.TITLE_SIZE, CARD.TITLE_WEIGHT))
    )
  )
  const lineW = Math.max(
    0,
    ...input.lines.map((l) =>
      Math.ceil(measure(l.text, CARD.LINE_SIZE, CARD.LINE_WEIGHT))
    )
  )
  const rest = Math.max(
    lineW ? lineW + 2 * CARD.PAD_X : 0,
    stacked ? PILL.X + slotW + CARD.PAD_X : 0
  )

  const nubs: SideCount = { ...NO_NUBS }
  for (const s of ["T", "R", "B", "L"] as const)
    nubs[s] = Math.min(NUB.MAX_PER_SIDE, Math.max(0, demand?.[s] ?? 0))

  const titleTop = CARD.PAD_Y + (stacked ? PILL.H + PILL.ROW_GAP : 0)
  const linesTop =
    titleTop +
    names.length * CARD.TITLE_LH +
    (input.lines.length ? CARD.LINES_GAP : 0)
  const w = Math.max(
    clamp(rest, CARD.MIN_W, CARD.MAX_W),
    // The whole name, past `CARD.MAX_W` when it needs to.
    namesW + 2 * inset,
    nubSpan(Math.max(nubs.T, nubs.B)),
    least?.w ?? 0
  )
  const h = Math.max(
    linesTop + input.lines.length * CARD.LINE_LH + CARD.PAD_Y,
    nubSpan(Math.max(nubs.L, nubs.R)),
    least?.h ?? 0
  )

  const titleRows: PlacedText[] = names.map((t, i) => {
    const top = titleTop + i * CARD.TITLE_LH
    return {
      text: t,
      size: CARD.TITLE_SIZE,
      weight: CARD.TITLE_WEIGHT,
      x: w / 2,
      y: baselineAt(top, CARD.TITLE_SIZE, CARD.TITLE_LH),
      top,
      lh: CARD.TITLE_LH,
      anchor: "middle",
      w: measure(t, CARD.TITLE_SIZE, CARD.TITLE_WEIGHT),
    }
  })
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
    title: titleRows[0],
    titleRows,
    lines,
    pill,
    stacked,
    nubs,
  }
}

/** A card name's rows within `room` px: the whole name on one row when it
 * fits, else wrapped (`wrapText`) - never cut. One empty row for no name,
 * so a card always has its name row. */
export function nameRows(
  name: string,
  room: number,
  measure: Measure = measureText
): string[] {
  const rows = wrapText(name, room, CARD.TITLE_SIZE, CARD.TITLE_WEIGHT, measure)
  return rows.length ? rows : [""]
}
