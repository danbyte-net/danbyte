import { createFileRoute } from "@tanstack/react-router"

import { RoutingCatalogDetail } from "@/components/routing/catalog-detail"
import { peerGroupDetail } from "@/components/routing/specs"

export const Route = createFileRoute("/bgp-peer-groups/$id")({
  component: Page,
})

function Page() {
  const { id } = Route.useParams()
  return <RoutingCatalogDetail id={id} spec={peerGroupDetail} />
}
