import { Link } from "@tanstack/react-router"

import type { CableMini } from "@/lib/api"

/**
 * CableMini chip — the one place a cable color is allowed to show (it's the
 * physical cable). Plain "—" when the port isn't cabled. Mirrors the cell used
 * by the pass-through ports pane.
 */
export function CableChip({ cable }: { cable: CableMini | null }) {
  if (!cable) return <span className="text-muted-foreground">—</span>
  return (
    <Link
      to="/cables/$id"
      params={{ id: cable.id }}
      className="inline-flex items-center gap-1.5 hover:underline"
    >
      <span
        className="h-2.5 w-2.5 rounded-sm border border-border"
        style={cable.color ? { backgroundColor: cable.color } : undefined}
      />
      <span className="font-mono text-xs">{cable.type || "cable"}</span>
    </Link>
  )
}
