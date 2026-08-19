import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"

import { api } from "@/lib/api"
import type {
  Cable,
  Circuit,
  Cluster,
  Contact,
  ContactGroup,
  IPAddress,
  Paginated,
  PowerFeed,
  Rack,
  Tunnel,
  WirelessLAN,
} from "@/lib/api"
import { DataTable } from "@/components/data-table"
import { buildCableColumns } from "@/components/columns/cable-columns"
import { buildCircuitColumns } from "@/components/columns/circuit-columns"
import type { CircuitColumnId } from "@/components/columns/circuit-columns"
import { buildClusterColumns } from "@/components/columns/cluster-columns"
import { buildContactColumns } from "@/components/columns/contact-columns"
import type { ContactColumnId } from "@/components/columns/contact-columns"
import { buildContactGroupColumns } from "@/components/columns/contact-group-columns"
import { buildIpColumns } from "@/components/columns/ip-columns"
import { buildPowerFeedColumns } from "@/components/columns/power-feed-columns"
import type { PowerFeedColumnId } from "@/components/columns/power-feed-columns"
import { buildRackColumns } from "@/components/columns/rack-columns"
import { buildTunnelColumns } from "@/components/columns/tunnel-columns"
import type { TunnelColumnId } from "@/components/columns/tunnel-columns"
import { buildWirelessLANColumns } from "@/components/columns/wireless-lan-columns"
import type { WirelessLANColumnId } from "@/components/columns/wireless-lan-columns"
import { QueryError } from "@/components/query-error"

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
}: {
  q: ReturnType<typeof useEmbed<T>>
  emptyText: string
  columns: ColumnDef<T>[]
  flexColumn: string
  tableId: string
}) {
  if (q.isError) return <QueryError error={q.error} />
  if (q.isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>
  const rows = q.data?.results ?? []
  if (rows.length === 0)
    return <p className="text-sm text-muted-foreground">{emptyText}</p>
  return (
    <DataTable
      data={rows}
      columns={columns}
      flexColumn={flexColumn}
      tableId={tableId}
    />
  )
}

/** IP addresses scoped by role / status / vrf / prefix / site. */
export function EmbeddedIpTable({
  filter,
  emptyText = "No IP addresses.",
}: {
  filter: Record<string, string>
  emptyText?: string
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
    />
  )
}

/** Racks scoped by location / role / site. */
export function EmbeddedRackTable({
  filter,
  emptyText = "No racks.",
}: {
  filter: Record<string, string>
  emptyText?: string
}) {
  const q = useEmbed<Rack>("embedded-racks", "/api/racks/", filter)
  const columns = useMemo<ColumnDef<Rack>[]>(
    () =>
      buildRackColumns({
        include: ["name", "site", "width", "used"],
        siteVariant: "plain",
      }),
    []
  )
  return (
    <Frame
      q={q}
      emptyText={emptyText}
      columns={columns}
      flexColumn="name"
      tableId="embedded-racks"
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
}: {
  filter: Record<string, string>
  omitProvider?: boolean
  emptyText?: string
}) {
  const q = useEmbed<Circuit>("embedded-circuits", "/api/circuits/", filter)
  const columns = useMemo<ColumnDef<Circuit>[]>(() => {
    const include: CircuitColumnId[] = [
      "cid",
      "provider",
      "type",
      "status",
      "endpoints",
      "commit",
      "description",
    ]
    return buildCircuitColumns({
      include: omitProvider
        ? include.filter((id) => id !== "provider")
        : include,
    })
  }, [omitProvider])
  return (
    <Frame
      q={q}
      emptyText={emptyText}
      columns={columns}
      flexColumn="description"
      tableId="embedded-circuits"
    />
  )
}

/** Power feeds scoped by panel / rack / status. Reuses the one power-feed
 * column factory - the same row the /power-feeds list draws. `omitPanel` drops
 * the redundant Panel column on a panel's own detail page. */
export function EmbeddedPowerFeedTable({
  filter,
  omitPanel = false,
  emptyText = "No power feeds.",
}: {
  filter: Record<string, string>
  omitPanel?: boolean
  emptyText?: string
}) {
  const q = useEmbed<PowerFeed>(
    "embedded-power-feeds",
    "/api/power-feeds/",
    filter
  )
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
      include: omitPanel ? include.filter((id) => id !== "panel") : include,
    })
  }, [omitPanel])
  return (
    <Frame
      q={q}
      emptyText={emptyText}
      columns={columns}
      flexColumn="name"
      tableId="embedded-power-feeds"
    />
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
}: {
  filter: Record<string, string>
  omitGroup?: boolean
  omitProfile?: boolean
  emptyText?: string
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
}: {
  filter: Record<string, string>
  omitGroup?: boolean
  emptyText?: string
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
    />
  )
}

/** Cables scoped by device / power feed. Reuses the one cable column factory,
 * so a cable row reads the same here as on /cables. */
export function EmbeddedCableTable({
  filter,
  emptyText = "No cables.",
}: {
  filter: Record<string, string>
  emptyText?: string
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
    />
  )
}

/** Clusters scoped by type / group / site. */
export function EmbeddedClusterTable({
  filter,
  emptyText = "No clusters.",
}: {
  filter: Record<string, string>
  emptyText?: string
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
    />
  )
}

/** Contact groups scoped by parent - the Child groups pane on a group's own
 * detail page. `parent` is a single hop down, not the whole subtree: each row
 * links to its own page, so deeper nesting is walked one level at a time. */
export function EmbeddedContactGroupTable({
  filter,
  emptyText = "No child groups.",
}: {
  filter: Record<string, string>
  emptyText?: string
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
    />
  )
}

/** Contacts scoped by group. Reuses the one contact column factory, so a
 * contact row reads the same here as on /contacts. */
export function EmbeddedContactTable({
  filter,
  omitGroup = false,
  emptyText = "No contacts.",
}: {
  filter: Record<string, string>
  omitGroup?: boolean
  emptyText?: string
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
    />
  )
}
