import { Link } from "@tanstack/react-router"

import type { TopChanger } from "@/lib/api"
import { Badge } from "@/components/ui/badge"

/**
 * The addresses and checks that changed most in the window - the noisy
 * ten, as bars scaled to the noisiest, with how many of the changes went
 * bad. Each row opens the address's Monitoring tab.
 */
export function TopChanges({
  rows,
  className,
}: {
  rows: TopChanger[]
  className?: string
}) {
  if (rows.length === 0) return null
  const max = Math.max(...rows.map((r) => r.changes))
  return (
    <div className={className}>
      <div className="mb-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        Most changes
      </div>
      <ul className="space-y-1">
        {rows.map((r) => (
          <li
            key={`${r.ip_id}:${r.template_id ?? r.template_name}`}
            className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto] items-center gap-2 text-[12px]"
          >
            <span className="flex min-w-0 flex-col leading-tight">
              <Link
                to="/ips/$id"
                params={{ id: r.ip_id }}
                search={{ tab: "monitoring" }}
                className="link truncate font-mono"
              >
                {r.ip_address}
              </Link>
              <span className="truncate text-[10px] text-muted-foreground">
                {r.dns_name ?? r.template_name}
              </span>
            </span>
            <span className="h-2 overflow-hidden rounded-[2px] bg-muted">
              <span
                className="block h-full rounded-[2px] bg-primary"
                style={{ width: `${(100 * r.changes) / max}%` }}
              />
            </span>
            <span className="inline-flex items-center gap-1">
              <Badge variant="secondary" className="num">
                {r.changes}
              </Badge>
              {r.bad > 0 && (
                <Badge variant="destructive" className="num">
                  {r.bad} bad
                </Badge>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
