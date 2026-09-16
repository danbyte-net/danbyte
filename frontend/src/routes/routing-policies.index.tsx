import { createFileRoute } from "@tanstack/react-router"

import { RoutingListPage } from "@/components/routing/catalog-page"
import { routingPolicyList } from "@/components/routing/specs"

export const Route = createFileRoute("/routing-policies/")({
  component: () => <RoutingListPage spec={routingPolicyList} />,
})
