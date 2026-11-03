import { createFileRoute } from "@tanstack/react-router"

import { RoutingListPage } from "@/components/routing/catalog-page"
import { roaList } from "@/components/routing/specs"

export const Route = createFileRoute("/roas/")({
  component: () => <RoutingListPage spec={roaList} />,
})
