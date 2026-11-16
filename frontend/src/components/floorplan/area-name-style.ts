import type { AreaNamePosition, AreaNameStyle } from "@/lib/api"

import { CELL } from "./canvas-geometry"
import { LABEL_PAD_EM, textWidthEm } from "./shapes"

// How an area's name is drawn: where in its box (inside its walls), how
// big, in what colour and whether on a plate. The plan holds a default
// (`state.area_names`), an area its own override (`name_style`); a key
// either leaves out inherits - the area from the plan, the plan from the
// look names always had (top left, M, Auto, no plate). The canvas
// (shape-layer.tsx), the label pass (plan-label-pass.ts) and the export
// (plan-svg.ts) all lay a name out through `areaNameSize` and `nameBoxAt`.

/** The nine places, row by row (the picker's grid order). */
export const AREA_NAME_POSITIONS: readonly AreaNamePosition[] = [
  "top-left",
  "top",
  "top-right",
  "left",
  "center",
  "right",
  "bottom-left",
  "bottom",
  "bottom-right",
]

export type AreaNameSize = NonNullable<AreaNameStyle["size"]>

/** The sizes: the name's font (plan px) at each. M is the size names
 * always had. */
export const AREA_NAME_SIZES: readonly {
  key: AreaNameSize
  label: string
  px: number
}[] = [
  { key: "s", label: "S", px: 10 },
  { key: "m", label: "M", px: 12 },
  { key: "l", label: "L", px: 16 },
]

/** The base size Readable grows from (the M font). */
export const AREA_NAME_BASE_PX = 12

/** A name's look with nothing left to inherit. `color` "" is Auto. */
export interface AreaNameLook {
  position: AreaNamePosition
  size: AreaNameSize
  color: string
  plate: boolean
}

export const DEFAULT_AREA_NAME_LOOK: AreaNameLook = {
  position: "top-left",
  size: "m",
  color: "",
  plate: false,
}

const HEX = /^#[0-9a-f]{6}$/i

/** A stored style as far as it is valid; anything else is left out (and
 * so inherits). */
export function readAreaNameStyle(raw: unknown): AreaNameStyle {
  if (!raw || typeof raw !== "object") return {}
  const r = raw as Record<string, unknown>
  const out: AreaNameStyle = {}
  if (AREA_NAME_POSITIONS.includes(r.position as AreaNamePosition))
    out.position = r.position as AreaNamePosition
  if (AREA_NAME_SIZES.some((s) => s.key === r.size))
    out.size = r.size as AreaNameSize
  if (r.color === "" || (typeof r.color === "string" && HEX.test(r.color)))
    out.color = r.color
  if (typeof r.plate === "boolean") out.plate = r.plate
  return out
}

/** The look an area's name is drawn with: its own keys, else the plan's
 * default, else the built-in. */
export function resolveAreaNameLook(
  planDefault: unknown,
  own?: unknown
): AreaNameLook {
  return {
    ...DEFAULT_AREA_NAME_LOOK,
    ...readAreaNameStyle(planDefault),
    ...readAreaNameStyle(own),
  }
}

/** The name's font (plan px) at its size, grown by `grow` (Readable). */
export function areaNameFontPx(look: AreaNameLook, grow = 1): number {
  return (AREA_NAME_SIZES.find((s) => s.key === look.size)?.px ?? 12) * grow
}

/** The icon before a name and its gap, per px of the name's font. */
const ICON_EM = 16 / 12

/** A name's box at `font` (any unit): the plate when it has one, else the
 * text and icon - and the pad from its edge to the text, the icon's shift
 * before the text and its baseline below the box's top. */
export function areaNameSize(
  name: string,
  font: number,
  icon: boolean,
  plate: boolean
): { w: number; h: number; pad: number; shift: number; baseline: number } {
  const pad = plate ? font * LABEL_PAD_EM : 0
  const shift = icon ? font * ICON_EM : 0
  // Semibold: measured as bold, so a plate is never short.
  const text = textWidthEm(name, true) * font
  return {
    w: text + shift + pad * 2,
    h: font * 1.2 + pad * 2,
    pad,
    shift,
    // Where names always sat; on a plate, a touch lower so the glyphs sit
    // in its middle.
    baseline: pad + font * (plate ? 0.88 : 0.8),
  }
}

/** Where an unplaced area's name is drawn (plan px): at its position in
 * its own box, `6 · grow` in from the sides - a turned area's name (turned
 * with it), and one the label pass did not place. */
export function areaNameFallback(
  a: { x: number; y: number; width: number; height: number },
  look: AreaNameLook,
  size: { w: number; h: number },
  grow: number
): { x: number; y: number } {
  return nameBoxAt(
    { x: a.x * CELL, y: a.y * CELL, w: a.width * CELL, h: a.height * CELL },
    size,
    6 * grow,
    look.position
  )
}

/** Where along each side a position sits: 0 the start, 1 the end. */
export function positionFractions(p: AreaNamePosition): [number, number] {
  const fx = p.endsWith("left") ? 0 : p.endsWith("right") ? 1 : 0.5
  const fy = p.startsWith("top") ? 0 : p.startsWith("bottom") ? 1 : 0.5
  return [fx, fy]
}

/** A name box's top left at `position` in `rect` (the area's box inside
 * its walls), kept `inset` off each side; the centre is the inner box's.
 * Not clamped: in a room narrower than its name it runs past the side it
 * is not aligned to. */
export function nameBoxAt(
  rect: { x: number; y: number; w: number; h: number },
  size: { w: number; h: number },
  inset: number,
  position: AreaNamePosition
): { x: number; y: number } {
  const [fx, fy] = positionFractions(position)
  const x0 = rect.x + inset
  const y0 = rect.y + inset
  const x1 = rect.x + rect.w - inset - size.w
  const y1 = rect.y + rect.h - inset - size.h
  return {
    x: fx === 0.5 ? rect.x + (rect.w - size.w) / 2 : x0 + (x1 - x0) * fx,
    y: fy === 0.5 ? rect.y + (rect.h - size.h) / 2 : y0 + (y1 - y0) * fy,
  }
}
