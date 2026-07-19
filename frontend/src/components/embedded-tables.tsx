import { useMemo } from "react"
import { dash } from "@/components/cells/dash"
import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"

import {
  api,
  type Cluster,
  type IPAddress,
  type Paginated,
  type Rack,
} from "@/lib/api"
import { DataTable, SortHeader } from "@/components/data-table"
import { buildIpColumns } from "@/components/columns/ip-columns"
import { ColorBadge } from "@/components/cells/color-badge"
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
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: ({ column }) => <SortHeader column={column} label="Name" />,
        cell: ({ row }) => (
          <Link
            to="/racks/$id"
            params={{ id: row.original.id }}
            className="font-medium hover:underline"
          >
            {row.original.name}
          </Link>
        ),
      },
      {
        id: "site",
        accessorFn: (r) => r.site.name,
        header: "Site",
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">
            {row.original.site.name}
          </span>
        ),
      },
      {
        id: "width",
        header: "Width",
        cell: ({ row }) => (
          <span className="num text-xs">{row.original.width}″</span>
        ),
      },
      {
        id: "used",
        header: ({ column }) => <SortHeader column={column} label="Used" />,
        accessorFn: (r) => r.used_units,
        cell: ({ row }) => (
          <span className="num text-xs">
            {row.original.used_units} / {row.original.u_height} U
          </span>
        ),
      },
    ],
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
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: ({ column }) => <SortHeader column={column} label="Name" />,
        cell: ({ row }) => (
          <Link
            to="/clusters/$id"
            params={{ id: row.original.id }}
            className="font-medium hover:underline"
          >
            {row.original.name}
          </Link>
        ),
      },
      {
        id: "type",
        accessorFn: (r) => r.type.name,
        header: "Type",
        cell: ({ row }) => (
          <ColorBadge name={row.original.type.name} color={undefined} />
        ),
      },
      {
        id: "site",
        accessorFn: (r) => r.site?.name ?? "",
        header: "Site",
        cell: ({ row }) =>
          row.original.site ? (
            <span className="text-xs text-muted-foreground">
              {row.original.site.name}
            </span>
          ) : (
            dash
          ),
      },
      {
        id: "vms",
        accessorKey: "vm_count",
        header: ({ column }) => <SortHeader column={column} label="VMs" />,
        cell: ({ row }) => (
          <span className="num text-xs">{row.original.vm_count}</span>
        ),
      },
    ],
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
