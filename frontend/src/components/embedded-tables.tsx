import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"

import { api } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import type {
  Cabinet,
  Cable,
  Circuit,
  Cluster,
  Contact,
  ContactGroup,
  IPAddress,
  L2VPN,
  Paginated,
  PowerFeed,
  Rack,
  BGPSession,
  StaticRoute,
  Tunnel,
  VirtualMachine,
  VirtualMachineGroup,
  VTEP,
  WirelessLAN,
} from "@/lib/api"
import { DataTable, selectionColumn } from "@/components/data-table"
import { buildCabinetColumns } from "@/components/columns/cabinet-columns"
import type { CabinetColumnId } from "@/components/columns/cabinet-columns"
import { buildCableColumns } from "@/components/columns/cable-columns"
import { buildCircuitColumns } from "@/components/columns/circuit-columns"
import type { CircuitColumnId } from "@/components/columns/circuit-columns"
import { buildClusterColumns } from "@/components/columns/cluster-columns"
import { buildContactColumns } from "@/components/columns/contact-columns"
import type { ContactColumnId } from "@/components/columns/contact-columns"
import { buildContactGroupColumns } from "@/components/columns/contact-group-columns"
import { buildIpColumns } from "@/components/columns/ip-columns"
import { buildL2VPNColumns } from "@/components/columns/l2vpn-columns"
import type { L2VPNColumnId } from "@/components/columns/l2vpn-columns"
import { buildPowerFeedColumns } from "@/components/columns/power-feed-columns"
import type { PowerFeedColumnId } from "@/components/columns/power-feed-columns"
import {
  buildRackColumns,
  type RackColumnId,
} from "@/components/columns/rack-columns"
import {
  buildBGPSessionColumns,
  buildStaticRouteColumns,
  buildVTEPColumns,
} from "@/components/columns/routing-columns"
import type {
  BGPSessionColumnId,
  StaticRouteColumnId,
  VTEPColumnId,
} from "@/components/columns/routing-columns"
import { buildTunnelColumns } from "@/components/columns/tunnel-columns"
import { buildVmColumns } from "@/components/columns/vm-columns"
import { buildVmGroupColumns } from "@/components/columns/vm-group-columns"
import type { TunnelColumnId } from "@/components/columns/tunnel-columns"
import { buildWirelessLANColumns } from "@/components/columns/wireless-lan-columns"
import type { WirelessLANColumnId } from "@/components/columns/wireless-lan-columns"
import { Loading } from "@/components/loading"
import { PowerFeedBulkBar } from "@/components/power-bulk-bars"
import { QueryError } from "@/components/query-error"
import { SafeBulkEditBar } from "@/components/safe-bulk-edit-bar"
import { useSlaStatus } from "@/components/monitoring/sla-status"

function useEmbed<T>(
  kind: string,
  endpoint: string,
  filter: Record<string, string>
) {
  const qs = useMemo(
    () => new URLSearchParams({ ...filter, page_size: "500" }).toString(),
    [filter]
  )
  return useQuery({
    queryKey: [kind, qs],
    queryFn: () => api<Paginated<T>>(`${endpoint}?${qs}`),
  })
}

function Frame<T>({
  q,
  emptyText,
  columns,
  flexColumn,
  tableId,
  selection,
  search,
}: {
  q: ReturnType<typeof useEmbed<T>>
  emptyText: string
  columns: ColumnDef<T>[]
  flexColumn: string
  tableId: string
  /** Row selection, for a table with a bulk bar. */
  selection?: { rows: T[]; onChange: (rows: T[]) => void }
  /** The search box's placeholder; omit for no search box. */
  search?: string
}) {
  if (q.isError) return <QueryError error={q.error} />
  if (q.isLoading) return <Loading />
  const rows = q.data?.results ?? []
  if (rows.length === 0)
    return <p className="text-sm text-muted-foreground">{emptyText}</p>
  return (
    <DataTable
      data={rows}
      total={q.data?.count}
      columns={columns}
      flexColumn={flexColumn}
      tableId={tableId}
      selectedRows={selection?.rows}
      onSelectedRowsChange={selection?.onChange}
      searchable={!!search}
      searchPlaceholder={search}
    />
  )
}

/** IP addresses scoped by role / status / vrf / prefix / site. */
export function EmbeddedIpTable({
  filter,
  emptyText = "No IP addresses.",
  searchable = true,
}: {
  filter: Record<string, string>
  emptyText?: string
  /** The search box above the rows; off for a list that stays short. */
  searchable?: boolean
}) {
  const q = useEmbed<IPAddress>("embedded-ips", "/api/ips/", filter)
  const columns = useMemo<ColumnDef<IPAddress>[]>(
    () =>
      buildIpColumns({
        include: ["ip", "status", "dhcp", "dns", "assigned"],
        copyButton: true,
      }),
    []
  )
  return (
    <Frame
      q={q}
      emptyText={emptyText}
      columns={columns}
      flexColumn="dns"
      tableId="ip-embedded"
      search={searchable ? "Search IP addresses…" : undefined}
    />
  )
}

/** Racks scoped by location / role / site. */
export function EmbeddedRackTable({
  filter,
  emptyText = "No racks.",
  searchable = true,
  include = ["name", "site", "width", "used"],
}: {
  filter: Record<string, string>
  emptyText?: string
  /** The search box above the rows; off for a list that stays short. */
  searchable?: boolean
  /** The columns, in the rack factory's terms - a site's tab leaves out Site. */
  include?: RackColumnId[]
}) {
  const q = useEmbed<Rack>("embedded-racks", "/api/racks/", filter)
  const key = include.join(",")
  const columns = useMemo<ColumnDef<Rack>[]>(
    () =>
      buildRackColumns({
        include: key.split(",") as RackColumnId[],
        siteVariant: "plain",
      }),
    [key]
  )
  return (
    <Frame
      q={q}
      emptyText={emptyText}
      columns={columns}
      flexColumn="name"
      tableId="embedded-racks"
      search={searchable ? "Search racks…" : undefined}
    />
  )
}

/** Cabinets scoped by site / location / role / type. Reuses the one cabinet
 * column factory - the same row the /cabinets list draws. `omit` drops the
 * column that repeats the page's own object (Site on a site's page). */
export function EmbeddedCabinetTable({
  filter,
  omit = [],
  emptyText = "No cabinets.",
  searchable = true,
}: {
  filter: Record<string, string>
  omit?: CabinetColumnId[]
  emptyText?: string
  /** The search box above the rows; off for a list that stays short. */
  searchable?: boolean
}) {
  const q = useEmbed<Cabinet>("embedded-cabinets", "/api/cabinets/", filter)
  const omitKey = omit.join(",")
  const columns = useMemo<ColumnDef<Cabinet>[]>(
    () =>
      buildCabinetColumns({
        include: [
          "name",
          "site",
          "location",
          "role",
          "type",
          "status",
          "size",
          "plate",
        ],
        omit: omitKey ? (omitKey.split(",") as CabinetColumnId[]) : [],
      }),
    [omitKey]
  )
  return (
    <Frame
      q={q}
      emptyText={emptyText}
      columns={columns}
      flexColumn="name"
      tableId="embedded-cabinets"
      search={searchable ? "Search cabinets…" : undefined}
    />
  )
}

/** Circuits scoped by provider / provider-network / site. Reuses the one
 * circuit column factory - the same row the /circuits list draws. `omitProvider`
 * drops the redundant Provider column on a provider's own detail page. */
export function EmbeddedCircuitTable({
  filter,
  omitProvider = false,
  emptyText = "No circuits.",
  searchable = true,
}: {
  filter: Record<string, string>
  omitProvider?: boolean
  emptyText?: string
  /** The search box above the rows; off for a list that stays short. */
  searchable?: boolean
}) {
  const q = useEmbed<Circuit>("embedded-circuits", "/api/circuits/", filter)
  // A provider page is where a carrier is held to its promise: each
  // circuit's SLA figure and plain availability sit beside it.
  const ids = useMemo(() => (q.data?.results ?? []).map((r) => r.id), [q.data])
  const sla = useSlaStatus("circuit", ids)
  const columns = useMemo<ColumnDef<Circuit>[]>(() => {
    const include: CircuitColumnId[] = [
      "cid",
      "provider",
      "type",
      "status",
      "endpoints",
      "commit",
      "sla",
      "availability",
      "description",
    ]
    return buildCircuitColumns({
      include: omitProvider
        ? include.filter((id) => id !== "provider")
        : include,
      sla: { entries: sla.entries, frame: sla.frame },
    })
  }, [omitProvider, sla.entries, sla.frame])
  return (
    <Frame
      q={q}
      emptyText={emptyText}
      columns={columns}
      flexColumn="description"
      tableId="embedded-circuits"
      search={searchable ? "Search circuits…" : undefined}
    />
  )
}

/** Power feeds scoped by panel / rack / status. Reuses the one power-feed
 * column factory - the same row the /power-feeds list draws. `omitPanel` and
 * `omitRack` drop the column that repeats the page's own object. The rows
 * can be selected for the list's bulk edit and delete. */
export function EmbeddedPowerFeedTable({
  filter,
  omitPanel = false,
  omitRack = false,
  emptyText = "No power feeds.",
  searchable = true,
}: {
  filter: Record<string, string>
  omitPanel?: boolean
  omitRack?: boolean
  emptyText?: string
  /** The search box above the rows; off for a list that stays short. */
  searchable?: boolean
}) {
  const q = useEmbed<PowerFeed>(
    "embedded-power-feeds",
    "/api/power-feeds/",
    filter
  )
  const { canDo } = useMe()
  const canEdit = canDo("powerfeed", "change")
  const canDelete = canDo("powerfeed", "delete")
  const [selected, setSelected] = useState<PowerFeed[]>([])
  const columns = useMemo<ColumnDef<PowerFeed>[]>(() => {
    const include: PowerFeedColumnId[] = [
      "name",
      "panel",
      "rack",
      "status",
      "type",
      "supply",
      "phase",
      "power",
      "max",
    ]
    return buildPowerFeedColumns({
      include: include.filter(
        (id) => !(omitPanel && id === "panel") && !(omitRack && id === "rack")
      ),
      selection: canEdit || canDelete,
    })
  }, [omitPanel, omitRack, canEdit, canDelete])
  return (
    <>
      <Frame
        q={q}
        emptyText={emptyText}
        columns={columns}
        flexColumn="name"
        tableId="embedded-power-feeds"
        search={searchable ? "Search power feeds…" : undefined}
        selection={{ rows: selected, onChange: setSelected }}
      />
      <PowerFeedBulkBar
        selected={selected}
        onCleared={() => setSelected([])}
        canEdit={canEdit}
        canDelete={canDelete}
      />
    </>
  )
}

/** Tunnels scoped by group / IPSec profile / device. Reuses the one tunnel
 * column factory - the same row the /tunnels list draws. The two flags drop
 * the column that repeats the object being viewed: a tunnel group's own page
 * omits Group, an IPSec profile's own page omits IPSec profile. */
export function EmbeddedTunnelTable({
  filter,
  omitGroup = false,
  omitProfile = false,
  emptyText = "No tunnels.",
  searchable = true,
}: {
  filter: Record<string, string>
  omitGroup?: boolean
  omitProfile?: boolean
  emptyText?: string
  /** The search box above the rows; off for a list that stays short. */
  searchable?: boolean
}) {
  const q = useEmbed<Tunnel>("embedded-tunnels", "/api/tunnels/", filter)
  const columns = useMemo<ColumnDef<Tunnel>[]>(() => {
    const include: TunnelColumnId[] = [
      "name",
      "status",
      "encapsulation",
      "group",
      "profile",
      "tunnel_id",
      "description",
    ]
    const omit: TunnelColumnId[] = []
    if (omitGroup) omit.push("group")
    if (omitProfile) omit.push("profile")
    return buildTunnelColumns({ include, omit })
  }, [omitGroup, omitProfile])
  return (
    <Frame
      q={q}
      emptyText={emptyText}
      columns={columns}
      flexColumn="description"
      tableId="embedded-tunnels"
      search={searchable ? "Search tunnels…" : undefined}
    />
  )
}

/** Wireless LANs scoped by group / status / VLAN. Reuses the one wireless-LAN
 * column factory - the same row the /wireless-lans list draws. `omitGroup`
 * drops the redundant Group column on a group's own detail page. */
export function EmbeddedWirelessLANTable({
  filter,
  omitGroup = false,
  emptyText = "No wireless LANs.",
  searchable = true,
}: {
  filter: Record<string, string>
  omitGroup?: boolean
  emptyText?: string
  /** The search box above the rows; off for a list that stays short. */
  searchable?: boolean
}) {
  const q = useEmbed<WirelessLAN>(
    "embedded-wireless-lans",
    "/api/wireless-lans/",
    filter
  )
  const columns = useMemo<ColumnDef<WirelessLAN>[]>(() => {
    const include: WirelessLANColumnId[] = [
      "ssid",
      "group",
      "status",
      "vlan",
      "auth",
      "description",
    ]
    return buildWirelessLANColumns({
      include: omitGroup ? include.filter((id) => id !== "group") : include,
    })
  }, [omitGroup])
  return (
    <Frame
      q={q}
      emptyText={emptyText}
      columns={columns}
      flexColumn="description"
      tableId="embedded-wireless-lans"
      search={searchable ? "Search wireless LANs…" : undefined}
    />
  )
}

/** Cables scoped by device / power feed. Reuses the one cable column factory,
 * so a cable row reads the same here as on /cables. */
export function EmbeddedCableTable({
  filter,
  emptyText = "No cables.",
  searchable = true,
}: {
  filter: Record<string, string>
  emptyText?: string
  /** The search box above the rows; off for a list that stays short. */
  searchable?: boolean
}) {
  const q = useEmbed<Cable>("embedded-cables", "/api/cables/", filter)
  const columns = useMemo<ColumnDef<Cable>[]>(
    () =>
      buildCableColumns({
        include: ["label", "a", "link", "b", "type", "status", "description"],
      }),
    []
  )
  return (
    <Frame
      q={q}
      emptyText={emptyText}
      columns={columns}
      flexColumn="description"
      tableId="embedded-cables"
      search={searchable ? "Search cables…" : undefined}
    />
  )
}

/** Clusters scoped by type / group / site. */
export function EmbeddedClusterTable({
  filter,
  emptyText = "No clusters.",
  searchable = true,
}: {
  filter: Record<string, string>
  emptyText?: string
  /** The search box above the rows; off for a list that stays short. */
  searchable?: boolean
}) {
  const q = useEmbed<Cluster>("embedded-clusters", "/api/clusters/", filter)
  const columns = useMemo<ColumnDef<Cluster>[]>(
    () =>
      buildClusterColumns({
        include: ["name", "type", "site", "vms"],
        typeVariant: "badge",
        siteVariant: "plain",
        zeroCounts: "number",
      }),
    []
  )
  return (
    <Frame
      q={q}
      emptyText={emptyText}
      columns={columns}
      flexColumn="name"
      tableId="embedded-clusters"
      search={searchable ? "Search clusters…" : undefined}
    />
  )
}

/** VMs scoped by any filter the VM list accepts - the Virtual machines tab
 * on a VM group's page. */
export function EmbeddedVmTable({
  filter,
  emptyText = "No virtual machines.",
  searchable = true,
}: {
  filter: Record<string, string>
  emptyText?: string
  /** The search box above the rows; off for a list that stays short. */
  searchable?: boolean
}) {
  const { humanIds } = useMe()
  const q = useEmbed<VirtualMachine>(
    "embedded-vms",
    "/api/virtual-machines/",
    filter
  )
  const columns = useMemo<ColumnDef<VirtualMachine>[]>(
    () =>
      buildVmColumns({
        humanIds,
        include: [
          "numid",
          "name",
          "status",
          "power",
          "vcpus",
          "memory",
          "primary_ip",
          "platform",
        ],
      }),
    [humanIds]
  )
  return (
    <Frame
      q={q}
      emptyText={emptyText}
      columns={columns}
      flexColumn="primary_ip"
      tableId="embedded-vms"
      search={searchable ? "Search virtual machines…" : undefined}
    />
  )
}

/** VM groups scoped by cluster - the Groups tab on a cluster's page. */
export function EmbeddedVmGroupTable({
  filter,
  emptyText = "No VM groups.",
  searchable = true,
}: {
  filter: Record<string, string>
  emptyText?: string
  /** The search box above the rows; off for a list that stays short. */
  searchable?: boolean
}) {
  const q = useEmbed<VirtualMachineGroup>(
    "embedded-vm-groups",
    "/api/vm-groups/",
    filter
  )
  const columns = useMemo<ColumnDef<VirtualMachineGroup>[]>(
    () =>
      buildVmGroupColumns({
        include: ["name", "kind", "vms", "description"],
        zeroCounts: "number",
      }),
    []
  )
  return (
    <Frame
      q={q}
      emptyText={emptyText}
      columns={columns}
      flexColumn="description"
      tableId="embedded-vm-groups"
      search={searchable ? "Search VM groups…" : undefined}
    />
  )
}

/** Contact groups scoped by parent - the Child groups pane on a group's own
 * detail page. `parent` is a single hop down, not the whole subtree: each row
 * links to its own page, so deeper nesting is walked one level at a time. */
export function EmbeddedContactGroupTable({
  filter,
  emptyText = "No child groups.",
  searchable = true,
}: {
  filter: Record<string, string>
  emptyText?: string
  /** The search box above the rows; off for a list that stays short. */
  searchable?: boolean
}) {
  const q = useEmbed<ContactGroup>(
    "embedded-contact-groups",
    "/api/contact-groups/",
    filter
  )
  const columns = useMemo<ColumnDef<ContactGroup>[]>(
    () =>
      // "parent" would repeat the page you're already on.
      buildContactGroupColumns({
        include: ["name", "description", "contacts", "children", "updated"],
      }),
    []
  )
  return (
    <Frame
      q={q}
      emptyText={emptyText}
      columns={columns}
      flexColumn="description"
      tableId="embedded-contact-groups"
      search={searchable ? "Search groups…" : undefined}
    />
  )
}

/** Contacts scoped by group. Reuses the one contact column factory, so a
 * contact row reads the same here as on /contacts. */
export function EmbeddedContactTable({
  filter,
  omitGroup = false,
  emptyText = "No contacts.",
  searchable = true,
}: {
  filter: Record<string, string>
  omitGroup?: boolean
  emptyText?: string
  /** The search box above the rows; off for a list that stays short. */
  searchable?: boolean
}) {
  const q = useEmbed<Contact>("embedded-contacts", "/api/contacts/", filter)
  const columns = useMemo<ColumnDef<Contact>[]>(() => {
    const include: ContactColumnId[] = [
      "name",
      "title",
      "email",
      "phone",
      "group",
      "assignments",
      "tags",
    ]
    return buildContactColumns({
      include: omitGroup ? include.filter((id) => id !== "group") : include,
    })
  }, [omitGroup])
  return (
    <Frame
      q={q}
      emptyText={emptyText}
      columns={columns}
      flexColumn="title"
      tableId="embedded-contacts"
      search={searchable ? "Search contacts…" : undefined}
    />
  )
}

/** Frame plus tick boxes and the routing selection bar (#314): bulk edit
 * and the safe bulk delete, offered when the caller may do either. */
function BulkFrame<T extends { id: string }>({
  q,
  emptyText,
  columns,
  flexColumn,
  tableId,
  objectType,
  endpoint,
  noun,
  invalidate,
  search,
}: {
  q: ReturnType<typeof useEmbed<T>>
  emptyText: string
  columns: ColumnDef<T>[]
  flexColumn: string
  tableId: string
  objectType: string
  endpoint: string
  noun: [string, string]
  invalidate: string[][]
  /** The search box's placeholder; omit for no search box. */
  search?: string
}) {
  const { canDo } = useMe()
  const canEdit = canDo(objectType, "change")
  const canDelete = canDo(objectType, "delete")
  const selectable = canEdit || canDelete
  const [selected, setSelected] = useState<T[]>([])
  const cols = useMemo(
    () => (selectable ? [selectionColumn<T>(), ...columns] : columns),
    [columns, selectable]
  )
  if (q.isError) return <QueryError error={q.error} />
  if (q.isLoading) return <Loading />
  const rows = q.data?.results ?? []
  if (rows.length === 0)
    return <p className="text-sm text-muted-foreground">{emptyText}</p>
  return (
    <>
      <DataTable
        data={rows}
        total={q.data?.count}
        columns={cols}
        flexColumn={flexColumn}
        tableId={tableId}
        onSelectedRowsChange={selectable ? setSelected : undefined}
        selectedRows={selectable ? selected : undefined}
        searchable={!!search}
        searchPlaceholder={search}
      />
      <SafeBulkEditBar
        selected={selected}
        endpoint={endpoint}
        noun={noun}
        invalidate={invalidate}
        onCleared={() => setSelected([])}
        canEdit={canEdit}
        canDelete={canDelete}
      />
    </>
  )
}

/** BGP sessions scoped by the local instance's AS, peer group or device -
 * the one session column factory, so a row reads as it does on
 * /bgp-sessions. */
export function EmbeddedBGPSessionTable({
  filter,
  omit = [],
  emptyText = "No BGP sessions.",
  searchable = true,
}: {
  filter: Record<string, string>
  omit?: BGPSessionColumnId[]
  emptyText?: string
  /** The search box above the rows; off for a list that stays short. */
  searchable?: boolean
}) {
  const q = useEmbed<BGPSession>(
    "embedded-bgp-sessions",
    "/api/routing/bgp-sessions/",
    filter
  )
  const columns = useMemo<ColumnDef<BGPSession>[]>(
    () =>
      buildBGPSessionColumns({
        include: [
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
        ],
        omit,
      }),
    [omit]
  )
  return (
    <BulkFrame
      q={q}
      emptyText={emptyText}
      columns={columns}
      flexColumn="description"
      tableId="embedded-bgp-sessions"
      search={searchable ? "Search sessions…" : undefined}
      objectType="bgpsession"
      endpoint="/api/routing/bgp-sessions/"
      noun={["BGP session", "BGP sessions"]}
      invalidate={[["embedded-bgp-sessions"], ["bgp-sessions"]]}
    />
  )
}

/** L2VPNs terminating on a VLAN (`?vlan=`), or any L2VPN filter. */
export function EmbeddedL2VPNTable({
  filter,
  omit = [],
  emptyText = "No L2VPNs.",
  searchable = true,
}: {
  filter: Record<string, string>
  omit?: L2VPNColumnId[]
  emptyText?: string
  /** The search box above the rows; off for a list that stays short. */
  searchable?: boolean
}) {
  const q = useEmbed<L2VPN>("embedded-l2vpns", "/api/l2vpns/", filter)
  const columns = useMemo<ColumnDef<L2VPN>[]>(
    () =>
      buildL2VPNColumns({
        include: [
          "name",
          "type",
          "identifier",
          "vrf",
          "status",
          "terminations",
          "vteps",
          "description",
        ],
        omit,
      }),
    [omit]
  )
  return (
    <Frame
      q={q}
      emptyText={emptyText}
      columns={columns}
      flexColumn="description"
      tableId="embedded-l2vpns"
      search={searchable ? "Search L2VPNs…" : undefined}
    />
  )
}

/** The VTEPs carrying an L2VPN (`?l2vpn=`), or any VTEP filter. */
export function EmbeddedVTEPTable({
  filter,
  omit = [],
  emptyText = "No VTEPs.",
  searchable = true,
}: {
  filter: Record<string, string>
  omit?: VTEPColumnId[]
  emptyText?: string
  /** The search box above the rows; off for a list that stays short. */
  searchable?: boolean
}) {
  const q = useEmbed<VTEP>("embedded-vteps", "/api/routing/vteps/", filter)
  const columns = useMemo<ColumnDef<VTEP>[]>(
    () =>
      buildVTEPColumns({
        include: [
          "device",
          "site",
          "source_interface",
          "source_ip",
          "vni_count",
          "status",
          "description",
        ],
        omit,
      }),
    [omit]
  )
  return (
    <Frame
      q={q}
      emptyText={emptyText}
      columns={columns}
      flexColumn="description"
      tableId="embedded-vteps"
      search={searchable ? "Search VTEPs…" : undefined}
    />
  )
}

/** Static routes by VRF (`?vrf=`), destination prefix (`?prefix_obj=`) or
 * device. */
export function EmbeddedStaticRouteTable({
  filter,
  omit = [],
  emptyText = "No static routes.",
  searchable = true,
}: {
  filter: Record<string, string>
  omit?: StaticRouteColumnId[]
  emptyText?: string
  /** The search box above the rows; off for a list that stays short. */
  searchable?: boolean
}) {
  const q = useEmbed<StaticRoute>(
    "embedded-static-routes",
    "/api/routing/static-routes/",
    filter
  )
  const columns = useMemo<ColumnDef<StaticRoute>[]>(
    () =>
      buildStaticRouteColumns({
        include: [
          "prefix",
          "device",
          "vrf",
          "next_hop",
          "kind",
          "distance",
          "status",
          "description",
        ],
        omit,
      }),
    [omit]
  )
  return (
    <BulkFrame
      q={q}
      emptyText={emptyText}
      columns={columns}
      flexColumn="description"
      tableId="embedded-static-routes"
      search={searchable ? "Search routes…" : undefined}
      objectType="staticroute"
      endpoint="/api/routing/static-routes/"
      noun={["static route", "static routes"]}
      invalidate={[["embedded-static-routes"], ["static-routes"]]}
    />
  )
}
