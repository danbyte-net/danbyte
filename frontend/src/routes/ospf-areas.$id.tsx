import { createFileRoute } from "@tanstack/react-router"

import { RoutingCatalogDetail } from "@/components/routing/catalog-detail"
import { ospfAreaDetail } from "@/components/routing/specs"

export const Route = createFileRoute("/ospf-areas/$id")({
  component: Page,
})

function Page() {
  const { id } = Route.useParams()
  return <RoutingCatalogDetail id={id} spec={ospfAreaDetail} />
}
