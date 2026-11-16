import { createFileRoute } from "@tanstack/react-router"

import { monitoringSearch } from "@/lib/monitoring-nav"
import { usePageTitle } from "@/lib/page-title"
import { MonitoringConfiguration } from "@/components/monitoring/configuration"
import { MonitoringTabs } from "@/components/monitoring/monitoring-tabs"

// Monitoring → Policies: what checks apply to what, scope by scope down the
// inheritance chain (`?scope=`). Was /monitoring?view=configuration, which
// redirects here with its scope.
export const Route = createFileRoute("/monitoring_/policies")({
  component: PoliciesPage,
  validateSearch: monitoringSearch<never>([]),
})

function PoliciesPage() {
  usePageTitle("Monitoring policies")
  return (
    <MonitoringTabs label="Policies" banner={false}>
      <MonitoringConfiguration />
    </MonitoringTabs>
  )
}
