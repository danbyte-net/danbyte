import { ColorBadge } from "@/components/cells/color-badge"
import type { StatusMini } from "@/lib/api"

/**
 * The one status badge for every object type. Renders the status object's
 * own colour (a definable Status row), so "Active" reads identically on
 * devices, prefixes, IPs, … — no more per-model hardcoded colours.
 */
export function StatusBadge({
  status,
}: {
  status: StatusMini | null | undefined
}) {
  if (!status) return <span className="text-muted-foreground">—</span>
  return <ColorBadge name={status.name} color={status.color || undefined} />
}
