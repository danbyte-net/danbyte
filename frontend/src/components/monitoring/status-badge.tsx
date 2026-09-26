import type { CheckStatus } from "@/lib/api"
import { cn } from "@/lib/utils"
import { STATUS_LABEL } from "./charts"
import {
  statusColor,
  statusLabel,
  statusTextColor,
  useStatusLabels,
} from "./status-palette"

/**
 * Solid status pill, sharing the exact palette of the racing-flag badge so a
 * single "Up" and a green flag segment read as the same green. Both take the
 * name and colour from the tenant's catalog when it has claimed the state.
 */
export function CheckStatusBadge({
  status,
  className,
}: {
  status: CheckStatus
  /** Size overrides for dense surfaces (a topology card). */
  className?: string
}) {
  const labels = useStatusLabels()
  // A state Danbyte does not ship reads as Unknown rather than as its raw
  // slug - an older Outpost sending something new must not paint gibberish.
  const s = STATUS_LABEL[status] ? status : "unknown"
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-[5px] px-2 text-xs font-medium ring-1 ring-black/10 ring-inset dark:ring-white/10",
        className
      )}
      style={{
        backgroundColor: statusColor(s, labels),
        color: statusTextColor(s, labels),
      }}
    >
      {statusLabel(s, labels)}
    </span>
  )
}
