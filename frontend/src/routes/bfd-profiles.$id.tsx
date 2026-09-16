import { createFileRoute } from "@tanstack/react-router"

import { RoutingCatalogDetail } from "@/components/routing/catalog-detail"
import { bfdProfileDetail } from "@/components/routing/specs"

export const Route = createFileRoute("/bfd-profiles/$id")({
  component: Page,
})

function Page() {
  const { id } = Route.useParams()
  return <RoutingCatalogDetail id={id} spec={bfdProfileDetail} />
}
