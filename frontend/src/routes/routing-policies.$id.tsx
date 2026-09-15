import { createFileRoute } from "@tanstack/react-router"

import { RoutingCatalogDetail } from "@/components/routing/catalog-detail"
import { routingPolicyDetail } from "@/components/routing/specs"

export const Route = createFileRoute("/routing-policies/$id")({
  component: Page,
})

function Page() {
  const { id } = Route.useParams()
  return <RoutingCatalogDetail id={id} spec={routingPolicyDetail} />
}
