import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type {
  ASPathList,
  BFDProfile,
  BGPInstance,
  BGPPeerGroup,
  BGPSession,
  Community,
  CommunityList,
  EIGRPInstance,
  ISISInstance,
  OSPFArea,
  OSPFInstance,
  PrefixList,
  RoutingKeychain,
  RoutingPolicy,
  StaticRoute,
  StatusMini,
  VTEP,
} from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { StatusBadge } from "@/components/status-badge"
import { ColorBadge } from "@/components/cells/color-badge"
import { PlannedChangeMarker } from "@/components/planning/planned-change-badge"
import { dash } from "@/components/cells/dash"
import { numidColumn } from "@/components/cells/numid"
import { tagsColumn } from "@/components/cells/tag-list"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// One factory per routing object, all built the same way: the list page,
// the embedded panes (a device's Routing tab, a prefix's Static routes tab)
// and the pickers' tables draw the same row.

/** "ipv4" the way it is written: IPv4. */
export function familyLabel(v: string): string {
  return v === "ipv4" ? "IPv4" : v === "ipv6" ? "IPv6" : v
}

interface CommonOpts<T, TId extends string> {
  omit?: TId[]
  include?: TId[]
  selection?: boolean
  humanIds?: boolean
  tagFilter?: { activeSlugs: Set<string>; onToggle: (slug: string) => void }
  actions?: ActionsColumnOpts<T>
}

function assemble<T, TId extends string>(
  order: TId[],
  byId: Record<TId, () => ColumnDef<T, unknown>>,
  opts: CommonOpts<T, TId>
): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  if (!opts.humanIds) omit.add("numid" as TId)
  const keep = (id: TId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))
  const cols: ColumnDef<T, unknown>[] = []
  if (opts.selection) cols.push(selectionColumn<T>())
  for (const id of order) if (keep(id)) cols.push(byId[id]())
  if (opts.actions) cols.push(actionsColumn<T>(opts.actions))
  return cols
}

function nameColumn<T extends { id: string; name: string }>(
  to: string,
  objectType: string
): ColumnDef<T, unknown> {
  return {
    id: "name",
    accessorKey: "name",
    header: ({ column }) => <SortHeader column={column} label="Name" />,
    cell: ({ row }) => (
      <span className="inline-flex items-center gap-1.5">
        <Link
          to={to}
          params={{ id: row.original.id }}
          className="link font-mono font-medium"
        >
          {row.original.name}
        </Link>
        <PlannedChangeMarker
          objectType={objectType}
          objectId={row.original.id}
        />
      </span>
    ),
  }
}

function descriptionColumn<T extends { description: string }>(): ColumnDef<
  T,
  unknown
> {
  return {
    id: "description",
    accessorKey: "description",
    header: "Description",
    cell: ({ row }) => (
      <span className="line-clamp-1 block text-muted-foreground">
        {row.original.description || "-"}
      </span>
    ),
  }
}

function ruleCountColumn<T extends { rule_count: number }>(): ColumnDef<
  T,
  unknown
> {
  return {
    id: "rule_count",
    accessorKey: "rule_count",
    header: ({ column }) => <SortHeader column={column} label="Rules" />,
    cell: ({ row }) => (
      <span className="num text-xs">{row.original.rule_count}</span>
    ),
  }
}

function tags<
  T extends {
    tags: {
      slug: string
      name: string
      color: string
      text_color: string
      id: number
    }[]
  },
>(opts: CommonOpts<T, string>) {
  return () =>
    tagsColumn<T>({
      getTags: (r) => r.tags,
      activeSlugs: opts.tagFilter?.activeSlugs,
      onToggle: opts.tagFilter?.onToggle,
    })
}

// ─── Prefix lists ────────────────────────────────────────────────────────────

export type PrefixListColumnId =
  | "numid"
  | "name"
  | "family"
  | "rule_count"
  | "description"
  | "tags"
const PREFIX_LIST_ORDER: PrefixListColumnId[] = [
  "numid",
  "name",
  "family",
  "rule_count",
  "description",
  "tags",
]

export function buildPrefixListColumns<T extends PrefixList = PrefixList>(
  opts: CommonOpts<T, PrefixListColumnId> = {}
): ColumnDef<T, unknown>[] {
  return assemble<T, PrefixListColumnId>(
    PREFIX_LIST_ORDER,
    {
      numid: () => numidColumn<T>({ get: (r) => r.numid }),
      name: () => nameColumn<T>("/prefix-lists/$id", "routing.prefixlist"),
      family: () => ({
        id: "family",
        accessorKey: "family",
        header: "Family",
        cell: ({ row }) => (
          <span className="text-xs">{familyLabel(row.original.family)}</span>
        ),
        meta: {
          facet: {
            kind: "enum",
            label: "Family",
            get: (r: T) => r.family,
            formatValue: (v) => ({ label: familyLabel(String(v)) }),
          },
        },
      }),
      rule_count: () => ruleCountColumn<T>(),
      description: () => descriptionColumn<T>(),
      tags: tags<T>(opts),
    },
    opts
  )
}

// ─── Communities ─────────────────────────────────────────────────────────────

export type CommunityColumnId =
  | "numid"
  | "value"
  | "name"
  | "kind"
  | "description"
  | "tags"
const COMMUNITY_ORDER: CommunityColumnId[] = [
  "numid",
  "value",
  "name",
  "kind",
  "description",
  "tags",
]

export function buildCommunityColumns<T extends Community = Community>(
  opts: CommonOpts<T, CommunityColumnId> = {}
): ColumnDef<T, unknown>[] {
  return assemble<T, CommunityColumnId>(
    COMMUNITY_ORDER,
    {
      numid: () => numidColumn<T>({ get: (r) => r.numid }),
      value: () => ({
        id: "value",
        accessorKey: "value",
        header: ({ column }) => (
          <SortHeader column={column} label="Community" />
        ),
        cell: ({ row }) => (
          <span className="inline-flex items-center gap-1.5">
            <Link
              to="/communities/$id"
              params={{ id: row.original.id }}
              className="link font-mono font-medium"
            >
              {row.original.value}
            </Link>
            <PlannedChangeMarker
              objectType="routing.community"
              objectId={row.original.id}
            />
          </span>
        ),
      }),
      name: () => ({
        id: "name",
        accessorKey: "name",
        header: ({ column }) => <SortHeader column={column} label="Name" />,
        cell: ({ row }) => <span>{row.original.name}</span>,
      }),
      kind: () => ({
        id: "kind",
        accessorKey: "kind",
        header: "Kind",
        cell: ({ row }) => (
          <span className="text-xs capitalize">{row.original.kind}</span>
        ),
        meta: {
          facet: {
            kind: "enum",
            label: "Kind",
            get: (r: T) => r.kind,
            formatValue: (v) => ({ label: String(v) }),
          },
        },
      }),
      description: () => descriptionColumn<T>(),
      tags: tags<T>(opts),
    },
    opts
  )
}

// ─── Community lists ─────────────────────────────────────────────────────────

export type CommunityListColumnId =
  | "numid"
  | "name"
  | "kind"
  | "rule_count"
  | "description"
  | "tags"
const COMMUNITY_LIST_ORDER: CommunityListColumnId[] = [
  "numid",
  "name",
  "kind",
  "rule_count",
  "description",
  "tags",
]

export function buildCommunityListColumns<
  T extends CommunityList = CommunityList,
>(opts: CommonOpts<T, CommunityListColumnId> = {}): ColumnDef<T, unknown>[] {
  return assemble<T, CommunityListColumnId>(
    COMMUNITY_LIST_ORDER,
    {
      numid: () => numidColumn<T>({ get: (r) => r.numid }),
      name: () =>
        nameColumn<T>("/community-lists/$id", "routing.communitylist"),
      kind: () => ({
        id: "kind",
        accessorKey: "kind",
        header: "Kind",
        cell: ({ row }) => (
          <span className="text-xs capitalize">{row.original.kind}</span>
        ),
        meta: {
          facet: {
            kind: "enum",
            label: "Kind",
            get: (r: T) => r.kind,
            formatValue: (v) => ({ label: String(v) }),
          },
        },
      }),
      rule_count: () => ruleCountColumn<T>(),
      description: () => descriptionColumn<T>(),
      tags: tags<T>(opts),
    },
    opts
  )
}

// ─── AS-path lists ───────────────────────────────────────────────────────────

export type ASPathListColumnId =
  | "numid"
  | "name"
  | "rule_count"
  | "description"
  | "tags"
const AS_PATH_LIST_ORDER: ASPathListColumnId[] = [
  "numid",
  "name",
  "rule_count",
  "description",
  "tags",
]

export function buildASPathListColumns<T extends ASPathList = ASPathList>(
  opts: CommonOpts<T, ASPathListColumnId> = {}
): ColumnDef<T, unknown>[] {
  return assemble<T, ASPathListColumnId>(
    AS_PATH_LIST_ORDER,
    {
      numid: () => numidColumn<T>({ get: (r) => r.numid }),
      name: () => nameColumn<T>("/as-path-lists/$id", "routing.aspathlist"),
      rule_count: () => ruleCountColumn<T>(),
      description: () => descriptionColumn<T>(),
      tags: tags<T>(opts),
    },
    opts
  )
}

// ─── Routing policies ────────────────────────────────────────────────────────

export type RoutingPolicyColumnId =
  | "numid"
  | "name"
  | "rule_count"
  | "description"
  | "tags"
const ROUTING_POLICY_ORDER: RoutingPolicyColumnId[] = [
  "numid",
  "name",
  "rule_count",
  "description",
  "tags",
]

export function buildRoutingPolicyColumns<
  T extends RoutingPolicy = RoutingPolicy,
>(opts: CommonOpts<T, RoutingPolicyColumnId> = {}): ColumnDef<T, unknown>[] {
  return assemble<T, RoutingPolicyColumnId>(
    ROUTING_POLICY_ORDER,
    {
      numid: () => numidColumn<T>({ get: (r) => r.numid }),
      name: () =>
        nameColumn<T>("/routing-policies/$id", "routing.routingpolicy"),
      rule_count: () => ruleCountColumn<T>(),
      description: () => descriptionColumn<T>(),
      tags: tags<T>(opts),
    },
    opts
  )
}

// ─── Keychains ───────────────────────────────────────────────────────────────

export type RoutingKeychainColumnId =
  | "numid"
  | "name"
  | "algorithm"
  | "key"
  | "description"
  | "tags"
const KEYCHAIN_ORDER: RoutingKeychainColumnId[] = [
  "numid",
  "name",
  "algorithm",
  "key",
  "description",
  "tags",
]

export function buildRoutingKeychainColumns<
  T extends RoutingKeychain = RoutingKeychain,
>(opts: CommonOpts<T, RoutingKeychainColumnId> = {}): ColumnDef<T, unknown>[] {
  return assemble<T, RoutingKeychainColumnId>(
    KEYCHAIN_ORDER,
    {
      numid: () => numidColumn<T>({ get: (r) => r.numid }),
      name: () =>
        nameColumn<T>("/routing-keychains/$id", "routing.routingkeychain"),
      algorithm: () => ({
        id: "algorithm",
        accessorKey: "algorithm",
        header: "Algorithm",
        cell: ({ row }) => (
          <span className="font-mono text-[11px] text-muted-foreground uppercase">
            {row.original.algorithm}
          </span>
        ),
        meta: {
          facet: {
            kind: "enum",
            label: "Algorithm",
            get: (r: T) => r.algorithm,
            formatValue: (v) => ({ label: String(v).toUpperCase() }),
          },
        },
      }),
      key: () => ({
        id: "key",
        accessorFn: (r) => (r.psk_set ? "set" : "unset"),
        header: "Key",
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">
            {row.original.psk_set ? "Stored" : "Not set"}
          </span>
        ),
        meta: {
          facet: {
            kind: "enum",
            label: "Key",
            get: (r: T) => (r.psk_set ? "set" : "unset"),
            formatValue: (v) => ({ label: v === "set" ? "Stored" : "Not set" }),
          },
        },
      }),
      description: () => descriptionColumn<T>(),
      tags: tags<T>(opts),
    },
    opts
  )
}

// ─── Static routes ───────────────────────────────────────────────────────────

export type StaticRouteColumnId =
  | "numid"
  | "prefix"
  | "device"
  | "vrf"
  | "next_hop"
  | "kind"
  | "distance"
  | "metric"
  | "status"
  | "description"
  | "tags"
const STATIC_ROUTE_ORDER: StaticRouteColumnId[] = [
  "numid",
  "prefix",
  "device",
  "vrf",
  "next_hop",
  "kind",
  "distance",
  "metric",
  "status",
  "description",
  "tags",
]

export function buildStaticRouteColumns<T extends StaticRoute = StaticRoute>(
  opts: CommonOpts<T, StaticRouteColumnId> = {}
): ColumnDef<T, unknown>[] {
  return assemble<T, StaticRouteColumnId>(
    STATIC_ROUTE_ORDER,
    {
      numid: () => numidColumn<T>({ get: (r) => r.numid }),
      prefix: () => ({
        id: "prefix",
        accessorKey: "prefix",
        header: ({ column }) => <SortHeader column={column} label="Prefix" />,
        cell: ({ row }) => (
          <span className="inline-flex items-center gap-1.5">
            <Link
              to="/static-routes/$id"
              params={{ id: row.original.id }}
              className="link font-mono font-medium"
            >
              {row.original.prefix}
            </Link>
            <PlannedChangeMarker
              objectType="routing.staticroute"
              objectId={row.original.id}
            />
          </span>
        ),
      }),
      device: () => ({
        id: "device",
        accessorFn: (r) => r.device.name,
        header: ({ column }) => <SortHeader column={column} label="Device" />,
        cell: ({ row }) => (
          <Link
            to="/devices/$id"
            params={{ id: row.original.device.id }}
            className="link text-xs"
          >
            {row.original.device.name}
          </Link>
        ),
        meta: {
          facet: {
            kind: "enum",
            label: "Device",
            get: (r: T) => r.device.id,
            formatValue: (_v, sample) => ({ label: sample.device.name }),
          },
        },
      }),
      vrf: () => ({
        id: "vrf",
        accessorFn: (r) => r.vrf?.name ?? "",
        header: "VRF",
        cell: ({ row }) =>
          row.original.vrf ? (
            <Link
              to="/vrfs/$id"
              params={{ id: row.original.vrf.id }}
              className="inline-flex"
            >
              <ColorBadge
                name={row.original.vrf.name}
                color={row.original.vrf.color}
              />
            </Link>
          ) : (
            <span className="text-xs text-muted-foreground">Global</span>
          ),
        meta: {
          facet: {
            kind: "enum",
            label: "VRF",
            get: (r: T) => r.vrf?.id ?? "__none__",
            formatValue: (_v, sample) => ({
              label: sample.vrf?.name ?? "Global",
              color: sample.vrf?.color,
            }),
          },
        },
      }),
      next_hop: () => ({
        id: "next_hop",
        accessorFn: (r) => r.next_hop || r.next_hop_interface?.name || "",
        header: "Next hop",
        cell: ({ row }) => {
          const r = row.original
          if (r.kind === "interface")
            return (
              <span className="font-mono text-xs">
                {r.next_hop_interface?.name ?? dash}
                {r.next_hop_vrf && (
                  <span className="text-muted-foreground">
                    {" "}
                    in {r.next_hop_vrf.name}
                  </span>
                )}
              </span>
            )
          if (r.kind !== "nexthop")
            return (
              <span className="text-xs text-muted-foreground">
                {r.kind_display}
              </span>
            )
          return (
            <span className="font-mono text-xs">
              {r.next_hop || dash}
              {r.next_hop_interface && (
                <span className="text-muted-foreground">
                  {r.next_hop ? " via " : ""}
                  {r.next_hop_interface.name}
                </span>
              )}
              {r.next_hop_vrf && (
                <span className="text-muted-foreground">
                  {" "}
                  in {r.next_hop_vrf.name}
                </span>
              )}
            </span>
          )
        },
      }),
      kind: () => ({
        id: "kind",
        accessorKey: "kind",
        header: "Kind",
        cell: ({ row }) => (
          <span className="text-xs">{row.original.kind_display}</span>
        ),
        meta: {
          facet: {
            kind: "enum",
            label: "Kind",
            get: (r: T) => r.kind,
            formatValue: (_v, sample) => ({ label: sample.kind_display }),
          },
        },
      }),
      distance: () => ({
        id: "distance",
        accessorKey: "distance",
        header: ({ column }) => <SortHeader column={column} label="Distance" />,
        cell: ({ row }) =>
          row.original.distance != null ? (
            <span className="num text-xs">{row.original.distance}</span>
          ) : (
            dash
          ),
      }),
      metric: () => ({
        id: "metric",
        accessorKey: "metric",
        header: ({ column }) => <SortHeader column={column} label="Metric" />,
        cell: ({ row }) =>
          row.original.metric != null ? (
            <span className="num text-xs">{row.original.metric}</span>
          ) : (
            dash
          ),
      }),
      status: () => ({
        id: "status",
        accessorFn: (r) => r.status?.name ?? "",
        header: ({ column }) => <SortHeader column={column} label="Status" />,
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
        meta: {
          facet: {
            kind: "enum",
            label: "Status",
            get: (r: T) => r.status?.id ?? "__none__",
            formatValue: (_v, r) => ({
              label: r.status?.name ?? "No status",
              color: r.status?.color,
            }),
          },
        },
      }),
      description: () => descriptionColumn<T>(),
      tags: tags<T>(opts),
    },
    opts
  )
}

// ─── BGP peer groups ─────────────────────────────────────────────────────────

export type BGPPeerGroupColumnId =
  | "numid"
  | "name"
  | "remote_asn"
  | "address_families"
  | "session_count"
  | "description"
  | "tags"
const PEER_GROUP_ORDER: BGPPeerGroupColumnId[] = [
  "numid",
  "name",
  "remote_asn",
  "address_families",
  "session_count",
  "description",
  "tags",
]

export function remoteAsnLabel(r: {
  remote_asn: number | null
  remote_asn_mode: string
}): string {
  if (r.remote_asn_mode === "external") return "external"
  if (r.remote_asn_mode === "internal") return "internal"
  return r.remote_asn != null ? String(r.remote_asn) : ""
}

export function buildBGPPeerGroupColumns<T extends BGPPeerGroup = BGPPeerGroup>(
  opts: CommonOpts<T, BGPPeerGroupColumnId> = {}
): ColumnDef<T, unknown>[] {
  return assemble<T, BGPPeerGroupColumnId>(
    PEER_GROUP_ORDER,
    {
      numid: () => numidColumn<T>({ get: (r) => r.numid }),
      name: () => nameColumn<T>("/bgp-peer-groups/$id", "routing.bgppeergroup"),
      remote_asn: () => ({
        id: "remote_asn",
        accessorFn: (r) => remoteAsnLabel(r),
        header: ({ column }) => (
          <SortHeader column={column} label="Remote AS" />
        ),
        cell: ({ row }) => (
          <span className="num font-mono text-xs">
            {remoteAsnLabel(row.original) || dash}
          </span>
        ),
      }),
      address_families: () => ({
        id: "address_families",
        accessorFn: (r) => r.address_families.join(" "),
        header: "Address families",
        cell: ({ row }) => (
          <span className="font-mono text-[11px] text-muted-foreground">
            {row.original.address_families.join(", ") || dash}
          </span>
        ),
      }),
      session_count: () => ({
        id: "session_count",
        accessorKey: "session_count",
        header: ({ column }) => <SortHeader column={column} label="Sessions" />,
        cell: ({ row }) => (
          <span className="num text-xs">{row.original.session_count}</span>
        ),
      }),
      description: () => descriptionColumn<T>(),
      tags: tags<T>(opts),
    },
    opts
  )
}

// ─── BGP sessions ────────────────────────────────────────────────────────────

export type BGPSessionColumnId =
  | "numid"
  | "neighbor"
  | "kind"
  | "device"
  | "vrf"
  | "local_asn"
  | "remote_asn"
  | "peer_group"
  | "peer_device"
  | "address_families"
  | "status"
  | "description"
  | "tags"
const SESSION_ORDER: BGPSessionColumnId[] = [
  "numid",
  "neighbor",
  "kind",
  "device",
  "vrf",
  "local_asn",
  "remote_asn",
  "peer_group",
  "peer_device",
  "address_families",
  "status",
  "description",
  "tags",
]

export function sessionNeighbor(s: BGPSession): string {
  return s.remote_address || s.interface?.name || s.name || "?"
}

export function buildBGPSessionColumns<T extends BGPSession = BGPSession>(
  opts: CommonOpts<T, BGPSessionColumnId> = {}
): ColumnDef<T, unknown>[] {
  return assemble<T, BGPSessionColumnId>(
    SESSION_ORDER,
    {
      numid: () => numidColumn<T>({ get: (r) => r.numid }),
      neighbor: () => ({
        id: "neighbor",
        accessorFn: (r) => sessionNeighbor(r),
        header: ({ column }) => <SortHeader column={column} label="Neighbor" />,
        cell: ({ row }) => (
          <span className="inline-flex items-center gap-1.5">
            <Link
              to="/bgp-sessions/$id"
              params={{ id: row.original.id }}
              className="link font-mono font-medium"
            >
              {sessionNeighbor(row.original)}
            </Link>
            {row.original.interface && (
              <span className="text-[10px] text-muted-foreground">
                unnumbered
              </span>
            )}
            <PlannedChangeMarker
              objectType="routing.bgpsession"
              objectId={row.original.id}
            />
          </span>
        ),
      }),
      kind: () => ({
        id: "kind",
        accessorFn: (r) => r.effective.kind ?? "",
        header: "Kind",
        cell: ({ row }) =>
          row.original.effective.kind ? (
            <Badge variant="outline">
              {row.original.effective.kind === "ibgp" ? "iBGP" : "eBGP"}
            </Badge>
          ) : (
            dash
          ),
        meta: {
          facet: {
            kind: "enum",
            label: "Kind",
            get: (r: T) => r.effective.kind ?? "__none__",
            formatValue: (v) => ({
              label: v === "ibgp" ? "iBGP" : v === "ebgp" ? "eBGP" : "Unknown",
            }),
          },
        },
      }),
      device: () => ({
        id: "device",
        accessorFn: (r) => r.instance.device.name,
        header: ({ column }) => <SortHeader column={column} label="Device" />,
        cell: ({ row }) => (
          <Link
            to="/devices/$id"
            params={{ id: row.original.instance.device.id }}
            search={{ tab: "routing" }}
            className="link text-xs"
          >
            {row.original.instance.device.name}
          </Link>
        ),
        meta: {
          facet: {
            kind: "enum",
            label: "Device",
            get: (r: T) => r.instance.device.id,
            formatValue: (_v, sample) => ({
              label: sample.instance.device.name,
            }),
          },
        },
      }),
      vrf: () => ({
        id: "vrf",
        accessorFn: (r) => r.instance.vrf?.name ?? "",
        header: "VRF",
        cell: ({ row }) =>
          row.original.instance.vrf ? (
            <ColorBadge
              name={row.original.instance.vrf.name}
              color={row.original.instance.vrf.color}
            />
          ) : (
            <span className="text-xs text-muted-foreground">Global</span>
          ),
        meta: {
          facet: {
            kind: "enum",
            label: "VRF",
            get: (r: T) => r.instance.vrf?.id ?? "__none__",
            formatValue: (_v, sample) => ({
              label: sample.instance.vrf?.name ?? "Global",
              color: sample.instance.vrf?.color,
            }),
          },
        },
      }),
      local_asn: () => ({
        id: "local_asn",
        accessorFn: (r) => r.effective.local_asn,
        header: ({ column }) => <SortHeader column={column} label="Local AS" />,
        cell: ({ row }) => (
          <span className="num font-mono text-xs">
            {row.original.effective.local_asn}
          </span>
        ),
        meta: {
          facet: {
            kind: "enum",
            label: "Local AS",
            get: (r: T) => String(r.effective.local_asn),
            formatValue: (v) => ({ label: String(v) }),
          },
        },
      }),
      remote_asn: () => ({
        id: "remote_asn",
        accessorFn: (r) => remoteAsnLabel(r.effective),
        header: ({ column }) => (
          <SortHeader column={column} label="Remote AS" />
        ),
        cell: ({ row }) => (
          <span className="num font-mono text-xs">
            {remoteAsnLabel(row.original.effective) || dash}
          </span>
        ),
        meta: {
          facet: {
            kind: "enum",
            label: "Remote AS",
            get: (r: T) => remoteAsnLabel(r.effective) || "__none__",
            formatValue: (v) => ({ label: v === "__none__" ? "-" : String(v) }),
          },
        },
      }),
      peer_group: () => ({
        id: "peer_group",
        accessorFn: (r) => r.peer_group?.name ?? "",
        header: "Peer group",
        cell: ({ row }) =>
          row.original.peer_group ? (
            <Link
              to="/bgp-peer-groups/$id"
              params={{ id: row.original.peer_group.id }}
              className="link font-mono text-xs"
            >
              {row.original.peer_group.name}
            </Link>
          ) : (
            dash
          ),
        meta: {
          facet: {
            kind: "enum",
            label: "Peer group",
            get: (r: T) => r.peer_group?.id ?? "__none__",
            formatValue: (_v, sample) => ({
              label: sample.peer_group?.name ?? "No group",
            }),
          },
        },
      }),
      peer_device: () => ({
        id: "peer_device",
        accessorFn: (r) => r.peer_device?.name ?? "",
        header: "Peer device",
        cell: ({ row }) =>
          row.original.peer_device ? (
            <Link
              to="/devices/$id"
              params={{ id: row.original.peer_device.id }}
              search={{ tab: "routing" }}
              className="link text-xs"
            >
              {row.original.peer_device.name}
            </Link>
          ) : (
            dash
          ),
      }),
      address_families: () => ({
        id: "address_families",
        accessorFn: (r) => r.effective.address_families.join(" "),
        header: "Address families",
        cell: ({ row }) => (
          <span className="font-mono text-[11px] text-muted-foreground">
            {row.original.effective.address_families.join(", ") || dash}
          </span>
        ),
        meta: {
          facet: {
            kind: "enum",
            label: "Address family",
            get: (r: T) => r.effective.address_families[0] ?? "__none__",
            formatValue: (v) => ({
              label: v === "__none__" ? "None" : String(v),
            }),
          },
        },
      }),
      status: () => ({
        id: "status",
        accessorFn: (r) => r.status?.name ?? "",
        header: ({ column }) => <SortHeader column={column} label="Status" />,
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
        meta: {
          facet: {
            kind: "enum",
            label: "Status",
            get: (r: T) => r.status?.id ?? "__none__",
            formatValue: (_v, r) => ({
              label: r.status?.name ?? "No status",
              color: r.status?.color,
            }),
          },
        },
      }),
      description: () => descriptionColumn<T>(),
      tags: tags<T>(opts),
    },
    opts
  )
}

// ─── OSPF areas ──────────────────────────────────────────────────────────────

export type OSPFAreaColumnId =
  | "numid"
  | "name"
  | "area_id"
  | "kind"
  | "interface_count"
  | "description"
  | "tags"
const OSPF_AREA_ORDER: OSPFAreaColumnId[] = [
  "numid",
  "name",
  "area_id",
  "kind",
  "interface_count",
  "description",
  "tags",
]

export function buildOSPFAreaColumns<T extends OSPFArea = OSPFArea>(
  opts: CommonOpts<T, OSPFAreaColumnId> = {}
): ColumnDef<T, unknown>[] {
  return assemble<T, OSPFAreaColumnId>(
    OSPF_AREA_ORDER,
    {
      numid: () => numidColumn<T>({ get: (r) => r.numid }),
      name: () => nameColumn<T>("/ospf-areas/$id", "routing.ospfarea"),
      area_id: () => ({
        id: "area_id",
        accessorKey: "area_id",
        header: ({ column }) => <SortHeader column={column} label="Area" />,
        cell: ({ row }) => (
          <span className="num font-mono text-xs">{row.original.area_id}</span>
        ),
      }),
      kind: () => ({
        id: "kind",
        accessorKey: "kind",
        header: "Kind",
        cell: ({ row }) => (
          <span className="text-xs">{row.original.kind_display}</span>
        ),
        meta: {
          facet: {
            kind: "enum",
            label: "Kind",
            get: (r: T) => r.kind,
            formatValue: (_v, sample) => ({ label: sample.kind_display }),
          },
        },
      }),
      interface_count: () => ({
        id: "interface_count",
        accessorKey: "interface_count",
        header: ({ column }) => (
          <SortHeader column={column} label="Interfaces" />
        ),
        cell: ({ row }) => (
          <span className="num text-xs">{row.original.interface_count}</span>
        ),
      }),
      description: () => descriptionColumn<T>(),
      tags: tags<T>(opts),
    },
    opts
  )
}

// ─── VTEPs ───────────────────────────────────────────────────────────────────

export type VTEPColumnId =
  | "numid"
  | "device"
  | "site"
  | "source_interface"
  | "source_ip"
  | "anycast_ip"
  | "vni_count"
  | "status"
  | "description"
  | "tags"
const VTEP_ORDER: VTEPColumnId[] = [
  "numid",
  "device",
  "site",
  "source_interface",
  "source_ip",
  "anycast_ip",
  "vni_count",
  "status",
  "description",
  "tags",
]

/** A VTEP has no page of its own - the row links to the device's Routing
 * tab, where it is edited. */
export function buildVTEPColumns<T extends VTEP = VTEP>(
  opts: CommonOpts<T, VTEPColumnId> = {}
): ColumnDef<T, unknown>[] {
  return assemble<T, VTEPColumnId>(
    VTEP_ORDER,
    {
      numid: () => numidColumn<T>({ get: (r) => r.numid }),
      device: () => ({
        id: "device",
        accessorFn: (r) => r.device.name,
        header: ({ column }) => <SortHeader column={column} label="Device" />,
        cell: ({ row }) => (
          <span className="inline-flex items-center gap-1.5">
            <Link
              to="/devices/$id"
              params={{ id: row.original.device.id }}
              search={{ tab: "routing" }}
              className="link font-medium"
            >
              {row.original.device.name}
            </Link>
            <PlannedChangeMarker
              objectType="routing.vtep"
              objectId={row.original.id}
            />
          </span>
        ),
      }),
      site: () => ({
        id: "site",
        accessorFn: (r) => r.site?.name ?? "",
        header: ({ column }) => <SortHeader column={column} label="Site" />,
        cell: ({ row }) =>
          row.original.site ? (
            <Link
              to="/sites/$id"
              params={{ id: row.original.site.id }}
              className="link text-xs"
            >
              {row.original.site.name}
            </Link>
          ) : (
            dash
          ),
        meta: {
          facet: {
            kind: "enum",
            label: "Site",
            get: (r: T) => r.site?.id ?? "__none__",
            formatValue: (_v, sample) => ({
              label: sample.site?.name ?? "No site",
            }),
          },
        },
      }),
      source_interface: () => ({
        id: "source_interface",
        accessorFn: (r) => r.source_interface?.name ?? "",
        header: "Source",
        cell: ({ row }) =>
          row.original.source_interface ? (
            <Link
              to="/interfaces/$id"
              params={{ id: row.original.source_interface.id }}
              className="link font-mono text-xs"
            >
              {row.original.source_interface.name}
            </Link>
          ) : (
            dash
          ),
      }),
      source_ip: () => ({
        id: "source_ip",
        accessorFn: (r) => r.source_ip?.ip_address ?? "",
        header: "Source IP",
        cell: ({ row }) =>
          row.original.source_ip ? (
            <Link
              to="/ips/$id"
              params={{ id: row.original.source_ip.id }}
              className="link font-mono text-xs"
            >
              {row.original.source_ip.ip_address}
            </Link>
          ) : (
            dash
          ),
      }),
      anycast_ip: () => ({
        id: "anycast_ip",
        accessorFn: (r) => r.anycast_ip?.ip_address ?? "",
        header: "Anycast",
        cell: ({ row }) =>
          row.original.anycast_ip ? (
            <span className="font-mono text-xs">
              {row.original.anycast_ip.ip_address}
            </span>
          ) : (
            dash
          ),
      }),
      vni_count: () => ({
        id: "vni_count",
        accessorFn: (r) => r.memberships.length,
        header: ({ column }) => <SortHeader column={column} label="VNIs" />,
        cell: ({ row }) => (
          <span className="num text-xs">{row.original.memberships.length}</span>
        ),
      }),
      status: () => ({
        id: "status",
        accessorFn: (r) => r.status?.name ?? "",
        header: ({ column }) => <SortHeader column={column} label="Status" />,
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
        meta: {
          facet: {
            kind: "enum",
            label: "Status",
            get: (r: T) => r.status?.id ?? "__none__",
            formatValue: (_v, r) => ({
              label: r.status?.name ?? "No status",
              color: r.status?.color,
            }),
          },
        },
      }),
      description: () => descriptionColumn<T>(),
      tags: tags<T>(opts),
    },
    opts
  )
}

// ─── Protocol instances ──────────────────────────────────────────────────────
// A fleet-wide row per instance. Instances have no page of their own: the
// device cell and the pencil lead to the device's Routing tab, where the
// instance is edited and where a new one is added.

type InstanceRow = {
  id: string
  device: { id: string; name: string }
  site: { id: string; name: string } | null
  vrf: { id: string; name: string; rd: string; color: string } | null
  status: StatusMini | null
  description: string
}

function instanceDeviceColumn<T extends InstanceRow>(
  objectType: string
): ColumnDef<T, unknown> {
  return {
    id: "device",
    accessorFn: (r) => r.device.name,
    header: ({ column }) => <SortHeader column={column} label="Device" />,
    cell: ({ row }) => (
      <span className="inline-flex items-center gap-1.5">
        <Link
          to="/devices/$id"
          params={{ id: row.original.device.id }}
          search={{ tab: "routing" }}
          className="link font-medium"
        >
          {row.original.device.name}
        </Link>
        <PlannedChangeMarker
          objectType={objectType}
          objectId={row.original.id}
        />
      </span>
    ),
    meta: {
      facet: {
        kind: "enum",
        label: "Device",
        get: (r: T) => r.device.id,
        formatValue: (_v, sample) => ({ label: sample.device.name }),
      },
    },
  }
}

function instanceSiteColumn<T extends InstanceRow>(): ColumnDef<T, unknown> {
  return {
    id: "site",
    accessorFn: (r) => r.site?.name ?? "",
    header: ({ column }) => <SortHeader column={column} label="Site" />,
    cell: ({ row }) =>
      row.original.site ? (
        <Link
          to="/sites/$id"
          params={{ id: row.original.site.id }}
          className="link text-xs"
        >
          {row.original.site.name}
        </Link>
      ) : (
        dash
      ),
    meta: {
      facet: {
        kind: "enum",
        label: "Site",
        get: (r: T) => r.site?.id ?? "__none__",
        formatValue: (_v, sample) => ({
          label: sample.site?.name ?? "No site",
        }),
      },
    },
  }
}

function instanceVrfColumn<T extends InstanceRow>(): ColumnDef<T, unknown> {
  return {
    id: "vrf",
    accessorFn: (r) => r.vrf?.name ?? "",
    header: "VRF",
    cell: ({ row }) =>
      row.original.vrf ? (
        <Link
          to="/vrfs/$id"
          params={{ id: row.original.vrf.id }}
          className="inline-flex"
        >
          <ColorBadge
            name={row.original.vrf.name}
            color={row.original.vrf.color}
          />
        </Link>
      ) : (
        <span className="text-xs text-muted-foreground">Global</span>
      ),
    meta: {
      facet: {
        kind: "enum",
        label: "VRF",
        get: (r: T) => r.vrf?.id ?? "__none__",
        formatValue: (_v, sample) => ({
          label: sample.vrf?.name ?? "Global",
          color: sample.vrf?.color,
        }),
      },
    },
  }
}

function instanceStatusColumn<T extends InstanceRow>(): ColumnDef<T, unknown> {
  return {
    id: "status",
    accessorFn: (r) => r.status?.name ?? "",
    header: ({ column }) => <SortHeader column={column} label="Status" />,
    cell: ({ row }) => <StatusBadge status={row.original.status} />,
    meta: {
      facet: {
        kind: "enum",
        label: "Status",
        get: (r: T) => r.status?.id ?? "__none__",
        formatValue: (_v, r) => ({
          label: r.status?.name ?? "No status",
          color: r.status?.color,
        }),
      },
    },
  }
}

const mono = (v: string | null | undefined) =>
  v ? <span className="font-mono text-xs">{v}</span> : dash

export type BGPInstanceColumnId =
  | "numid"
  | "device"
  | "site"
  | "asn"
  | "vrf"
  | "router_id"
  | "address_families"
  | "session_count"
  | "status"
  | "description"
  | "tags"
const BGP_INSTANCE_ORDER: BGPInstanceColumnId[] = [
  "numid",
  "device",
  "site",
  "asn",
  "vrf",
  "router_id",
  "address_families",
  "session_count",
  "status",
  "description",
  "tags",
]

export function buildBGPInstanceColumns<T extends BGPInstance = BGPInstance>(
  opts: CommonOpts<T, BGPInstanceColumnId> = {}
): ColumnDef<T, unknown>[] {
  return assemble<T, BGPInstanceColumnId>(
    BGP_INSTANCE_ORDER,
    {
      numid: () => numidColumn<T>({ get: (r) => r.numid }),
      device: () => instanceDeviceColumn<T>("routing.bgpinstance"),
      site: () => instanceSiteColumn<T>(),
      asn: () => ({
        id: "asn",
        accessorFn: (r) => r.asn.asn,
        header: ({ column }) => <SortHeader column={column} label="AS" />,
        cell: ({ row }) => (
          <Link
            to="/asns/$id"
            params={{ id: row.original.asn.id }}
            className="link num font-mono"
          >
            AS{row.original.asn.asn}
          </Link>
        ),
        meta: {
          facet: {
            kind: "enum",
            label: "AS",
            get: (r: T) => r.asn.id,
            formatValue: (_v, sample) => ({ label: `AS${sample.asn.asn}` }),
          },
        },
      }),
      vrf: () => instanceVrfColumn<T>(),
      router_id: () => ({
        id: "router_id",
        accessorKey: "router_id",
        header: "Router ID",
        cell: ({ row }) => mono(row.original.router_id),
      }),
      address_families: () => ({
        id: "address_families",
        accessorFn: (r) => r.address_families.map((a) => a.afi_safi).join(" "),
        header: "Address families",
        cell: ({ row }) =>
          mono(row.original.address_families.map((a) => a.afi_safi).join(", ")),
      }),
      session_count: () => ({
        id: "session_count",
        accessorKey: "session_count",
        header: ({ column }) => <SortHeader column={column} label="Sessions" />,
        cell: ({ row }) => (
          <span className="num text-xs">{row.original.session_count}</span>
        ),
      }),
      status: () => instanceStatusColumn<T>(),
      description: () => descriptionColumn<T>(),
      tags: tags<T>(opts),
    },
    opts
  )
}

export type OSPFInstanceColumnId =
  | "numid"
  | "device"
  | "site"
  | "process_id"
  | "version"
  | "vrf"
  | "router_id"
  | "areas"
  | "interface_count"
  | "status"
  | "description"
  | "tags"
const OSPF_INSTANCE_ORDER: OSPFInstanceColumnId[] = [
  "numid",
  "device",
  "site",
  "process_id",
  "version",
  "vrf",
  "router_id",
  "areas",
  "interface_count",
  "status",
  "description",
  "tags",
]

export function buildOSPFInstanceColumns<T extends OSPFInstance = OSPFInstance>(
  opts: CommonOpts<T, OSPFInstanceColumnId> = {}
): ColumnDef<T, unknown>[] {
  const areasOf = (r: T) =>
    Array.from(new Set(r.interfaces.map((i) => i.area.area_id))).sort()
  return assemble<T, OSPFInstanceColumnId>(
    OSPF_INSTANCE_ORDER,
    {
      numid: () => numidColumn<T>({ get: (r) => r.numid }),
      device: () => instanceDeviceColumn<T>("routing.ospfinstance"),
      site: () => instanceSiteColumn<T>(),
      process_id: () => ({
        id: "process_id",
        accessorKey: "process_id",
        header: ({ column }) => <SortHeader column={column} label="Process" />,
        cell: ({ row }) => mono(row.original.process_id),
      }),
      version: () => ({
        id: "version",
        accessorKey: "version",
        header: "Version",
        cell: ({ row }) => (
          <Badge variant="secondary">OSPFv{row.original.version}</Badge>
        ),
        meta: {
          facet: {
            kind: "enum",
            label: "Version",
            get: (r: T) => String(r.version),
            formatValue: (v) => ({ label: `OSPFv${v}` }),
          },
        },
      }),
      vrf: () => instanceVrfColumn<T>(),
      router_id: () => ({
        id: "router_id",
        accessorKey: "router_id",
        header: "Router ID",
        cell: ({ row }) => mono(row.original.router_id),
      }),
      areas: () => ({
        id: "areas",
        accessorFn: (r) => areasOf(r).join(" "),
        header: "Areas",
        cell: ({ row }) => mono(areasOf(row.original).join(", ")),
      }),
      interface_count: () => ({
        id: "interface_count",
        accessorKey: "interface_count",
        header: ({ column }) => (
          <SortHeader column={column} label="Interfaces" />
        ),
        cell: ({ row }) => (
          <span className="num text-xs">{row.original.interface_count}</span>
        ),
      }),
      status: () => instanceStatusColumn<T>(),
      description: () => descriptionColumn<T>(),
      tags: tags<T>(opts),
    },
    opts
  )
}

export type ISISInstanceColumnId =
  | "numid"
  | "device"
  | "site"
  | "process"
  | "net"
  | "router_id"
  | "vrf"
  | "level"
  | "metric_style"
  | "interface_count"
  | "status"
  | "description"
  | "tags"
const ISIS_INSTANCE_ORDER: ISISInstanceColumnId[] = [
  "numid",
  "device",
  "site",
  "process",
  "net",
  "router_id",
  "vrf",
  "level",
  "metric_style",
  "interface_count",
  "status",
  "description",
  "tags",
]

export function buildISISInstanceColumns<T extends ISISInstance = ISISInstance>(
  opts: CommonOpts<T, ISISInstanceColumnId> = {}
): ColumnDef<T, unknown>[] {
  return assemble<T, ISISInstanceColumnId>(
    ISIS_INSTANCE_ORDER,
    {
      numid: () => numidColumn<T>({ get: (r) => r.numid }),
      device: () => instanceDeviceColumn<T>("routing.isisinstance"),
      site: () => instanceSiteColumn<T>(),
      process: () => ({
        id: "process",
        accessorKey: "process",
        header: ({ column }) => <SortHeader column={column} label="Process" />,
        cell: ({ row }) => mono(row.original.process),
      }),
      net: () => ({
        id: "net",
        accessorKey: "net",
        header: "NET",
        cell: ({ row }) => mono(row.original.net),
      }),
      router_id: () => ({
        id: "router_id",
        accessorKey: "router_id",
        header: "Router ID",
        cell: ({ row }) => mono(row.original.router_id),
      }),
      vrf: () => instanceVrfColumn<T>(),
      level: () => ({
        id: "level",
        accessorKey: "level",
        header: "Level",
        cell: ({ row }) => (
          <Badge variant="secondary">level {row.original.level}</Badge>
        ),
        meta: {
          facet: {
            kind: "enum",
            label: "Level",
            get: (r: T) => r.level,
            formatValue: (v) => ({ label: `level ${v}` }),
          },
        },
      }),
      metric_style: () => ({
        id: "metric_style",
        accessorKey: "metric_style",
        header: "Metric",
        cell: ({ row }) => (
          <span className="text-xs">{row.original.metric_style}</span>
        ),
      }),
      interface_count: () => ({
        id: "interface_count",
        accessorKey: "interface_count",
        header: ({ column }) => (
          <SortHeader column={column} label="Interfaces" />
        ),
        cell: ({ row }) => (
          <span className="num text-xs">{row.original.interface_count}</span>
        ),
      }),
      status: () => instanceStatusColumn<T>(),
      description: () => descriptionColumn<T>(),
      tags: tags<T>(opts),
    },
    opts
  )
}

export type EIGRPInstanceColumnId =
  | "numid"
  | "device"
  | "site"
  | "asn"
  | "name"
  | "vrf"
  | "router_id"
  | "interface_count"
  | "status"
  | "description"
  | "tags"
const EIGRP_INSTANCE_ORDER: EIGRPInstanceColumnId[] = [
  "numid",
  "device",
  "site",
  "asn",
  "name",
  "vrf",
  "router_id",
  "interface_count",
  "status",
  "description",
  "tags",
]

export function buildEIGRPInstanceColumns<
  T extends EIGRPInstance = EIGRPInstance,
>(opts: CommonOpts<T, EIGRPInstanceColumnId> = {}): ColumnDef<T, unknown>[] {
  return assemble<T, EIGRPInstanceColumnId>(
    EIGRP_INSTANCE_ORDER,
    {
      numid: () => numidColumn<T>({ get: (r) => r.numid }),
      device: () => instanceDeviceColumn<T>("routing.eigrpinstance"),
      site: () => instanceSiteColumn<T>(),
      asn: () => ({
        id: "asn",
        accessorKey: "asn",
        header: ({ column }) => <SortHeader column={column} label="AS" />,
        cell: ({ row }) => (
          <span className="num font-mono text-xs">{row.original.asn}</span>
        ),
        meta: {
          facet: {
            kind: "enum",
            label: "AS",
            get: (r: T) => String(r.asn),
            formatValue: (v) => ({ label: `AS ${v}` }),
          },
        },
      }),
      name: () => ({
        id: "name",
        accessorKey: "name",
        header: "Name",
        cell: ({ row }) => mono(row.original.name),
      }),
      vrf: () => instanceVrfColumn<T>(),
      router_id: () => ({
        id: "router_id",
        accessorKey: "router_id",
        header: "Router ID",
        cell: ({ row }) => mono(row.original.router_id),
      }),
      interface_count: () => ({
        id: "interface_count",
        accessorKey: "interface_count",
        header: ({ column }) => (
          <SortHeader column={column} label="Interfaces" />
        ),
        cell: ({ row }) => (
          <span className="num text-xs">{row.original.interface_count}</span>
        ),
      }),
      status: () => instanceStatusColumn<T>(),
      description: () => descriptionColumn<T>(),
      tags: tags<T>(opts),
    },
    opts
  )
}

// ─── BFD profiles ────────────────────────────────────────────────────────────

export type BFDProfileColumnId =
  | "numid"
  | "name"
  | "min_tx"
  | "min_rx"
  | "multiplier"
  | "echo"
  | "description"
  | "tags"
const BFD_PROFILE_ORDER: BFDProfileColumnId[] = [
  "numid",
  "name",
  "min_tx",
  "min_rx",
  "multiplier",
  "echo",
  "description",
  "tags",
]

export function buildBFDProfileColumns<T extends BFDProfile = BFDProfile>(
  opts: CommonOpts<T, BFDProfileColumnId> = {}
): ColumnDef<T, unknown>[] {
  const ms = (
    id: "min_tx" | "min_rx",
    label: string
  ): ColumnDef<T, unknown> => ({
    id,
    accessorKey: id,
    header: ({ column }) => <SortHeader column={column} label={label} />,
    cell: ({ row }) => (
      <span className="num text-xs">
        {row.original[id]}
        <span className="text-muted-foreground"> ms</span>
      </span>
    ),
  })
  return assemble<T, BFDProfileColumnId>(
    BFD_PROFILE_ORDER,
    {
      numid: () => numidColumn<T>({ get: (r) => r.numid }),
      name: () => nameColumn<T>("/bfd-profiles/$id", "routing.bfdprofile"),
      min_tx: () => ms("min_tx", "Min TX"),
      min_rx: () => ms("min_rx", "Min RX"),
      multiplier: () => ({
        id: "multiplier",
        accessorKey: "multiplier",
        header: ({ column }) => (
          <SortHeader column={column} label="Multiplier" />
        ),
        cell: ({ row }) => (
          <span className="num text-xs">{row.original.multiplier}</span>
        ),
      }),
      echo: () => ({
        id: "echo",
        accessorKey: "echo",
        header: "Echo",
        cell: ({ row }) =>
          row.original.echo ? <Badge variant="secondary">echo</Badge> : dash,
      }),
      description: () => descriptionColumn<T>(),
      tags: tags<T>(opts),
    },
    opts
  )
}
