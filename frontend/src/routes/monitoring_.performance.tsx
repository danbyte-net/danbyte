import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { monitoringSearch, PERFORMANCE_VIEWS } from "@/lib/monitoring-nav"
import type { PerformanceView } from "@/lib/monitoring-nav"
import { ExploreView } from "@/components/monitoring/explore-view"
import { LatencyView } from "@/components/monitoring/latency-view"
import { MonitoringTabs } from "@/components/monitoring/monitoring-tabs"

// Monitoring → Performance: availability and latency over a window - the
// estate grouped by one dimension (Explore), and one check kind's latency
// (Latency). Was /monitoring?view=explore and ?view=latency.
export const Route = createFileRoute("/monitoring_/performance")({
  component: PerformancePage,
  validateSearch: monitoringSearch(PERFORMANCE_VIEWS),
})

function PerformancePage() {
  const view: PerformanceView = Route.useSearch().view ?? "explore"
  const nav = useNavigate()
  return (
    <MonitoringTabs
      label="Performance views"
      value={view}
      onValueChange={(v) =>
        nav({
          to: "/monitoring/performance",
          search: v === "explore" ? {} : { view: v },
        })
      }
      items={[
        { value: "explore", label: "Explore" },
        { value: "latency", label: "Latency" },
      ]}
      padded={view === "latency"}
    >
      {view === "explore" && <ExploreView />}
      {view === "latency" && <LatencyView />}
    </MonitoringTabs>
  )
}
