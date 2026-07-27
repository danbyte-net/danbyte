import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"

import {
  api,
  type Circuit,
  type Cluster,
  type IPAddress,
  type Paginated,
  type Rack,
} from "@/lib/api"
import { DataTable } from "@/components/data-table"
import { buildCircuitColumns } from "@/components/columns/circuit-columns"
import type { CircuitColumnId } from "@/components/columns/circuit-columns"
import { buildClusterColumns } from "@/components/columns/cluster-columns"
import { buildIpColumns } from "@/components/columns/ip-columns"
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
