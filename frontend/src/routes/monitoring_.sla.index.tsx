import { createFileRoute } from "@tanstack/react-router"

import { SlaList } from "@/components/monitoring/sla-list"
import { MonitoringTabs } from "@/components/monitoring/monitoring-tabs"

// Monitoring → SLAs: every agreement with this period's figure against its
// target. Was /monitoring?view=sla, which redirects here.
export const Route = createFileRoute("/monitoring_/sla/")({
  component: SlaPage,
})

function SlaPage() {
  return (
    <MonitoringTabs label="SLAs">
      <SlaList />
    </MonitoringTabs>
  )
}
