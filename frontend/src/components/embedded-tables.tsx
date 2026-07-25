import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"

import {
  api,
  type Cluster,
  type IPAddress,
  type Paginated,
  type Rack,
} from "@/lib/api"
import { DataTable } from "@/components/data-table"
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
