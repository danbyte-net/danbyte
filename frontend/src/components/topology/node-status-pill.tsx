import { StatusBadge } from "@/components/status-badge"
import type { StatusMini } from "@/lib/api"

// A device card's lifecycle status: the shared StatusBadge pill, shrunk to
// card scale. Colour comes from the status row itself (never its name), and
// it is a pill - statuses are never a coloured dot. No `status_mini` (trace
// cards, which carry the reduced node shape) renders nothing. The width a
// card reserves for it is `statusPillReserve` in card-metrics.ts.

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
