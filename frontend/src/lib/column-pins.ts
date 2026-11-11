// Pinned columns in DataTable: which columns stick to the left edge, and
// where. Pure, so the rules are tested without a browser.
//
// A pinned column keeps its place in the table. It sticks only once sideways
// scrolling would carry it past the left edge - stacking after the pinned
// columns before it - and scrolling back sets it down in its place again.

/** Pins are ignored in a frame narrower than this (phones, slim dialogs):
 * there is no room for columns that never scroll. */
export const PIN_MIN_FRAME = 640

/** Stuck columns may take at most this share of the frame. A pin that would
 * pass it - and every pin after it - scrolls like any other column, so some
 * of the table always scrolls. */
export const PIN_MAX_SHARE = 0.6

/** Columns that can never be pinned by hand: the row tick (pinned
 * automatically whenever anything is) and the row actions (already stuck to
 * the right edge). */
export const UNPINNABLE = new Set(["select", "actions"])

/** The columns that stick: the user's pins that are on show, plus the
 * selection column whenever anything is pinned. Order does not matter - the
 * table's own column order decides where each one sits. */
export function pinnedColumns(
  pinned: readonly string[],
  opts: {
    hasSelect: boolean
    isShown: (id: string) => boolean
    canPin: (id: string) => boolean
    /** The frame's width, 0 while unmeasured. */
    frameWidth: number
  }
): Set<string> {
  if (opts.frameWidth > 0 && opts.frameWidth < PIN_MIN_FRAME) return new Set()
  const ids = pinned.filter(
    (id) => !UNPINNABLE.has(id) && opts.canPin(id) && opts.isShown(id)
  )
  if (!ids.length) return new Set()
  return new Set(opts.hasSelect ? ["select", ...ids] : ids)
}

export interface PinLayout {
  /** Sticky `left` offset (px) per sticking column. */
  left: Record<string, number>
  /** Where each sticking column starts before any scrolling (px). */
  natural: Record<string, number>
}

export const NO_PIN_LAYOUT: PinLayout = { left: {}, natural: {} }

/** Offsets for the pinned columns from the measured widths of every shown
 * column, in display order. A pinned column sticks after the pinned columns
 * before it, until the stuck band would pass PIN_MAX_SHARE of the frame;
 * from there on its pins scroll. */
export function pinLayout(
  columns: readonly { id: string; width: number }[],
  pinned: ReadonlySet<string>,
  frameWidth: number
): PinLayout {
  const cap = frameWidth > 0 ? frameWidth * PIN_MAX_SHARE : Infinity
  const left: Record<string, number> = {}
  const natural: Record<string, number> = {}
  let x = 0
  let band = 0
  let capped = false
  for (const c of columns) {
    if (pinned.has(c.id) && !capped) {
      if (band + c.width > cap) capped = true
      else {
        left[c.id] = band
        natural[c.id] = x
        band += c.width
      }
    }
    x += c.width
  }
  return { left, natural }
}

/** The right-most column that is stuck at `scrollLeft` - it carries the
 * divider. A column is stuck once the table has scrolled it to its offset. */
export function lastStuck(
  layout: PinLayout,
  scrollLeft: number
): string | null {
  let last: string | null = null
  let at = -1
  for (const [id, l] of Object.entries(layout.left)) {
    const n = layout.natural[id]
    if (scrollLeft > n - l + 0.5 && l > at) {
      at = l
      last = id
    }
  }
  return last
}

export function samePinLayout(a: PinLayout, b: PinLayout): boolean {
  const ka = Object.keys(a.left)
  if (ka.length !== Object.keys(b.left).length) return false
  return ka.every(
    (k) => a.left[k] === b.left[k] && a.natural[k] === b.natural[k]
  )
}

/** Toggle a column's pin. */
export function togglePin(pinned: readonly string[], id: string): string[] {
  return pinned.includes(id) ? pinned.filter((x) => x !== id) : [...pinned, id]
}
