import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { CHECKS_VIEWS, monitoringSearch } from "@/lib/monitoring-nav"
import type { ChecksView } from "@/lib/monitoring-nav"
import { ChecksList } from "@/components/monitoring/checks-list"
import { MonitoringTabs } from "@/components/monitoring/monitoring-tabs"
import { TemplatesList } from "@/components/monitoring/templates-list"

// Monitoring → Checks: every check in the tenant, and the check templates
// they are built from (was /monitoring?view=checks and
// ?view=templates, which redirect here).
export const Route = createFileRoute("/monitoring_/checks/")({
  component: ChecksPage,
  validateSearch: monitoringSearch(CHECKS_VIEWS),
})

function ChecksPage() {
  const view: ChecksView = Route.useSearch().view ?? "checks"
  const nav = useNavigate()
  return (
    <MonitoringTabs
      label="Checks views"
      value={view}
      onValueChange={(v) =>
        nav({
          to: "/monitoring/checks",
          search: v === "checks" ? {} : { view: v },
        })
      }
      items={[
        { value: "checks", label: "Checks" },
        { value: "templates", label: "Templates" },
      ]}
    >
      {view === "checks" && <ChecksList />}
      {view === "templates" && <TemplatesList />}
    </MonitoringTabs>
  )
}
