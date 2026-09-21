import type {
  ASPathList,
  BFDProfile,
  ASPathListRule,
  BGPPeerGroup,
  Community,
  CommunityList,
  CommunityListRule,
  EthernetSegment,
  OSPFArea,
  PrefixList,
  PrefixListRule,
  RoutingKeychain,
  RoutingPolicy,
  RoutingPolicyRule,
} from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { RevealPskButton } from "@/components/reveal-psk-button"
import {
  buildBFDProfileColumns,
  familyLabel,
  buildASPathListColumns,
  buildBGPPeerGroupColumns,
  buildCommunityColumns,
  buildCommunityListColumns,
  buildEthernetSegmentColumns,
  buildOSPFAreaColumns,
  buildPrefixListColumns,
  buildRoutingKeychainColumns,
  buildRoutingPolicyColumns,
  segmentIdentity,
} from "@/components/columns/routing-columns"

import type { RoutingDetailSpec } from "./catalog-detail"
import { EmbeddedBGPSessionTable } from "@/components/embedded-tables"
import { DataTable } from "@/components/data-table"
import { dash } from "@/components/cells/dash"

import { knobRows, remoteAsnText } from "./bgp-bits"
import type { RoutingListSpec } from "./catalog-page"
import {
  asPathListRuleColumns,
  communityListRuleColumns,
  policyRuleColumns,
  prefixListRuleColumns,
  segmentMemberColumns,
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
  subtitle: (r) => `${familyLabel(r.family)} · ${r.rules.length} rules`,
  overview: (r) => [
    { label: "Family", value: familyLabel(r.family) },
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

export const bfdProfileList: RoutingListSpec<BFDProfile> = {
  title: "BFD profiles",
  objectType: "bfdprofile",
  endpoint: "/api/routing/bfd-profiles/",
  queryKey: "bfd-profiles",
  tableId: "bfd-profiles",
  newTo: "/bfd-profiles/new",
  addLabel: "Add profile",
  searchPlaceholder: "Filter profiles…",
  searchText: (r) => `${r.name} ${r.description}`,
  flexColumn: "description",
  label: (r) => r.name,
  columns: ({ onDelete, humanIds, canEdit, canDelete }) =>
    buildBFDProfileColumns({
      humanIds,
      actions: {
        editTo: "/bfd-profiles/$id/edit",
        editParams: (r) => ({ id: r.id }),
        canEdit: () => canEdit,
        onDelete,
        canDelete: () => canDelete,
      },
    }),
}

export const bfdProfileDetail: RoutingDetailSpec<BFDProfile> = {
  objectType: "bfdprofile",
  appLabel: "routing.bfdprofile",
  endpoint: "/api/routing/bfd-profiles/",
  queryKey: "bfd-profile",
  backTo: "/bfd-profiles",
  backLabel: "BFD profiles",
  editTo: "/bfd-profiles/$id/edit",
  title: (r) => r.name,
  subtitle: (r) =>
    `${r.min_tx} / ${r.min_rx} ms × ${r.multiplier}${r.echo ? " · echo" : ""}`,
  overview: (r) => [
    {
      label: "Min TX",
      value: <span className="num">{r.min_tx} ms</span>,
    },
    {
      label: "Min RX",
      value: <span className="num">{r.min_rx} ms</span>,
    },
    { label: "Multiplier", value: <span className="num">{r.multiplier}</span> },
    { label: "Echo mode", value: r.echo ? "On" : "Off" },
  ],
}

export const ethernetSegmentList: RoutingListSpec<EthernetSegment> = {
  title: "Ethernet segments",
  objectType: "ethernetsegment",
  endpoint: "/api/routing/ethernet-segments/",
  queryKey: "ethernet-segments",
  tableId: "ethernet-segments",
  newTo: "/ethernet-segments/new",
  addLabel: "Add segment",
  searchPlaceholder: "Filter segments…",
  searchText: (r) =>
    `${r.name} ${r.esi} ${r.sys_mac} ${r.es_id ?? ""} ${r.description} ${r.interfaces.map((i) => `${i.device.name}:${i.name}`).join(" ")}`,
  flexColumn: "description",
  label: (r) => r.name,
  columns: ({ onDelete, humanIds, canEdit, canDelete }) =>
    buildEthernetSegmentColumns({
      humanIds,
      actions: {
        editTo: "/ethernet-segments/$id/edit",
        editParams: (r) => ({ id: r.id }),
        canEdit: () => canEdit,
        onDelete,
        canDelete: () => canDelete,
      },
    }),
}

export const ethernetSegmentDetail: RoutingDetailSpec<EthernetSegment> = {
  objectType: "ethernetsegment",
  appLabel: "routing.ethernetsegment",
  endpoint: "/api/routing/ethernet-segments/",
  queryKey: "ethernet-segment",
  backTo: "/ethernet-segments",
  backLabel: "Ethernet segments",
  editTo: "/ethernet-segments/$id/edit",
  title: (r) => r.name,
  subtitle: (r) =>
    `${segmentIdentity(r) || "no identity"} · ${r.device_count} devices`,
  overview: (r) => [
    ...(r.esi
      ? [
          {
            label: "ESI",
            value: <span className="font-mono">{r.esi}</span>,
            copy: r.esi,
          },
        ]
      : [
          {
            label: "ES-ID",
            value:
              r.es_id != null ? (
                <span className="num font-mono">{r.es_id}</span>
              ) : (
                dash
              ),
          },
          {
            label: "System MAC",
            value: r.sys_mac ? (
              <span className="font-mono">{r.sys_mac}</span>
            ) : (
              dash
            ),
            ...(r.sys_mac ? { copy: r.sys_mac } : {}),
          },
        ]),
    {
      label: "DF preference",
      value:
        r.df_preference != null ? (
          <span className="num">{r.df_preference}</span>
        ) : (
          dash
        ),
    },
    { label: "Devices", value: <span className="num">{r.device_count}</span> },
  ],
  related: [
    {
      value: "interfaces",
      label: "Interfaces",
      count: (r) => r.interfaces.length,
      render: (r) =>
        r.interfaces.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No member interfaces yet - edit the segment to add some.
          </p>
        ) : (
          <DataTable
            data={r.interfaces}
            columns={segmentMemberColumns()}
            tableId="ethernet-segment-interfaces"
            enableExport={false}
          />
        ),
    },
  ],
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

export const peerGroupList: RoutingListSpec<BGPPeerGroup> = {
  title: "BGP peer groups",
  objectType: "bgppeergroup",
  endpoint: "/api/routing/bgp-peer-groups/",
  queryKey: "bgp-peer-groups",
  tableId: "bgp-peer-groups",
  newTo: "/bgp-peer-groups/new",
  addLabel: "Add peer group",
  searchPlaceholder: "Filter peer groups…",
  searchText: (r) => `${r.name} ${r.description} ${r.remote_asn ?? ""}`,
  flexColumn: "description",
  label: (r) => r.name,
  columns: ({ onDelete, humanIds, canEdit, canDelete }) =>
    buildBGPPeerGroupColumns({
      humanIds,
      actions: {
        editTo: "/bgp-peer-groups/$id/edit",
        editParams: (r) => ({ id: r.id }),
        canEdit: () => canEdit,
        onDelete,
        canDelete: () => canDelete,
      },
    }),
}

export const peerGroupDetail: RoutingDetailSpec<BGPPeerGroup> = {
  objectType: "bgppeergroup",
  appLabel: "routing.bgppeergroup",
  endpoint: "/api/routing/bgp-peer-groups/",
  queryKey: "bgp-peer-group",
  backTo: "/bgp-peer-groups",
  backLabel: "BGP peer groups",
  editTo: "/bgp-peer-groups/$id/edit",
  title: (r) => r.name,
  subtitle: (r) =>
    `remote AS ${remoteAsnText(r) || "-"} · ${r.session_count} sessions`,
  related: [
    {
      value: "sessions",
      label: "Sessions",
      count: (r) => r.session_count,
      render: (r) => (
        <EmbeddedBGPSessionTable
          filter={{ peer_group: r.id }}
          omit={["peer_group"]}
          emptyText="No session joins this group yet."
        />
      ),
    },
  ],
  overview: (r) => [
    {
      label: "Remote AS",
      value: <span className="num font-mono">{remoteAsnText(r) || "-"}</span>,
    },
    {
      label: "Local AS",
      value: r.local_asn ? (
        <span className="num font-mono">{r.local_asn.asn}</span>
      ) : (
        <span className="text-muted-foreground">Instance's</span>
      ),
    },
    {
      label: "Update source",
      value: r.update_source ? (
        <span className="font-mono">{r.update_source}</span>
      ) : (
        <span className="text-muted-foreground">-</span>
      ),
    },
    {
      label: "Sessions",
      value: <span className="num">{r.session_count}</span>,
    },
    ...knobRows(r, "Default"),
  ],
}

export const ospfAreaList: RoutingListSpec<OSPFArea> = {
  title: "OSPF areas",
  objectType: "ospfarea",
  endpoint: "/api/routing/ospf-areas/",
  queryKey: "ospf-areas",
  tableId: "ospf-areas",
  newTo: "/ospf-areas/new",
  addLabel: "Add area",
  searchPlaceholder: "Filter areas…",
  searchText: (r) => `${r.name} ${r.area_id} ${r.description}`,
  flexColumn: "description",
  label: (r) => r.name,
  columns: ({ onDelete, humanIds, canEdit, canDelete }) =>
    buildOSPFAreaColumns({
      humanIds,
      actions: {
        editTo: "/ospf-areas/$id/edit",
        editParams: (r) => ({ id: r.id }),
        canEdit: () => canEdit,
        onDelete,
        canDelete: () => canDelete,
      },
    }),
}

export const ospfAreaDetail: RoutingDetailSpec<OSPFArea> = {
  objectType: "ospfarea",
  appLabel: "routing.ospfarea",
  endpoint: "/api/routing/ospf-areas/",
  queryKey: "ospf-area",
  backTo: "/ospf-areas",
  backLabel: "OSPF areas",
  editTo: "/ospf-areas/$id/edit",
  title: (r) => r.name,
  subtitle: (r) =>
    `area ${r.area_id} · ${r.kind_display} · ${r.interface_count} interfaces`,
  overview: (r) => [
    {
      label: "Area ID",
      value: <span className="num font-mono">{r.area_id}</span>,
      copy: r.area_id,
    },
    { label: "Kind", value: r.kind_display },
    {
      label: "Interfaces",
      value: <span className="num">{r.interface_count}</span>,
    },
  ],
}
