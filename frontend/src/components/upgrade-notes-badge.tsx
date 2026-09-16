import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { UpgradeNotes } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { Badge } from "@/components/ui/badge"

/** Top-bar reminder that the running version still has operator steps to
 * do (an nginx block, a volume, …). Deployment admins only; goes away once
 * every step is marked done on the Updates page. */
export function UpgradeNotesBadge() {
  const { canManageDeployment } = useMe()
  const q = useQuery({
    queryKey: ["upgrade-notes"],
    queryFn: () => api<UpgradeNotes>("/api/system/upgrade-notes/"),
    enabled: canManageDeployment,
    staleTime: 30 * 60_000,
    retry: false,
  })
  const n = q.data?.pending.length ?? 0
  if (!canManageDeployment || n === 0) return null
  return (
    <Link to="/settings/updates">
      <Badge variant="warning">
        After upgrade: {n === 1 ? "1 step" : `${n} steps`}
      </Badge>
    </Link>
  )
}
