import type { StatusMini } from "@/lib/api"

// Card measurements the pure layout shares with the node renderers. No React
// here: layout.ts, its tests and the export pipeline read these without
// loading component modules.

/** Longest pill; a longer status name truncates (NodeStatusPill's
 * `max-w-24`). */
const PILL_MAX = 96
/** Horizontal padding plus the badge's 1px border on each side. */
const PILL_PAD = 14
/** 9px medium Inter, a little generous so the estimate never clips. */
const PILL_CHAR_W = 5.2
/** The flex gap between the name and the pill. */
const PILL_GAP = 6

/** What the sizing reads off a node's data. */
export type HasStatusPill = { status_mini?: Pick<StatusMini, "name"> | null }

/** The width a card reserves next to its name for the status pill - 0
 * without one. The card sizing functions add it, so dagre's box and the DOM
 * agree. */
export function statusPillReserve(d: HasStatusPill): number {
  const name = d.status_mini?.name
  if (!name) return 0
  return (
    Math.min(PILL_MAX, PILL_PAD + Math.ceil(name.length * PILL_CHAR_W)) +
    PILL_GAP
  )
}
