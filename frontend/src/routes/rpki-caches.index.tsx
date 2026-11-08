import { createFileRoute } from "@tanstack/react-router"

import { RoutingListPage } from "@/components/routing/catalog-page"
import { rpkiCacheList } from "@/components/routing/specs"

export const Route = createFileRoute("/rpki-caches/")({
  component: () => <RoutingListPage spec={rpkiCacheList} />,
})
