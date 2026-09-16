import { createFileRoute } from "@tanstack/react-router"

import { RoutingCatalogDetail } from "@/components/routing/catalog-detail"
import { prefixListDetail } from "@/components/routing/specs"

export const Route = createFileRoute("/prefix-lists/$id")({
  component: Page,
})

function Page() {
  const { id } = Route.useParams()
  return <RoutingCatalogDetail id={id} spec={prefixListDetail} />
}
