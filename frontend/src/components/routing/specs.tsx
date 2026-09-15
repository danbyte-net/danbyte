import type {
  ASPathList,
  ASPathListRule,
  Community,
  CommunityList,
  CommunityListRule,
  PrefixList,
  PrefixListRule,
  RoutingKeychain,
  RoutingPolicy,
  RoutingPolicyRule,
} from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { RevealPskButton } from "@/components/reveal-psk-button"
import {
  buildASPathListColumns,
  buildCommunityColumns,
  buildCommunityListColumns,
  buildPrefixListColumns,
  buildRoutingKeychainColumns,
  buildRoutingPolicyColumns,
} from "@/components/columns/routing-columns"

import type { RoutingDetailSpec } from "./catalog-detail"
import type { RoutingListSpec } from "./catalog-page"
import {
  asPathListRuleColumns,
  communityListRuleColumns,
  policyRuleColumns,
  prefixListRuleColumns,
} from "./rule-columns"

// The list and detail specs of the six routing catalogs - one place, so a
// route file is a few lines and the two pages of a type cannot drift.

const KIND_LABEL: Record<string, string> = {
  standard: "Standard",
  expanded: "Expanded (regex)",
  large: "Large",
  extended: "Extended",
}

export const prefixListList: RoutingListSpec<PrefixList> = {
  title: "Prefix lists",
  objectType: "prefixlist",
  endpoint: "/api/routing/prefix-lists/",
  queryKey: "prefix-lists",
  tableId: "prefix-lists",
  newTo: "/prefix-lists/new",
  addLabel: "Add prefix list",
  searchPlaceholder: "Filter prefix lists…",
  searchText: (r) => `${r.name} ${r.description}`,
  flexColumn: "description",
  label: (r) => r.name,
  columns: ({ onDelete, humanIds, canEdit, canDelete }) =>
    buildPrefixListColumns({
      humanIds,
      actions: {
        editTo: "/prefix-lists/$id/edit",
        editParams: (r) => ({ id: r.id }),
        canEdit: () => canEdit,
        onDelete,
        canDelete: () => canDelete,
      },
    }),
}

export const prefixListDetail: RoutingDetailSpec<PrefixList, PrefixListRule> = {
  objectType: "prefixlist",
  appLabel: "routing.prefixlist",
  endpoint: "/api/routing/prefix-lists/",
  queryKey: "prefix-list",
  backTo: "/prefix-lists",
  backLabel: "Prefix lists",
  editTo: "/prefix-lists/$id/edit",
  title: (r) => r.name,
  subtitle: (r) => `${r.family.toUpperCase()} · ${r.rules.length} rules`,
  overview: (r) => [
    { label: "Family", value: r.family.toUpperCase() },
    { label: "Rules", value: <span className="num">{r.rules.length}</span> },
  ],
  rules: {
    label: "Rules",
    columns: prefixListRuleColumns,
    get: (r) => r.rules,
    tableId: "prefix-list-rules",
    emptyText: "No rules yet - edit the list to add some.",
  },
}

export const communityList: RoutingListSpec<Community> = {
  title: "Communities",
  objectType: "community",
  endpoint: "/api/routing/communities/",
  queryKey: "communities",
  tableId: "communities",
  newTo: "/communities/new",
  addLabel: "Add community",
  searchPlaceholder: "Filter communities…",
  searchText: (r) => `${r.value} ${r.name} ${r.description}`,
  flexColumn: "description",
  label: (r) => r.value,
  columns: ({ onDelete, humanIds, canEdit, canDelete }) =>
    buildCommunityColumns({
      humanIds,
      actions: {
        editTo: "/communities/$id/edit",
        editParams: (r) => ({ id: r.id }),
        canEdit: () => canEdit,
        onDelete,
        canDelete: () => canDelete,
      },
    }),
}

export const communityDetail: RoutingDetailSpec<Community> = {
  objectType: "community",
  appLabel: "routing.community",
  endpoint: "/api/routing/communities/",
  queryKey: "community",
  backTo: "/communities",
  backLabel: "Communities",
  editTo: "/communities/$id/edit",
  title: (r) => r.value,
  subtitle: (r) => `${r.name} · ${KIND_LABEL[r.kind] ?? r.kind}`,
  overview: (r) => [
    {
      label: "Value",
      value: <span className="font-mono">{r.value}</span>,
      copy: r.value,
    },
    { label: "Kind", value: KIND_LABEL[r.kind] ?? r.kind },
  ],
}

export const communityListList: RoutingListSpec<CommunityList> = {
  title: "Community lists",
  objectType: "communitylist",
  endpoint: "/api/routing/community-lists/",
  queryKey: "community-lists",
  tableId: "community-lists",
  newTo: "/community-lists/new",
  addLabel: "Add community list",
  searchPlaceholder: "Filter community lists…",
  searchText: (r) => `${r.name} ${r.description}`,
  flexColumn: "description",
  label: (r) => r.name,
  columns: ({ onDelete, humanIds, canEdit, canDelete }) =>
    buildCommunityListColumns({
      humanIds,
      actions: {
        editTo: "/community-lists/$id/edit",
        editParams: (r) => ({ id: r.id }),
        canEdit: () => canEdit,
        onDelete,
        canDelete: () => canDelete,
      },
    }),
}

export const communityListDetail: RoutingDetailSpec<
  CommunityList,
  CommunityListRule
> = {
  objectType: "communitylist",
  appLabel: "routing.communitylist",
  endpoint: "/api/routing/community-lists/",
  queryKey: "community-list",
  backTo: "/community-lists",
  backLabel: "Community lists",
  editTo: "/community-lists/$id/edit",
  title: (r) => r.name,
  subtitle: (r) => `${KIND_LABEL[r.kind] ?? r.kind} · ${r.rules.length} rules`,
  overview: (r) => [
    { label: "Kind", value: KIND_LABEL[r.kind] ?? r.kind },
    { label: "Rules", value: <span className="num">{r.rules.length}</span> },
  ],
  rules: {
    label: "Rules",
    columns: communityListRuleColumns,
    get: (r) => r.rules,
    tableId: "community-list-rules",
    emptyText: "No rules yet - edit the list to add some.",
  },
}

export const asPathListList: RoutingListSpec<ASPathList> = {
  title: "AS-path lists",
  objectType: "aspathlist",
  endpoint: "/api/routing/as-path-lists/",
  queryKey: "as-path-lists",
  tableId: "as-path-lists",
  newTo: "/as-path-lists/new",
  addLabel: "Add AS-path list",
  searchPlaceholder: "Filter AS-path lists…",
  searchText: (r) => `${r.name} ${r.description}`,
  flexColumn: "description",
  label: (r) => r.name,
  columns: ({ onDelete, humanIds, canEdit, canDelete }) =>
    buildASPathListColumns({
      humanIds,
      actions: {
        editTo: "/as-path-lists/$id/edit",
        editParams: (r) => ({ id: r.id }),
        canEdit: () => canEdit,
        onDelete,
        canDelete: () => canDelete,
      },
    }),
}

export const asPathListDetail: RoutingDetailSpec<ASPathList, ASPathListRule> = {
  objectType: "aspathlist",
  appLabel: "routing.aspathlist",
  endpoint: "/api/routing/as-path-lists/",
  queryKey: "as-path-list",
  backTo: "/as-path-lists",
  backLabel: "AS-path lists",
  editTo: "/as-path-lists/$id/edit",
  title: (r) => r.name,
  subtitle: (r) => `${r.rules.length} rules`,
  overview: (r) => [
    { label: "Rules", value: <span className="num">{r.rules.length}</span> },
  ],
  rules: {
    label: "Rules",
    columns: asPathListRuleColumns,
    get: (r) => r.rules,
    tableId: "as-path-list-rules",
    emptyText: "No rules yet - edit the list to add some.",
  },
}

export const routingPolicyList: RoutingListSpec<RoutingPolicy> = {
  title: "Routing policies",
  objectType: "routingpolicy",
  endpoint: "/api/routing/policies/",
  queryKey: "routing-policies",
  tableId: "routing-policies",
  newTo: "/routing-policies/new",
  addLabel: "Add policy",
  searchPlaceholder: "Filter policies…",
  searchText: (r) => `${r.name} ${r.description}`,
  flexColumn: "description",
  label: (r) => r.name,
  columns: ({ onDelete, humanIds, canEdit, canDelete }) =>
    buildRoutingPolicyColumns({
      humanIds,
      actions: {
        editTo: "/routing-policies/$id/edit",
        editParams: (r) => ({ id: r.id }),
        canEdit: () => canEdit,
        onDelete,
        canDelete: () => canDelete,
      },
    }),
}

export const routingPolicyDetail: RoutingDetailSpec<
  RoutingPolicy,
  RoutingPolicyRule
> = {
  objectType: "routingpolicy",
  appLabel: "routing.routingpolicy",
  endpoint: "/api/routing/policies/",
  queryKey: "routing-policy",
  backTo: "/routing-policies",
  backLabel: "Routing policies",
  editTo: "/routing-policies/$id/edit",
  title: (r) => r.name,
  subtitle: (r) => `${r.rules.length} rules`,
  overview: (r) => [
    { label: "Rules", value: <span className="num">{r.rules.length}</span> },
  ],
  rules: {
    label: "Rules",
    columns: policyRuleColumns,
    get: (r) => r.rules,
    tableId: "routing-policy-rules",
    emptyText: "No rules yet - edit the policy to add some.",
  },
}

export const keychainList: RoutingListSpec<RoutingKeychain> = {
  title: "Routing keychains",
  objectType: "routingkeychain",
  endpoint: "/api/routing/keychains/",
  queryKey: "routing-keychains",
  tableId: "routing-keychains",
  newTo: "/routing-keychains/new",
  addLabel: "Add keychain",
  searchPlaceholder: "Filter keychains…",
  searchText: (r) => `${r.name} ${r.description}`,
  flexColumn: "description",
  label: (r) => r.name,
  columns: ({ onDelete, humanIds, canEdit, canDelete }) =>
    buildRoutingKeychainColumns({
      humanIds,
      actions: {
        editTo: "/routing-keychains/$id/edit",
        editParams: (r) => ({ id: r.id }),
        canEdit: () => canEdit,
        onDelete,
        canDelete: () => canDelete,
      },
    }),
}

/** "Stored" plus a reveal button, or "Not set". The key never rides the
 * page payload - revealing is a separate, audited request gated by the
 * `reveal` grant on keychains. */
function KeyRow({ keychain: k }: { keychain: RoutingKeychain }) {
  const { canDo } = useMe()
  if (!k.psk_set) return <span className="text-muted-foreground">Not set</span>
  return (
    <span className="flex items-center gap-1.5">
      <span className="font-mono text-[13px]">••••••••</span>
      {canDo("routingkeychain", "reveal") && (
        <RevealPskButton id={k.id} endpoint="/api/routing/keychains" />
      )}
    </span>
  )
}

export const keychainDetail: RoutingDetailSpec<RoutingKeychain> = {
  objectType: "routingkeychain",
  appLabel: "routing.routingkeychain",
  endpoint: "/api/routing/keychains/",
  queryKey: "routing-keychain",
  backTo: "/routing-keychains",
  backLabel: "Routing keychains",
  editTo: "/routing-keychains/$id/edit",
  title: (r) => r.name,
  subtitle: (r) => r.algorithm.toUpperCase(),
  overview: (r) => [
    {
      label: "Algorithm",
      value: <span className="font-mono">{r.algorithm.toUpperCase()}</span>,
    },
    { label: "Key", value: <KeyRow keychain={r} /> },
  ],
}
