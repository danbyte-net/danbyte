import { createFileRoute } from "@tanstack/react-router"
import { useMemo } from "react"

import type { OSPFInstance } from "@/lib/api"
import { buildOSPFInstanceColumns } from "@/components/columns/routing-columns"
import { RoutingListPage } from "@/components/routing/catalog-page"
import type { RoutingListSpec } from "@/components/routing/catalog-page"
import { ownerName, ownerOf, useOpenOwner } from "@/components/routing/owner"

// The fleet-wide list. A row is edited on its device's or VM's Routing
// tab, which is also where a new one is added - so no Add here, and the
// pencil leads to that box.
function Page() {
  const openOwner = useOpenOwner()
  const spec = useMemo<RoutingListSpec<OSPFInstance>>(
    () => ({
      title: "OSPF instances",
      objectType: "ospfinstance",
      endpoint: "/api/routing/ospf-instances/",
      queryKey: "ospf-instances",
      tableId: "ospf-instances",
      searchPlaceholder: "Filter instances…",
      searchText: (r) =>
        `${ownerName(r)} ${r.process_id} ${r.vrf?.name ?? ""} ${r.router_id} ${r.description}`,
      flexColumn: "description",
      label: (r) => `OSPF ${r.process_id} on ${ownerName(r)}`,
      columns: ({ onDelete, humanIds, canEdit, canDelete }) =>
        buildOSPFInstanceColumns({
          humanIds,
          actions: {
            onEdit: (r) => openOwner(ownerOf(r)),
            canEdit: () => canEdit,
            onDelete,
            canDelete: () => canDelete,
          },
        }),
    }),
    [openOwner]
  )
  return <RoutingListPage spec={spec} />
}

export const Route = createFileRoute("/ospf-instances/")({ component: Page })
