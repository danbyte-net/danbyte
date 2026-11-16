import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { FlappingRow } from "@/lib/api"
import { usePageTitle } from "@/lib/page-title"
import {
  legacyHref,
  legacyMonitoringTarget,
  monitoringSearch,
  STATUS_VIEWS,
} from "@/lib/monitoring-nav"
import type { MonitoringSearch, StatusView } from "@/lib/monitoring-nav"
import { ChecksList } from "@/components/monitoring/checks-list"
import { HistoryView } from "@/components/monitoring/history-view"
import { MonitoringOverview } from "@/components/monitoring/monitoring-overview"
import { MonitoringTabs } from "@/components/monitoring/monitoring-tabs"

export const Route = createFileRoute("/monitoring")({
  component: MonitoringPage,
  validateSearch: monitoringSearch(STATUS_VIEWS),
  // The page used to hold every Monitoring tab; an old `?view=` (or `?tab=`)
  // link lands on the page that tab moved to, filters and all.
  beforeLoad: ({ location }) => redirectLegacy(location),
})

function redirectLegacy(location: { search: unknown; hash: string }): void {
  const target = legacyMonitoringTarget(
    location.search as Record<string, unknown>
  )
  if (target) throw redirect({ href: legacyHref(target, location.hash) })
}

/** Monitoring → Status: the Overview, the checks flapping now (a tab only
 * while there are some, or when a link asks for it) and the history of
 * status changes. */
function MonitoringPage() {
  usePageTitle("Monitoring")
  const search: MonitoringSearch<StatusView> = Route.useSearch()
  const view: StatusView = search.view ?? "overview"
  const nav = useNavigate()
  // Changing tab starts clean - a history filter has no business on the
  // Overview.
  const go = (next: StatusView) =>
    nav({
      to: "/monitoring",
      search: next === "overview" ? {} : { view: next },
    })

  const flapping = useQuery({
    queryKey: ["monitoring-flapping"],
    queryFn: () => api<{ results: FlappingRow[] }>("/api/monitoring/flapping/"),
    refetchInterval: 60_000,
  })
  const flaps = flapping.data?.results ?? []

  return (
    <MonitoringTabs
      crumb={false}
      label="Status views"
      value={view}
      onValueChange={go}
      padded={view === "overview"}
      items={[
        { value: "overview", label: "Overview" },
        ...(flaps.length > 0 || view === "flapping"
          ? [
              {
                value: "flapping" as const,
                label: "Flapping",
                count: flaps.length,
              },
            ]
          : []),
        { value: "history", label: "History" },
      ]}
    >
      {view === "overview" && <MonitoringOverview flapping={flaps.length} />}
      {view === "history" && <HistoryView />}
      {view === "flapping" && <ChecksList flappingOnly />}
    </MonitoringTabs>
  )
}
