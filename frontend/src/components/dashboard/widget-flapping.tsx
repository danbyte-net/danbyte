import { Link } from "@tanstack/react-router"

import type { FlappingRow } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { TimeCell } from "@/components/cells/time-ago"
import { FlappingPill } from "@/components/monitoring/flapping-pill"

/** Dashboard widget: the checks currently flagged as flapping, noisiest
 * first, from the dashboard payload (site-scoped like the rest of it). Each
 * row opens the address; the footer opens the Flapping view where they can
 * be confirmed in bulk. */
export function FlappingWidget({ rows }: { rows: FlappingRow[] }) {
  if (!rows.length)
    return (
      <div className="flex h-full min-h-[120px] items-center justify-center text-sm text-muted-foreground">
        Nothing is flapping.
      </div>
    )
  return (
    <div className="flex h-full flex-col">
      <ul className="divide-y divide-border/60">
        {rows.map((r) => (
          <li
            key={r.state_id}
            className="flex items-center gap-2 py-1.5 text-[13px]"
          >
            <FlappingPill />
            <Link
              to="/ips/$id"
              params={{ id: r.ip_id }}
              search={{ tab: "monitoring" }}
              className="link truncate font-mono font-medium"
            >
              {r.ip_address}
            </Link>
            <span className="truncate text-muted-foreground">
              {r.template_name ?? r.kind}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-2">
              <Badge variant="secondary" className="num">
                {r.flap_count} / {r.window_minutes}m
              </Badge>
              <TimeCell iso={r.flapping_since} />
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-auto pt-2 text-right">
        <Link
          to="/monitoring"
          search={{ view: "flapping", status: "all" }}
          className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
        >
          All flapping
        </Link>
      </div>
    </div>
  )
}
