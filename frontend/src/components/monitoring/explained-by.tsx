import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { Network } from "lucide-react"

import { api } from "@/lib/api"
import type { AlertRootCause, AlertsResponse } from "@/lib/api"

/** "Explained by core-1" on a device's overview while a down upstream
 * explains its alerts (#450). Renders nothing otherwise. */
export function ExplainedBy({ deviceId }: { deviceId: string }) {
  const q = useQuery({
    queryKey: ["alerts", "explained-by", deviceId],
    queryFn: () =>
      api<AlertsResponse>(
        `/api/monitoring/alerts/?status=firing&explained=only&device=${deviceId}`
      ),
    refetchInterval: 60_000,
    staleTime: 30_000,
  })
  const roots = new Map<string, AlertRootCause>()
  for (const a of q.data?.results ?? [])
    if (a.root_cause) roots.set(a.root_cause.id, a.root_cause)
  if (roots.size === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-card px-4 py-2 text-sm">
      <Network className="h-4 w-4 text-muted-foreground" />
      <span className="text-muted-foreground">Explained by</span>
      {[...roots.values()].map((rc, i) => (
        <span key={rc.id}>
          {i > 0 && <span className="text-muted-foreground">, </span>}
          <Link
            to="/root-causes/$id"
            params={{ id: rc.id }}
            className="link font-medium"
          >
            {rc.device.name}
          </Link>
        </span>
      ))}
    </div>
  )
}
