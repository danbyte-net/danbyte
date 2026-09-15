import { createFileRoute } from "@tanstack/react-router"

import { RoutingCatalogDetail } from "@/components/routing/catalog-detail"
import { keychainDetail } from "@/components/routing/specs"

export const Route = createFileRoute("/routing-keychains/$id")({
  component: Page,
})

function Page() {
  const { id } = Route.useParams()
  return <RoutingCatalogDetail id={id} spec={keychainDetail} />
}
