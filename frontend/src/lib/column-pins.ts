// Pinned columns in DataTable: which columns stick to the left edge, and
// where. Pure, so the rules are tested without a browser.

/** Pins are ignored in a frame narrower than this (phones, slim dialogs):
 * there is no room for columns that never scroll. */
export const PIN_MIN_FRAME = 640

/** Stuck columns may take at most this share of the frame. A pin that would
 * pass it - and every pin after it - stays at the left but scrolls, so some
 * of the table always scrolls. */
export const PIN_MAX_SHARE = 0.6

/** Columns that can never be pinned: the row tick (pinned automatically,
 * first) and the row actions (already stuck to the right edge). */
export const UNPINNABLE = new Set(["select", "actions"])

/** TanStack's left-pinning order: the selection column first whenever
 * anything is pinned, then the user's pins that are on show, in pin order. */
export function leftPinOrder(
  pinned: readonly string[],
  opts: {
    hasSelect: boolean
    isShown: (id: string) => boolean
    canPin: (id: string) => boolean
    /** The frame's width, 0 while unmeasured. */
    frameWidth: number
  }
): string[] {
  if (opts.frameWidth > 0 && opts.frameWidth < PIN_MIN_FRAME) return []
  const ids = pinned.filter(
    (id, i) =>
      !UNPINNABLE.has(id) &&
      pinned.indexOf(id) === i &&
      opts.canPin(id) &&
      opts.isShown(id)
  )
  if (!ids.length) return []
  return opts.hasSelect ? ["select", ...ids] : ids
}

export interface PinLayout {
  /** Sticky `left` offset (px) per stuck column. */
  left: Record<string, number>
  /** The right-most stuck column - it carries the divider while scrolled. */
  last: string | null
}

export const NO_PIN_LAYOUT: PinLayout = { left: {}, last: null }

/** Offsets for the pinned columns from their measured widths, in pin order.
 * Each one sticks where the ones before it end, until the next would take
 * the stuck band past PIN_MAX_SHARE of the frame. */
export function pinLayout(
  ids: readonly string[],
  widths: readonly number[],
  frameWidth: number
): PinLayout {
  const cap = frameWidth > 0 ? frameWidth * PIN_MAX_SHARE : Infinity
  const left: Record<string, number> = {}
  let at = 0
  let last: string | null = null
  for (let i = 0; i < ids.length; i++) {
    const w = widths[i] ?? 0
    if (at + w > cap) break
    left[ids[i]] = at
    at += w
    last = ids[i]
  }
  return { left, last }
}

export function samePinLayout(a: PinLayout, b: PinLayout): boolean {
  if (a.last !== b.last) return false
  const ka = Object.keys(a.left)
  if (ka.length !== Object.keys(b.left).length) return false
  return ka.every((k) => a.left[k] === b.left[k])
}

/** Toggle a column's pin: pinning adds it after the existing pins. */
export function togglePin(pinned: readonly string[], id: string): string[] {
  return pinned.includes(id) ? pinned.filter((x) => x !== id) : [...pinned, id]
}
