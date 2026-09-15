import { createFileRoute } from "@tanstack/react-router"

import type { StaticRoute } from "@/lib/api"
import { buildStaticRouteColumns } from "@/components/columns/routing-columns"
import { RoutingListPage } from "@/components/routing/catalog-page"
import type { RoutingListSpec } from "@/components/routing/catalog-page"

const spec: RoutingListSpec<StaticRoute> = {
  title: "Static routes",
  objectType: "staticroute",
  endpoint: "/api/routing/static-routes/",
  queryKey: "static-routes",
  tableId: "static-routes",
  newTo: "/static-routes/new",
  addLabel: "Add static route",
  searchPlaceholder: "Filter routes…",
  searchText: (r) =>
    `${r.prefix} ${r.next_hop} ${r.device.name} ${r.vrf?.name ?? ""} ${r.description}`,
  flexColumn: "description",
  label: (r) => `${r.prefix} on ${r.device.name}`,
  columns: ({ onDelete, humanIds, canEdit, canDelete }) =>
    buildStaticRouteColumns({
      humanIds,
      actions: {
        editTo: "/static-routes/$id/edit",
        editParams: (r) => ({ id: r.id }),
        canEdit: () => canEdit,
        onDelete,
        canDelete: () => canDelete,
      },
    }),
}

export const Route = createFileRoute("/static-routes/")({
  component: () => <RoutingListPage spec={spec} />,
})
