import { createFileRoute } from "@tanstack/react-router"

import { RoutingListPage } from "@/components/routing/catalog-page"
import { ospfAreaList } from "@/components/routing/specs"

export const Route = createFileRoute("/ospf-areas/")({
  component: () => <RoutingListPage spec={ospfAreaList} />,
})
