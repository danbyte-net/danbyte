import { createFileRoute } from "@tanstack/react-router"

import type { PolicyRule } from "@/lib/api"
import {
  buildPolicyRuleColumns,
  policyRuleSelector,
} from "@/components/columns/routing-columns"
import { RoutingListPage } from "@/components/routing/catalog-page"
import type { RoutingListSpec } from "@/components/routing/catalog-page"
import { ownerName } from "@/components/routing/owner"

const spec: RoutingListSpec<PolicyRule> = {
  title: "Policy rules",
  noun: ["policy rule", "policy rules"],
  objectType: "policyrule",
  endpoint: "/api/routing/ip-rules/",
  queryKey: "policy-rules",
  tableId: "policy-rules",
  newTo: "/policy-rules/new",
  addLabel: "Add policy rule",
  searchPlaceholder: "Filter rules…",
  searchText: (r) =>
    `${r.priority} ${policyRuleSelector(r)} ${ownerName(r)} ${r.table ?? ""} ${r.vrf?.name ?? ""} ${r.description}`,
  flexColumn: "description",
  label: (r) => `Rule ${r.priority} on ${ownerName(r)}`,
  columns: ({ onDelete, humanIds, canEdit, canDelete }) =>
    buildPolicyRuleColumns({
      humanIds,
      actions: {
        editTo: "/policy-rules/$id/edit",
        editParams: (r) => ({ id: r.id }),
        canEdit: () => canEdit,
        onDelete,
        canDelete: () => canDelete,
      },
    }),
}

export const Route = createFileRoute("/policy-rules/")({
  component: () => <RoutingListPage spec={spec} />,
})
