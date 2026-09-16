import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useMemo } from "react"

import type { ISISInstance } from "@/lib/api"
import { buildISISInstanceColumns } from "@/components/columns/routing-columns"
import { RoutingListPage } from "@/components/routing/catalog-page"
import type { RoutingListSpec } from "@/components/routing/catalog-page"

// The fleet-wide list. A row is edited on its device's Routing tab, which
// is also where a new one is added - so no Add here, and the pencil leads
// to the device.
function Page() {
  const nav = useNavigate()
  const spec = useMemo<RoutingListSpec<ISISInstance>>(
    () => ({
      title: "IS-IS instances",
      objectType: "isisinstance",
      endpoint: "/api/routing/isis-instances/",
      queryKey: "isis-instances",
      tableId: "isis-instances",
      searchPlaceholder: "Filter instances…",
      searchText: (r) =>
        `${r.device.name} ${r.process} ${r.net} ${r.vrf?.name ?? ""} ${r.description}`,
      flexColumn: "description",
      label: (r) => `IS-IS ${r.process} on ${r.device.name}`,
      columns: ({ onDelete, humanIds, canEdit, canDelete }) =>
        buildISISInstanceColumns({
          humanIds,
          actions: {
            onEdit: (r) =>
              nav({
                to: "/devices/$id",
                params: { id: r.device.id },
                search: { tab: "routing" },
              }),
            canEdit: () => canEdit,
            onDelete,
            canDelete: () => canDelete,
          },
        }),
    }),
    [nav]
  )
  return <RoutingListPage spec={spec} />
}

export const Route = createFileRoute("/isis-instances/")({ component: Page })
