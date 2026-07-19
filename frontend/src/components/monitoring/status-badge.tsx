import type { CheckStatus } from "@/lib/api"
import { STATUS_COLOR, STATUS_LABEL, STATUS_TEXT } from "./charts"

// Solid status pill, sharing the exact palette of the racing-flag badge so a
// single "Up" and a green flag segment read as the same green.
export function CheckStatusBadge({ status }: { status: CheckStatus }) {
  const s = STATUS_COLOR[status] ? status : "unknown"
  return (
    <span
      className="inline-flex h-5 items-center rounded-[5px] px-2 text-xs font-medium ring-1 ring-black/10 ring-inset dark:ring-white/10"
      style={{ backgroundColor: STATUS_COLOR[s], color: STATUS_TEXT[s] }}
    >
      {STATUS_LABEL[s]}
    </span>
  )
}
