import { createFileRoute } from "@tanstack/react-router"

import { RoutingListPage } from "@/components/routing/catalog-page"
import { ethernetSegmentList } from "@/components/routing/specs"

export const Route = createFileRoute("/ethernet-segments/")({
  component: () => <RoutingListPage spec={ethernetSegmentList} />,
})
