import { createFileRoute } from "@tanstack/react-router"

import { RoutingCatalogDetail } from "@/components/routing/catalog-detail"
import { ethernetSegmentDetail } from "@/components/routing/specs"

export const Route = createFileRoute("/ethernet-segments/$id")({
  component: Page,
})

function Page() {
  const { id } = Route.useParams()
  return <RoutingCatalogDetail id={id} spec={ethernetSegmentDetail} />
}
