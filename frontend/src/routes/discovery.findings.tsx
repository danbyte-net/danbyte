import { createFileRoute } from "@tanstack/react-router"

import { EmptyState } from "@/components/empty-state"
import { ListPageShell } from "@/components/list-page-shell"
import { DiscoveryFrame } from "@/components/discovery/discovery-frame"
import { useMonitoringCrumb } from "@/components/monitoring/monitoring-tabs"
import { FindingsPanel } from "@/components/discovery/findings-panel"
import { useDiscoveryStatus } from "@/components/discovery/status"

// The tenant-wide review queue (#451 B3): every proposal from the service
// scans' current observations on addresses you may view, and from the
// package inventory on hosts you may view.

export const Route = createFileRoute("/discovery/findings")({
  component: FindingsPage,
})

function FindingsPage() {
  return (
    <DiscoveryFrame value="findings">
      <FindingsPageBody />
    </DiscoveryFrame>
  )
}

function FindingsPageBody() {
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
      title="Findings"
      {...crumb}
      query={
        status.isLoading
          ? { isLoading: true, isError: false, error: null }
          : undefined
      }
    >
      <FindingsPanel />
    </ListPageShell>
  )
}
