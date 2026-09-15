import { createFileRoute } from "@tanstack/react-router"

import { RoutingListPage } from "@/components/routing/catalog-page"
import { asPathListList } from "@/components/routing/specs"

export const Route = createFileRoute("/as-path-lists/")({
  component: () => <RoutingListPage spec={asPathListList} />,
})
