import { createFileRoute } from "@tanstack/react-router"

import { EmptyState } from "@/components/empty-state"
import { ListPageShell } from "@/components/list-page-shell"
import { DiscoveryFrame } from "@/components/discovery/discovery-frame"
import { useMonitoringCrumb } from "@/components/monitoring/monitoring-tabs"
import { ObservedServicesPanel } from "@/components/discovery/findings-panel"
import { useDiscoveryStatus } from "@/components/discovery/status"

// Every open port the service scans found on addresses you may view
// (#451 B3), with what answered there.

export const Route = createFileRoute("/discovery/services")({
  component: ServicesPage,
})

function ServicesPage() {
  return (
    <DiscoveryFrame value="ports">
      <ServicesPageBody />
    </DiscoveryFrame>
  )
}

function ServicesPageBody() {
  const status = useDiscoveryStatus()
  const crumb = useMonitoringCrumb()
  if (status.data && !status.data.active)
    return (
      <div className="p-6">
        <EmptyState title="Discovery is off" />
      </div>
    )
  return (
    <ListPageShell
      title="Open ports"
      {...crumb}
      query={
        status.isLoading
          ? { isLoading: true, isError: false, error: null }
          : undefined
      }
    >
      <ObservedServicesPanel />
    </ListPageShell>
  )
}
