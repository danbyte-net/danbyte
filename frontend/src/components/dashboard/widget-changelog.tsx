import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api, type ChangeLogEntry, type Paginated } from "@/lib/api"
import { TimeCell } from "@/components/cells/time-ago"

const DOT: Record<string, string> = {
  create: "bg-emerald-500",
  update: "bg-amber-500",
  delete: "bg-red-500",
}

/** Dashboard widget: the most recent audit-log changes across the tenant -
 * who changed what, in one glance (issue #25). Mirrors the per-object History
 * tab, aggregated. */
export function ChangelogWidget() {
  const q = useQuery({
    queryKey: ["changelog", "widget"],
    queryFn: () =>
      api<Paginated<ChangeLogEntry>>("/api/changelog/?page_size=8"),
    staleTime: 30_000,
  })

  const rows = q.data?.results ?? []
  if (q.isLoading)
    return (
      <p className="px-1 py-6 text-center text-xs text-muted-foreground">
        Loading…
      </p>
    )
  if (rows.length === 0)
    return (
      <p className="px-1 py-6 text-center text-xs text-muted-foreground">
        No changes recorded yet.
      </p>
    )

  return (
    <div className="space-y-1">
      <ul className="divide-y divide-border">
        {rows.map((e) => (
          <li key={e.id} className="flex items-center gap-2 py-1.5 text-[13px]">
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${DOT[e.action] ?? "bg-zinc-400"}`}
              title={e.action_display}
            />
            <span className="min-w-0 flex-1 truncate">
              <span className="font-medium">{e.user_name || "system"}</span>{" "}
              <span className="text-muted-foreground">
                {e.action_display.toLowerCase()}
              </span>{" "}
              <Link to="/audit-log/$id" params={{ id: e.id }} className="link">
                {e.object_repr || e.object_label}
              </Link>
              <span className="text-muted-foreground"> · {e.object_label}</span>
            </span>
            <span className="shrink-0 text-[11px] text-muted-foreground">
              <TimeCell iso={e.timestamp} />
            </span>
          </li>
        ))}
      </ul>
      <Link
        to="/audit-log"
        className="link block pt-1 text-right text-[11px] text-muted-foreground"
      >
        View all changes →
      </Link>
    </div>
  )
}
