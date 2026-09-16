import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useMemo } from "react"

import type { VTEP } from "@/lib/api"
import { buildVTEPColumns } from "@/components/columns/routing-columns"
import { RoutingListPage } from "@/components/routing/catalog-page"
import type { RoutingListSpec } from "@/components/routing/catalog-page"

// The fleet-wide list. A row is edited on its device's Routing tab, which
// is also where a new one is added - so no Add here, and the pencil leads
// to the device.
function Page() {
  const nav = useNavigate()
  const spec = useMemo<RoutingListSpec<VTEP>>(
    () => ({
      title: "VTEPs",
      objectType: "vtep",
      endpoint: "/api/routing/vteps/",
      queryKey: "vteps",
      tableId: "vteps",
      searchPlaceholder: "Filter VTEPs…",
      searchText: (r) =>
        `${r.device.name} ${r.source_interface?.name ?? ""} ${r.source_ip?.ip_address ?? ""} ${r.description}`,
      flexColumn: "description",
      label: (r) => `the VTEP on ${r.device.name}`,
      columns: ({ onDelete, humanIds, canEdit, canDelete }) =>
        buildVTEPColumns({
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

export const Route = createFileRoute("/vteps/")({ component: Page })
