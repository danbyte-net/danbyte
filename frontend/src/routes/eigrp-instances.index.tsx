import { createFileRoute } from "@tanstack/react-router"
import { useMemo } from "react"

import type { EIGRPInstance } from "@/lib/api"
import { buildEIGRPInstanceColumns } from "@/components/columns/routing-columns"
import { RoutingListPage } from "@/components/routing/catalog-page"
import type { RoutingListSpec } from "@/components/routing/catalog-page"
import { ownerName, ownerOf, useOpenOwner } from "@/components/routing/owner"

// The fleet-wide list. A row is edited on its device's or VM's Routing
// tab, which is also where a new one is added - so no Add here, and the
// pencil leads to that box.
function Page() {
  const openOwner = useOpenOwner()
  const spec = useMemo<RoutingListSpec<EIGRPInstance>>(
    () => ({
      title: "EIGRP instances",
      objectType: "eigrpinstance",
      endpoint: "/api/routing/eigrp-instances/",
      queryKey: "eigrp-instances",
      tableId: "eigrp-instances",
      searchPlaceholder: "Filter instances…",
      searchText: (r) =>
        `${ownerName(r)} ${r.asn} ${r.name} ${r.vrf?.name ?? ""} ${r.router_id} ${r.description}`,
      flexColumn: "description",
      label: (r) => `EIGRP ${r.asn} on ${ownerName(r)}`,
      columns: ({ onDelete, humanIds, canEdit, canDelete }) =>
        buildEIGRPInstanceColumns({
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

export const Route = createFileRoute("/eigrp-instances/")({ component: Page })
