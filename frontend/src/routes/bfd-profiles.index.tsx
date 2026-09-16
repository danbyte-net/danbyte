import { createFileRoute } from "@tanstack/react-router"

import { RoutingListPage } from "@/components/routing/catalog-page"
import { bfdProfileList } from "@/components/routing/specs"

export const Route = createFileRoute("/bfd-profiles/")({
  component: () => <RoutingListPage spec={bfdProfileList} />,
})
