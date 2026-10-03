import type { DinRail } from "@/lib/api"
import { freeGaps, railSpans } from "@/lib/din-geometry"
import type { RailDevice, RailSpan } from "@/lib/din-geometry"

// How a cabinet's plate is drawn (#277): the frame around it, each device's
// name on its body, and each rail's label beside its devices. The plate on
// the page (components/cabinet-elevation.tsx, cabinet-devices.tsx) and its
// exported drawing (lib/elevation/cabinet-svg.ts) follow these rules, so a
// file says what the screen says.

/** The drawing's frame, mm, from the plate's top-left corner: the box,
 * centred on the plate, when both its sides are known, else the plate - with
 * a margin so the outline's own pixel is never cut off. */
export function plateView(
  width: number,
  height: number,
  outerWidth?: number | null,
  outerHeight?: number | null
): {
  x: number
  y: number
  w: number
  h: number
  box: { w: number; h: number } | null
} {
  const box =
    outerWidth != null && outerHeight != null
      ? { w: Math.max(outerWidth, width), h: Math.max(outerHeight, height) }
      : null
  const frameW = box?.w ?? width
  const frameH = box?.h ?? height
  const pad = Math.max(frameW, frameH) * 0.01
  return {
    x: -(frameW - width) / 2 - pad,
    y: -(frameH - height) / 2 - pad,
    w: frameW + 2 * pad,
    h: frameH + 2 * pad,
    box,
  }
}

/** Screen pixels: a device name's size, the strip it sits in, and its
 * inset. */
export const NAME_PX = 10
export const STRIP_PX = 16
const INSET_PX = 3
/** A character of the name is about this wide, as a share of its size. */
const CHAR_EM = 0.6
/** A rail's label, as the plate writes it. */
export const RAIL_LABEL_PX = 11

/** The name cut to what fits `lengthPx`, with the one-character ellipsis;
 * empty when not even three of its characters do. */
export function fitName(name: string, lengthPx: number): string {
  const room = Math.floor((lengthPx - 2 * INSET_PX) / (NAME_PX * CHAR_EM))
  if (name.length <= room) return name
  return room >= 4 ? `${name.slice(0, room - 1)}…` : ""
}

/** How a body carries its name: across its top while the name fits there;
 * else down its middle when the body stands tall and more of the name fits
 * that way - DIN gear is mostly narrow and tall, and the rack's side lane
 * writes its strips' names the same way. Cut to the room it has, or left
 * out under three characters. A photo keeps the name across its top, so the
 * picture stays whole. */
export function nameLayout(
  name: string,
  widthPx: number,
  heightPx: number,
  photo: boolean
): { text: string; vertical: boolean } | null {
  const across = heightPx >= STRIP_PX ? fitName(name, widthPx) : ""
  if (across !== name && !photo && widthPx >= STRIP_PX && heightPx > widthPx) {
    const down = fitName(name, heightPx)
    if (down.length > across.length) return { text: down, vertical: true }
  }
  return across ? { text: across, vertical: false } : null
}

/** Where a rail's label goes, from its left end: the first free stretch it
 * fits in, or - on a full rail - the left end, `covered`, over the first
 * device. `width` is what the label takes, in plate mm. */
export function railTagAt(
  rail: Pick<DinRail, "id" | "label" | "length_mm">,
  devices: readonly (RailDevice & { din_rail: { id: string } | null })[],
  px: (n: number) => number,
  /** More of the rail to stay off, besides its devices. */
  also: RailSpan[] = []
): { offset: number; width: number; covered: boolean } {
  const width = px(rail.label.length * RAIL_LABEL_PX * CHAR_EM + 9)
  const taken = [
    ...railSpans(devices.filter((d) => d.din_rail?.id === rail.id)),
    ...also,
  ]
  const gap = freeGaps(rail.length_mm, taken).find(
    ([start, end]) => end - start >= width
  )
  return gap
    ? { offset: gap[0], width, covered: false }
    : { offset: 0, width, covered: true }
}
