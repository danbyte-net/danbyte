import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { VulnPriority, VulnSummary } from "@/lib/api"
import { EmptyState } from "@/components/empty-state"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { PRIORITY_LABELS, PRIORITY_ORDER } from "@/components/vulnerabilities/badges"
import { useVulnSettings } from "@/components/vulnerabilities/use-vuln-settings"

// Dashboard widget "Vulnerabilities" (#451): open records per priority, the
// ones known exploited and the ones new this week - each count opens the
// Vulnerabilities page filtered to it (the same facet, so the numbers agree).

const TONE: Record<VulnPriority | "kev" | "new", string> = {
  fix_first: "text-red-600 dark:text-red-400",
  kev: "text-red-600 dark:text-red-400",
  high: "text-amber-600 dark:text-amber-400",
  medium: "text-foreground",
  low: "text-foreground",
  new: "text-foreground",
}

type Tile = {
  key: VulnPriority | "kev" | "new"
  label: string
  n: number
  search: Record<string, string>
}

export function vulnTiles(s: VulnSummary): Tile[] {
  return [
    ...PRIORITY_ORDER.map((p) => ({
      key: p,
      label: PRIORITY_LABELS[p],
      n: s.by_priority[p] ?? 0,
      search: { priority: p },
    })),
    { key: "kev", label: "Known exploited", n: s.kev, search: { kev: "yes" } },
    {
      key: "new",
      label: "New this week",
      n: s.new_this_week,
      search: { first_seen: "7d" },
    },
  ]
}

export function VulnerabilitiesWidget() {
  const settings = useVulnSettings()
  const q = useQuery({
    queryKey: ["vulnerability-summary"],
    queryFn: () => api<VulnSummary>("/api/vulnerabilities/summary/"),
    enabled: settings.enabled,
    staleTime: 60_000,
  })
  if (settings.isLoading) return <Loading className="min-h-[80px]" />
  if (!settings.enabled)
    return <EmptyState title="Vulnerability data is off" />
  if (q.isLoading) return <Loading className="min-h-[80px]" />
  if (q.isError) return <QueryError error={q.error} />
  if (!q.data) return null
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {vulnTiles(q.data).map((t) => (
        <Link
          key={t.key}
          to="/vulnerabilities"
          search={t.search}
          className="flex flex-col justify-center rounded-md border border-border p-2 hover:bg-muted/40"
        >
          <span
            className={`text-xl font-semibold tabular-nums ${
              t.n > 0 ? TONE[t.key] : "text-muted-foreground"
            }`}
          >
            {t.n.toLocaleString()}
          </span>
          <span className="mt-0.5 text-[11px] whitespace-nowrap text-muted-foreground">
            {t.label}
          </span>
        </Link>
      ))}
    </div>
  )
}
