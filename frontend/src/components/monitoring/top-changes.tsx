import { useState } from "react"
import { Link } from "@tanstack/react-router"

import type { TopChanger } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

const PAGE = 10

/**
 * The addresses and checks that changed most in the window, as bars scaled
 * to the noisiest, with how many of the changes went bad. Ten at a time
 * from the fifty the server sends; each row opens the address.
 */
export function TopChanges({
  rows,
  className,
}: {
  rows: TopChanger[]
  className?: string
}) {
  const [page, setPage] = useState(1)
  if (rows.length === 0) return null
  const pages = Math.max(1, Math.ceil(rows.length / PAGE))
  const current = Math.min(page, pages)
  const slice = rows.slice((current - 1) * PAGE, current * PAGE)
  const max = Math.max(...rows.map((r) => r.changes))
  return (
    <div className={"flex h-full flex-col " + (className ?? "")}>
      <div className="mb-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        Most changes
      </div>
      <ul className="flex-1 space-y-1">
        {slice.map((r) => (
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
      {pages > 1 && (
        <div className="mt-2 flex items-center justify-end gap-2 text-[11px] text-muted-foreground">
          <span className="num">
            {current} of {pages}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            disabled={current <= 1}
            onClick={() => setPage(current - 1)}
          >
            Prev
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            disabled={current >= pages}
            onClick={() => setPage(current + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  )
}
