import { createFileRoute } from "@tanstack/react-router"

import { DiscoveryFrame } from "@/components/discovery/discovery-frame"
import { DiscoveryTab } from "@/components/discovery/discovery-tab"

// Monitoring → Discovery (#451): the tenant's discovery profiles and their
// latest runs, with Findings and Open ports as the next tabs. It was a tab
// of the one-page Monitoring; /monitoring?view=discovery redirects here.

export const Route = createFileRoute("/discovery/")({
  component: () => (
    <DiscoveryFrame value="profiles">
      <DiscoveryTab />
    </DiscoveryFrame>
  ),
})
