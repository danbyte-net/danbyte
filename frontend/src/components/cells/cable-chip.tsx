import { Link } from "@tanstack/react-router"

import type { CableMini } from "@/lib/api"
import { cssColor } from "@/lib/utils"

/**
 * CableMini chip - the one place a cable color is allowed to show (it's the
 * physical cable). Plain "-" when the port isn't cabled. Mirrors the cell used
 * by the pass-through ports pane.
 */
export function CableChip({ cable }: { cable: CableMini | null }) {
  if (!cable) return <span className="text-muted-foreground">-</span>
  return (
    <Link
      to="/cables/$id"
      params={{ id: cable.id }}
      className="link inline-flex items-center gap-1.5"
    >
      <span
        className="h-2.5 w-2.5 rounded-sm border border-border"
        style={
          cable.color ? { backgroundColor: cssColor(cable.color) } : undefined
        }
      />
      <span className="font-mono text-xs">{cable.type || "cable"}</span>
    </Link>
  )
}
