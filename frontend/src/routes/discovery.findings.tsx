import { createFileRoute, Link } from "@tanstack/react-router"

import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/empty-state"
import { ListPageShell } from "@/components/list-page-shell"
import { FindingsPanel } from "@/components/discovery/findings-panel"
import { useDiscoveryStatus } from "@/components/discovery/status"

// The tenant-wide review queue (#451 B3): every proposal from the service
// scans' current observations on addresses you may view, and from the
// package inventory on hosts you may view.

export const Route = createFileRoute("/discovery/findings")({
  component: FindingsPage,
})

function FindingsPage() {
  const status = useDiscoveryStatus()
  if (status.data && !status.data.active)
    return (
      <div className="p-6">
        <EmptyState title="Discovery is off" />
      </div>
    )
  return (
    <ListPageShell
      title="Findings"
      backTo="/discovery"
      backLabel="Discovery"
      actions={
        <Button size="sm" variant="outline" asChild>
          <Link to="/discovery/services">Open ports</Link>
        </Button>
      }
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
