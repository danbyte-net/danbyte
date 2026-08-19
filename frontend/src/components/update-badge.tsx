import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api, type SystemUpdates } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { Badge } from "@/components/ui/badge"

/** Top-bar "Update available" badge (#25). Only shown to users who can manage
 * updates (the /api/system/updates check is `users.manage`-gated anyway), and
 * hidden when an admin turns the badge off. Links to the Updates page. Uses the
 * same blue badge as that page. */
export function UpdateBadge() {
  const { canManageDeployment } = useMe()
  const q = useQuery({
    queryKey: ["system-updates"],
    queryFn: () => api<SystemUpdates>("/api/system/updates/"),
    enabled: canManageDeployment,
    staleTime: 30 * 60_000,
    retry: false,
  })
  const d = q.data
  if (!canManageDeployment || !d?.update_available || d.badge_hidden)
    return null
  return (
    <Link
      to="/settings/updates"
      title={`Update available - you're on ${d.current.version}`}
    >
      <Badge className="bg-primary text-primary-foreground hover:bg-primary/90">
        Update available
      </Badge>
    </Link>
  )
}
