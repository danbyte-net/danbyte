// A drawing on a sheet of paper, for the PDF export: where it sits and at
// what scale. The server lays the page out (api/drawing_pdf.py
// `plan_sheet`); this is the same arithmetic, so the page can say before
// the round trip how large the text will print. Keep the two in step.

export type Paper = "a4" | "a3" | "letter" | "tabloid"
export type Orientation = "landscape" | "portrait"

export interface PaperChoice {
  size: Paper
  orientation: Orientation
}

/** Paper sizes in mm, landscape (width, height). */
export const PAPERS: Record<Paper, readonly [number, number]> = {
  a4: [297, 210],
  a3: [420, 297],
  letter: [279.4, 215.9],
  tabloid: [431.8, 279.4],
}

export const PAPER_LABELS: Record<Paper, string> = {
  a4: "A4",
  a3: "A3",
  letter: "Letter",
  tabloid: "Tabloid",
}

/** The sheet in mm: page margin, the title block's strip and the gap
 * above it. */
export const SHEET = { MARGIN: 10, TITLE: 14, GAP: 4 } as const

/** CSS px → mm at 96 dpi. */
export const PX_MM = 25.4 / 96
/** A small drawing is enlarged to at most this, mm per px. */
export const MAX_SCALE = 1.5 * PX_MM

export interface MmRect {
  x: number
  y: number
  w: number
  h: number
}

export interface SheetPlan {
  /** The page, mm. */
  page: { w: number; h: number }
  /** The printable area above the title block, mm. */
  area: MmRect
  /** The drawing on the page, mm. */
  at: MmRect
  /** mm per drawing px. */
  scale: number
}

/** A `size.w`×`size.h` px drawing fitted to the printable area (keeping its
 * shape, never enlarged past MAX_SCALE), at its top and centred across it. */
export function planSheet(
  size: { w: number; h: number },
  paper: PaperChoice,
  opts: { titleBlock?: boolean } = {}
): SheetPlan {
  const [lw, lh] = PAPERS[paper.size]
  const [pw, ph] = paper.orientation === "portrait" ? [lh, lw] : [lw, lh]
  const aw = pw - 2 * SHEET.MARGIN
  const ah =
    ph -
    2 * SHEET.MARGIN -
    (opts.titleBlock === false ? 0 : SHEET.TITLE + SHEET.GAP)
  const w = Math.max(size.w, 1)
  const h = Math.max(size.h, 1)
  const scale = Math.min(aw / w, ah / h, MAX_SCALE)
  const dw = w * scale
  const dh = h * scale
  return {
    page: { w: pw, h: ph },
    area: { x: SHEET.MARGIN, y: SHEET.MARGIN, w: aw, h: ah },
    at: {
      x: SHEET.MARGIN + (aw - dw) / 2,
      y: SHEET.MARGIN,
      w: dw,
      h: dh,
    },
    scale,
  }
}

/** A `px` font on the sheet, in points. */
export function printedPt(px: number, plan: SheetPlan): number {
  return (px * plan.scale * 72) / 25.4
}

/** Below this the smallest labels stop being readable on paper. */
export const MIN_PRINT_PT = 4

/** `A3 landscape`. */
export function paperLabel(p: PaperChoice): string {
  return `${PAPER_LABELS[p.size]} ${p.orientation}`
}
