import { createFileRoute } from "@tanstack/react-router"

import { RoutingListPage } from "@/components/routing/catalog-page"
import { peerGroupList } from "@/components/routing/specs"

export const Route = createFileRoute("/bgp-peer-groups/")({
  component: () => <RoutingListPage spec={peerGroupList} />,
})
