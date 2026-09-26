import { StatusBadge } from "@/components/status-badge"
import type { StatusMini } from "@/lib/api"

// A device card's lifecycle status: the shared StatusBadge pill, shrunk to
// card scale. Colour comes from the status row itself (never its name), and
// it is a pill - statuses are never a coloured dot. No `status_mini` (trace
// and LLDP-neighbour cards, which carry the reduced node shape) renders
// nothing.

/** Longest pill; a longer status name truncates. */
const PILL_MAX = 96
/** Horizontal padding plus the badge's 1px border on each side. */
const PILL_PAD = 14
/** 9px medium Inter, a little generous so the estimate never clips. */
const PILL_CHAR_W = 5.2
/** The flex gap between the name and the pill. */
const PILL_GAP = 6

/** What the sizing reads off a node's data. */
export type HasStatusPill = { status_mini?: Pick<StatusMini, "name"> | null }

/** The width a card reserves next to its name for the pill - 0 without
 * one. The card sizing functions add it, so dagre's box and the DOM agree. */
export function statusPillReserve(d: HasStatusPill): number {
  const name = d.status_mini?.name
  if (!name) return 0
  return (
    Math.min(PILL_MAX, PILL_PAD + Math.ceil(name.length * PILL_CHAR_W)) +
    PILL_GAP
  )
}

export function NodeStatusPill({
  status,
}: {
  status: StatusMini | null | undefined
}) {
  if (!status) return null
  return (
    <StatusBadge
      status={status}
      className="block h-4 max-w-24 shrink-0 truncate px-1.5 py-0 text-[9px] leading-[14px]"
    />
  )
}
