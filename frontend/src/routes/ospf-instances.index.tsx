import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useMemo } from "react"

import type { OSPFInstance } from "@/lib/api"
import { buildOSPFInstanceColumns } from "@/components/columns/routing-columns"
import { RoutingListPage } from "@/components/routing/catalog-page"
import type { RoutingListSpec } from "@/components/routing/catalog-page"

// The fleet-wide list. A row is edited on its device's Routing tab, which
// is also where a new one is added - so no Add here, and the pencil leads
// to the device.
function Page() {
  const nav = useNavigate()
  const spec = useMemo<RoutingListSpec<OSPFInstance>>(
    () => ({
      title: "OSPF instances",
      objectType: "ospfinstance",
      endpoint: "/api/routing/ospf-instances/",
      queryKey: "ospf-instances",
      tableId: "ospf-instances",
      searchPlaceholder: "Filter instances…",
      searchText: (r) =>
        `${r.device.name} ${r.process_id} ${r.vrf?.name ?? ""} ${r.router_id} ${r.description}`,
      flexColumn: "description",
      label: (r) => `OSPF ${r.process_id} on ${r.device.name}`,
      columns: ({ onDelete, humanIds, canEdit, canDelete }) =>
        buildOSPFInstanceColumns({
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

export const Route = createFileRoute("/ospf-instances/")({ component: Page })
