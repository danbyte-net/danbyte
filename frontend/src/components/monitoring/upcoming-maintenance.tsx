import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Wrench, Zap } from "lucide-react"

import { api, type MaintenanceEvent, type Paginated } from "@/lib/api"
import { useDateFormat } from "@/lib/datetime"
import { StatusBadge } from "@/components/status-badge"

/**
 * "What maintenance touches this object?" - the reverse of an event's impact
 * list, for device/circuit detail pages. Renders nothing when no open event
 * names this object, so it costs no space on the quiet majority of pages.
 */
export function UpcomingMaintenancePanel({
  objectType,
  objectId,
}: {
  /** RBAC slug, e.g. "device" or "circuit". */
  objectType: string
  objectId: string
}) {
  const { formatDateTime } = useDateFormat()
  const q = useQuery({
    queryKey: ["maintenance-events", "for", objectType, objectId],
    queryFn: () =>
      api<Paginated<MaintenanceEvent>>(
        `/api/monitoring/maintenance-events/?open=1&object_type=${objectType}&object_id=${objectId}`
      ),
    staleTime: 60_000,
  })
  const events = q.data?.results ?? []
  if (events.length === 0) return null

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="border-b border-border bg-muted/40 px-3 py-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        Planned maintenance & outages
      </div>
      <ul className="divide-y divide-border">
        {events.map((e) => (
          <li key={e.id} className="flex items-center gap-2 px-3 py-2">
            {e.kind === "outage" ? (
              <Zap className="h-3.5 w-3.5 shrink-0 text-red-600 dark:text-red-400" />
            ) : (
              <Wrench className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
            )}
            <Link
              to="/maintenance/$id/edit"
              params={{ id: e.id }}
              className="link min-w-0 flex-1 truncate text-[13px] font-medium"
            >
              {e.name}
            </Link>
            <StatusBadge status={e.status} />
            <span className="num text-[11px] whitespace-nowrap text-muted-foreground">
              {formatDateTime(e.starts_at)}
              {e.ends_at ? ` → ${formatDateTime(e.ends_at)}` : ""}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
