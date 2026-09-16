import { createFileRoute } from "@tanstack/react-router"

import { RoutingCatalogDetail } from "@/components/routing/catalog-detail"
import { communityDetail } from "@/components/routing/specs"

export const Route = createFileRoute("/communities/$id")({
  component: Page,
})

function Page() {
  const { id } = Route.useParams()
  return <RoutingCatalogDetail id={id} spec={communityDetail} />
}
