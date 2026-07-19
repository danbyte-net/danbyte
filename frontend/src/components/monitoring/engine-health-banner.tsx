import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { AlertTriangle } from "lucide-react"

import { api } from "@/lib/api"
import { timeAgo } from "@/components/cells/time-ago"

interface StaleEngine {
  id: string
  name: string
  stale_since: string
  last_seen_at: string | null
  stalled_checks: number
}

/**
 * Red strip shown when a remote monitoring engine (Outpost) with assigned
 * checks has stopped polling (issue #154). The dispatcher stamps
 * `stale_since`; this just surfaces it so a dead engine is impossible to miss
 * without visiting the Engines page. Renders nothing when everything is fine.
 */
export function EngineHealthBanner() {
  const q = useQuery({
    queryKey: ["engine-health"],
    queryFn: () =>
      api<{ stale_engines: StaleEngine[] }>("/api/monitoring/engine-health/"),
    refetchInterval: 60_000,
  })
  const stale = q.data?.stale_engines ?? []
  if (stale.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-[13px] text-destructive lg:px-6">
      <AlertTriangle className="h-4 w-4 shrink-0" />
      {stale.map((e) => (
        <span key={e.id}>
          Engine <span className="font-semibold">{e.name}</span> unreachable
          (down {timeAgo(e.stale_since)}) —{" "}
          <span className="num">{e.stalled_checks}</span> check
          {e.stalled_checks === 1 ? "" : "s"} stalled.
        </span>
      ))}
      <Link
        to="/monitoring-engines"
        className="ml-auto font-medium underline-offset-2 hover:underline"
      >
        Engines →
      </Link>
    </div>
  )
}
