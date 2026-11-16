/**
 * A tile's face with **Display → Tile icons** on: a solid fill in the
 * colour the plan colours it by, a subtle border, and a centred glyph -
 * what the tile is - in the ink that reads on that fill. Shared by the
 * canvas (tile-layer.tsx) and the SVG/PDF export (plan-svg.ts), so the two
 * draw the same; pure, so it is tested on its own.
 *
 * Plan px, tile-local: (0,0) is the top-left corner of the tile's full
 * cell footprint, as in tile-marks.ts.
 */
import { hex6, mix } from "@/lib/diagram/theme"

import { GUTTER } from "./canvas-geometry"
import { FACING_T, figureBarRect, figureLift } from "./tile-marks"

export type TileTheme = "light" | "dark"

/** The page under the plan (`--background`), as hex, per theme. */
export const PAGE_HEX: Record<TileTheme, string> = {
  light: "#fafafa",
  dark: "#111113",
}

/** The two inks a glyph and a name take on a solid tile. */
export const INK_LIGHT = "#ffffff"
export const INK_DARK = "#0a0a0a"

/** A solid tile with no colour of its own (no override, type or role):
 * zinc-500, which carries white ink - the old pale zinc-400 does not. */
export const NEUTRAL_SOLID = "#71717a"

/** How much of its colour a tile linked to nothing (a planning tile)
 * keeps over the page: lighter in light, deeper in dark - the plan's
 * "not there yet", as the 3D room's ghost massing. */
export const PLANNED_SHARE = 0.6

/** The front-edge marker in ink on a solid tile: softer than the glyph,
 * so the tile reads as what it is first and which way it faces second. */
export const SOLID_MARK_OPACITY = 0.6

/** Glyph sizes, plan px: under the least it is not drawn. A rack-sized
 * tile's glyph stops at GLYPH_MAX; a big tile (a generator, a CRAH) lets
 * it grow to a share of its face - or to its name's size - so it never
 * reads as a speck on it. */
export const GLYPH_MIN = 10
export const GLYPH_MAX = 30
/** The share of a big tile's face a glyph may grow to. */
const GLYPH_BIG_SHARE = 0.4

/** The most a glyph may be on this face, next to a name this size. */
export function glyphCap(box: { w: number; h: number }, fontSize = 0): number {
  return Math.max(
    GLYPH_MAX,
    Math.min(box.w, box.h) * GLYPH_BIG_SHARE,
    fontSize * 1.5
  )
}
/** Share of the free face a glyph takes. */
const GLYPH_SHARE = 0.72
/** Clear space round the face's content, inside the tile's stroke. */
const FACE_PAD = 3
/** Space between a glyph and its name. */
const GLYPH_GAP = 2

function channel(c: number): number {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

/** WCAG relative luminance of a hex colour (black for anything else). */
export function luminance(hex: string): number {
  const h = hex6(hex)
  if (!h) return 0
  const v = parseInt(h.slice(1), 16)
  return (
    0.2126 * channel((v >> 16) & 0xff) +
    0.7152 * channel((v >> 8) & 0xff) +
    0.0722 * channel(v & 0xff)
  )
}

/** WCAG contrast ratio between two hex colours, 1-21. */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

/** The least contrast a white glyph keeps on its fill: WCAG's floor for
 * graphics (1.4.11). */
export const WHITE_INK_MIN = 3

/** The ink on `fill`: white wherever it keeps WHITE_INK_MIN - most
 * catalog colours, as the reference look wants - else near-black (sky,
 * amber, lime, the pale greys), which then reads far better. */
export function inkOn(fill: string): string {
  return contrast(INK_LIGHT, fill) >= WHITE_INK_MIN ? INK_LIGHT : INK_DARK
}

/** A tile's solid fill: its colour as it is when it links an object, a
 * share of it over the page when it is a planning tile. `own` false: the
 * tile has no colour from its data, and takes the neutral. */
export function solidFill(
  color: string,
  {
    linked,
    theme,
    own = true,
  }: {
    linked: boolean
    theme: TileTheme
    own?: boolean
  }
): string {
  const base = (own && hex6(color)) || NEUTRAL_SOLID
  return linked ? base : mix(base, PAGE_HEX[theme], PLANNED_SHARE)
}

/** The subtle border round a solid tile: its fill a shade darker on a
 * light page, a shade lighter on a dark one. */
export function solidBorder(fill: string, theme: TileTheme): string {
  return theme === "dark"
    ? mix(fill, "#ffffff", 0.78)
    : mix(fill, "#000000", 0.8)
}

/** A rect, tile-local plan px. */
export interface FaceBox {
  x: number
  y: number
  w: number
  h: number
}

/** What else is on the tile, keeping the glyph off it. */
export interface FaceInput {
  w: number
  h: number
  orientation: number
  /** The capacity bar along the foot; `text` - its figure written above
   * it. */
  figure?: { text: boolean } | null
  /** A cabinet's device count in the bottom-right corner. */
  count?: boolean
  /** The riser icon in the top-right corner, this size. */
  riser?: number
}

/** The facing quarter: 0 up, 90 right, 180 down, 270 left. */
function quarter(orientation: number): number {
  return (((Math.round(orientation / 90) * 90) % 360) + 360) % 360
}

/**
 * The tile's free face: its inside less the front-edge marker's side, the
 * capacity bar and its figure along the foot, and the corner marks. The
 * glyph and the name share it; nothing in it overlaps a mark.
 */
export function faceBox({
  w,
  h,
  orientation,
  figure = null,
  count = false,
  riser = 0,
}: FaceInput): FaceBox {
  let left = GUTTER + FACE_PAD
  let right = w - GUTTER - FACE_PAD
  let top = GUTTER + FACE_PAD
  let bottom = h - GUTTER - FACE_PAD
  // The facing bar hugs one edge (tile-marks.ts): stay a gap inside it.
  const mark = 1.5 + FACING_T + 1
  const q = quarter(orientation)
  if (q === 0) top = Math.max(top, GUTTER + mark)
  else if (q === 180) bottom = Math.min(bottom, h - GUTTER - mark)
  else if (q === 90) right = Math.min(right, w - GUTTER - mark)
  else left = Math.max(left, GUTTER + mark)
  if (figure) {
    const bar = figureBarRect(w, h, orientation)
    // The figure's 8px text: its baseline where tile-layer.tsx sets it,
    // its cap ~6px above that.
    const textTop = h - GUTTER - 10 - figureLift(orientation) - 6
    bottom = Math.min(bottom, (figure.text ? textTop : bar.y) - 1)
  }
  if (count) bottom = Math.min(bottom, h - GUTTER - 4 - 9)
  if (riser > 0) top = Math.max(top, GUTTER + 3 + riser + 1)
  return {
    x: left,
    y: top,
    w: Math.max(0, right - left),
    h: Math.max(0, bottom - top),
  }
}

/** The glyph's place (top-left and side, plan px) and, when it shares the
 * face with the name, the name's - its centre x and its baseline. */
export interface TileFace {
  glyph: { x: number; y: number; size: number } | null
  label: { x: number; y: number } | null
}

/**
 * Lay out the glyph on a tile's face. The name keeps the size the label
 * rules gave it - the glyph takes what is left: above the name when the
 * face is tall enough, beside it on a wide face, else not at all (the
 * name wins). With no name in the tile the glyph has the face to itself.
 * A glyph under GLYPH_MIN is not drawn.
 */
export function tileFace(
  input: FaceInput & {
    /** The name drawn in the tile, at its font size; null when it is not
     * (none, or the names layer draws it). */
    name?: { text: string; fontSize: number } | null
  }
): TileFace {
  const box = faceBox(input)
  const cx = box.x + box.w / 2
  const name = input.name
  if (!name) {
    const size = Math.min(glyphCap(box), Math.min(box.w, box.h) * GLYPH_SHARE)
    if (size < GLYPH_MIN) return { glyph: null, label: null }
    return {
      glyph: { x: cx - size / 2, y: box.y + box.h / 2 - size / 2, size },
      label: null,
    }
  }
  const fs = name.fontSize
  const lineH = fs * 1.15
  // Stacked - the glyph over the name - or inline - left of it: whichever
  // gives the bigger glyph, the pair centred on the face.
  const stacked = Math.min(
    glyphCap(box, fs),
    box.w * GLYPH_SHARE,
    box.h - lineH - GLYPH_GAP
  )
  const nameW = Math.min(box.w, name.text.length * fs * 0.62)
  const inline = Math.min(
    glyphCap(box, fs),
    box.h * 0.8,
    box.w - nameW - GLYPH_GAP * 2
  )
  if (stacked >= GLYPH_MIN && stacked >= inline) {
    const top = box.y + (box.h - (stacked + GLYPH_GAP + lineH)) / 2
    return {
      glyph: { x: cx - stacked / 2, y: top, size: stacked },
      label: { x: cx, y: top + stacked + GLYPH_GAP + fs * 0.85 },
    }
  }
  if (inline >= GLYPH_MIN) {
    const left = box.x + (box.w - (inline + GLYPH_GAP * 2 + nameW)) / 2
    const cy = box.y + box.h / 2
    return {
      glyph: { x: left, y: cy - inline / 2, size: inline },
      label: { x: left + inline + GLYPH_GAP * 2 + nameW / 2, y: cy + fs / 3 },
    }
  }
  return { glyph: null, label: null }
}
