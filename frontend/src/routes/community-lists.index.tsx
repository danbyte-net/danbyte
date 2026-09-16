import { createFileRoute } from "@tanstack/react-router"

import { RoutingListPage } from "@/components/routing/catalog-page"
import { communityListList } from "@/components/routing/specs"

export const Route = createFileRoute("/community-lists/")({
  component: () => <RoutingListPage spec={communityListList} />,
})
