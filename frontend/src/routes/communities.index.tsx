import { createFileRoute } from "@tanstack/react-router"

import { RoutingListPage } from "@/components/routing/catalog-page"
import { communityList } from "@/components/routing/specs"

export const Route = createFileRoute("/communities/")({
  component: () => <RoutingListPage spec={communityList} />,
})
