import { Link } from "@tanstack/react-router"
import { ChevronRight } from "lucide-react"

import type { CoolingHop, CoolingPath, CoolingPathStatus } from "@/lib/api"
import { Badge } from "@/components/ui/badge"

/** A cooling path (#434) - source → feed → CDUs → device - as one line of
 * links, upstream first. Hops the caller may not view read "Hidden". */

const STATUS: Record<
  CoolingPathStatus,
  { label: string; variant: "success" | "warning" | "destructive" }
> = {
  fed: { label: "Fed", variant: "success" },
  open: { label: "Not connected", variant: "warning" },
  loop: { label: "Loop", variant: "destructive" },
  truncated: { label: "Too deep", variant: "warning" },
}

export function CoolingPathStatusBadge({
  status,
}: {
  status: CoolingPathStatus
}) {
  const s = STATUS[status]
  return <Badge variant={s.variant}>{s.label}</Badge>
}

function HopLink({ hop }: { hop: CoolingHop }) {
  if (hop.hidden)
    return <span className="text-muted-foreground italic">Hidden</span>
  if (hop.kind === "source")
    return (
      <Link to="/cooling-sources/$id" params={{ id: hop.id }} className="link">
        {hop.name}
      </Link>
    )
  if (hop.kind === "feed")
    return (
      <Link to="/cooling-feeds/$id" params={{ id: hop.id }} className="link">
        {hop.name}
      </Link>
    )
  return (
    <Link to="/devices/$id" params={{ id: hop.id }} className="link">
      {hop.name}
    </Link>
  )
}

export function CoolingPathHops({ path }: { path: CoolingPath }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1 gap-y-0.5">
      {path.hops.map((hop, i) => (
        <span key={i} className="inline-flex items-center gap-x-1">
          {i > 0 && (
            <ChevronRight
              className="h-3 w-3 text-muted-foreground"
              aria-hidden="true"
            />
          )}
          <HopLink hop={hop} />
        </span>
      ))}
    </span>
  )
}

/** The path as plain text - "CRAH-1 → Loop A → cdu1 → srv1". */
export function coolingPathText(path: CoolingPath): string {
  return path.hops.map((h) => (h.hidden ? "…" : h.name)).join(" → ")
}
