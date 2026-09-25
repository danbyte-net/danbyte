import { createFileRoute } from "@tanstack/react-router"
import { useMemo } from "react"

import type { ISISInstance } from "@/lib/api"
import { buildISISInstanceColumns } from "@/components/columns/routing-columns"
import { RoutingListPage } from "@/components/routing/catalog-page"
import type { RoutingListSpec } from "@/components/routing/catalog-page"
import { ownerName, ownerOf, useOpenOwner } from "@/components/routing/owner"

// The fleet-wide list. A row is edited on its device's or VM's Routing
// tab, which is also where a new one is added - so no Add here, and the
// pencil leads to that box.
function Page() {
  const openOwner = useOpenOwner()
  const spec = useMemo<RoutingListSpec<ISISInstance>>(
    () => ({
      title: "IS-IS instances",
      objectType: "isisinstance",
      endpoint: "/api/routing/isis-instances/",
      queryKey: "isis-instances",
      tableId: "isis-instances",
      searchPlaceholder: "Filter instances…",
      searchText: (r) =>
        `${ownerName(r)} ${r.process} ${r.net} ${r.vrf?.name ?? ""} ${r.description}`,
      flexColumn: "description",
      label: (r) => `IS-IS ${r.process} on ${ownerName(r)}`,
      columns: ({ onDelete, humanIds, canEdit, canDelete }) =>
        buildISISInstanceColumns({
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

export const Route = createFileRoute("/isis-instances/")({ component: Page })
