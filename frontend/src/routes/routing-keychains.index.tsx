import { createFileRoute } from "@tanstack/react-router"

import { RoutingListPage } from "@/components/routing/catalog-page"
import { keychainList } from "@/components/routing/specs"

export const Route = createFileRoute("/routing-keychains/")({
  component: () => <RoutingListPage spec={keychainList} />,
})
