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

interface FastLaneHealth {
  alive: boolean
  checks: number
  probes_per_s: number
  at: string | null
  /** Sub-minute checks in the caller's view. */
  fast_checks_here: number
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
      api<{ stale_engines: StaleEngine[]; fast_lane?: FastLaneHealth }>(
        "/api/monitoring/engine-health/"
      ),
    refetchInterval: 60_000,
  })
  const stale = q.data?.stale_engines ?? []
  const lane = q.data?.fast_lane
  // The lane matters only where sub-minute checks exist: a tenant with
  // none never sees a banner about a process it does not use.
  const laneDown = !!lane && !lane.alive && lane.fast_checks_here > 0
  if (stale.length === 0 && !laneDown) return null
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-[13px] text-destructive lg:px-6">
      <AlertTriangle className="h-4 w-4 shrink-0" />
      {laneDown && lane && (
        <span>
          Fast lane not running -{" "}
          <span className="num">{lane.fast_checks_here}</span> sub-minute check
          {lane.fast_checks_here === 1 ? "" : "s"} on the minute beat until it
          is back.
        </span>
      )}
      {stale.map((e) => (
        <span key={e.id}>
          Engine <span className="font-semibold">{e.name}</span> unreachable
          (down {timeAgo(e.stale_since)}) -{" "}
          <span className="num">{e.stalled_checks}</span> check
          {e.stalled_checks === 1 ? "" : "s"} stalled.
        </span>
      ))}
      <Link
        to="/monitoring-engines"
        className="link ml-auto font-medium underline-offset-2"
      >
        Engines →
      </Link>
    </div>
  )
}
