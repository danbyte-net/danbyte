import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"

import { api } from "@/lib/api"
import type {
  Cable,
  Circuit,
  Cluster,
  IPAddress,
  Paginated,
  PowerFeed,
  Rack,
} from "@/lib/api"
import { DataTable } from "@/components/data-table"
import { buildCableColumns } from "@/components/columns/cable-columns"
import { buildCircuitColumns } from "@/components/columns/circuit-columns"
import type { CircuitColumnId } from "@/components/columns/circuit-columns"
import { buildClusterColumns } from "@/components/columns/cluster-columns"
import { buildIpColumns } from "@/components/columns/ip-columns"
import { buildPowerFeedColumns } from "@/components/columns/power-feed-columns"
import type { PowerFeedColumnId } from "@/components/columns/power-feed-columns"
import { buildRackColumns } from "@/components/columns/rack-columns"
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
        include: ["ip", "status", "dns", "assigned"],
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
 * circuit column factory — the same row the /circuits list draws. `omitProvider`
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
 * column factory — the same row the /power-feeds list draws. `omitPanel` drops
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
