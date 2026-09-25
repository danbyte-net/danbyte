import { createFileRoute } from "@tanstack/react-router"

import type { BGPSession } from "@/lib/api"
import {
  buildBGPSessionColumns,
  sessionNeighbor,
} from "@/components/columns/routing-columns"
import { RoutingListPage } from "@/components/routing/catalog-page"
import type { RoutingListSpec } from "@/components/routing/catalog-page"
import { ownerName } from "@/components/routing/owner"

const spec: RoutingListSpec<BGPSession> = {
  title: "BGP sessions",
  objectType: "bgpsession",
  endpoint: "/api/routing/bgp-sessions/",
  queryKey: "bgp-sessions",
  tableId: "bgp-sessions",
  newTo: "/bgp-sessions/new",
  addLabel: "Add session",
  searchPlaceholder: "Filter sessions…",
  searchText: (r) =>
    `${sessionNeighbor(r)} ${r.name} ${ownerName(r.instance)} ${r.peer_device?.name ?? ""} ${r.peer_group?.name ?? ""} ${r.effective.remote_asn ?? ""} ${r.description}`,
  // No elastic column: with this many columns it would swallow the
  // description; the table scrolls sideways instead.
  flexColumn: "",
  label: (r) => `${sessionNeighbor(r)} on ${ownerName(r.instance)}`,
  columns: ({ onDelete, humanIds, canEdit, canDelete }) =>
    buildBGPSessionColumns({
      humanIds,
      actions: {
        editTo: "/bgp-sessions/$id/edit",
        editParams: (r) => ({ id: r.id }),
        canEdit: () => canEdit,
        onDelete,
        canDelete: () => canDelete,
      },
    }),
}

export const Route = createFileRoute("/bgp-sessions/")({
  component: () => <RoutingListPage spec={spec} />,
})
