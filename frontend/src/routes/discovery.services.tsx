import { createFileRoute, Link } from "@tanstack/react-router"

import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/empty-state"
import { ListPageShell } from "@/components/list-page-shell"
import { ObservedServicesPanel } from "@/components/discovery/findings-panel"
import { useDiscoveryStatus } from "@/components/discovery/status"

// Every open port the service scans found on addresses you may view
// (#451 B3), with what answered there.

export const Route = createFileRoute("/discovery/services")({
  component: ServicesPage,
})

function ServicesPage() {
  const status = useDiscoveryStatus()
  if (status.data && !status.data.active)
    return (
      <div className="p-6">
        <EmptyState title="Discovery is off" />
      </div>
    )
  return (
    <ListPageShell
      title="Open ports"
      backTo="/discovery"
      backLabel="Discovery"
      actions={
        <Button size="sm" variant="outline" asChild>
          <Link to="/discovery/findings">Findings</Link>
        </Button>
      }
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
