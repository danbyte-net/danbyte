import { createFileRoute } from "@tanstack/react-router"

import { RoutingCatalogDetail } from "@/components/routing/catalog-detail"
import { communityListDetail } from "@/components/routing/specs"

export const Route = createFileRoute("/community-lists/$id")({
  component: Page,
})

function Page() {
  const { id } = Route.useParams()
  return <RoutingCatalogDetail id={id} spec={communityListDetail} />
}
