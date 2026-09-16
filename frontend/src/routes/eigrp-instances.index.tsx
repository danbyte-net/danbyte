import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useMemo } from "react"

import type { EIGRPInstance } from "@/lib/api"
import { buildEIGRPInstanceColumns } from "@/components/columns/routing-columns"
import { RoutingListPage } from "@/components/routing/catalog-page"
import type { RoutingListSpec } from "@/components/routing/catalog-page"

// The fleet-wide list. A row is edited on its device's Routing tab, which
// is also where a new one is added - so no Add here, and the pencil leads
// to the device.
function Page() {
  const nav = useNavigate()
  const spec = useMemo<RoutingListSpec<EIGRPInstance>>(
    () => ({
      title: "EIGRP instances",
      objectType: "eigrpinstance",
      endpoint: "/api/routing/eigrp-instances/",
      queryKey: "eigrp-instances",
      tableId: "eigrp-instances",
      searchPlaceholder: "Filter instances…",
      searchText: (r) =>
        `${r.device.name} ${r.asn} ${r.name} ${r.vrf?.name ?? ""} ${r.router_id} ${r.description}`,
      flexColumn: "description",
      label: (r) => `EIGRP ${r.asn} on ${r.device.name}`,
      columns: ({ onDelete, humanIds, canEdit, canDelete }) =>
        buildEIGRPInstanceColumns({
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

export const Route = createFileRoute("/eigrp-instances/")({ component: Page })
