import { createFileRoute } from "@tanstack/react-router"

import { RoutingListPage } from "@/components/routing/catalog-page"
import { prefixListList } from "@/components/routing/specs"

export const Route = createFileRoute("/prefix-lists/")({
  component: () => <RoutingListPage spec={prefixListList} />,
})
