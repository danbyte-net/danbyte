import { createFileRoute } from "@tanstack/react-router"
import { useMemo } from "react"

import type { BGPInstance } from "@/lib/api"
import { buildBGPInstanceColumns } from "@/components/columns/routing-columns"
import { RoutingListPage } from "@/components/routing/catalog-page"
import type { RoutingListSpec } from "@/components/routing/catalog-page"
import { ownerName, ownerOf, useOpenOwner } from "@/components/routing/owner"

// The fleet-wide list. A row is edited on its device's or VM's Routing
// tab, which is also where a new one is added - so no Add here, and the
// pencil leads to that box.
function Page() {
  const openOwner = useOpenOwner()
  const spec = useMemo<RoutingListSpec<BGPInstance>>(
    () => ({
      title: "BGP instances",
      objectType: "bgpinstance",
      endpoint: "/api/routing/bgp-instances/",
      queryKey: "bgp-instances",
      tableId: "bgp-instances",
      searchPlaceholder: "Filter instances…",
      searchText: (r) =>
        `${ownerName(r)} AS${r.asn.asn} ${r.vrf?.name ?? ""} ${r.router_id} ${r.description}`,
      flexColumn: "description",
      label: (r) => `AS${r.asn.asn} on ${ownerName(r)}`,
      columns: ({ onDelete, humanIds, canEdit, canDelete }) =>
        buildBGPInstanceColumns({
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

export const Route = createFileRoute("/bgp-instances/")({ component: Page })
