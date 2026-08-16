import { useMemo, useState } from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"

import { api, type DnsZone, type Paginated } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { DataTable, SortHeader } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { ListPageShell } from "@/components/list-page-shell"

export const Route = createFileRoute("/dns-zones/")({
  component: DnsZonesPage,
})

function DnsZonesPage() {
  const [q, setQ] = useState("")
  const query = useQuery({
    queryKey: ["dns-zones", "all", q],
    queryFn: () =>
      api<Paginated<DnsZone>>(
        `/api/dns-zones/?${new URLSearchParams({ search: q })}&page_size=500`
      ),
  })
  const rows = query.data?.results ?? []

  const columns = useMemo<ColumnDef<DnsZone>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: ({ column }) => <SortHeader column={column} label="Zone" />,
        cell: ({ row }) => (
          <Link
            to="/dns-zones/$id"
            params={{ id: row.original.id }}
            className="font-mono text-xs font-medium hover:underline"
          >
            {row.original.name}
          </Link>
        ),
      },
      {
        id: "type",
        accessorKey: "zone_type",
        header: "Type",
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">
            {row.original.zone_type}
            {row.original.is_reverse ? " · reverse" : ""}
          </span>
        ),
      },
      {
        id: "server",
        accessorKey: "connection_name",
        header: "Server",
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">
            {row.original.connection_name}
          </span>
        ),
      },
      {
        id: "records",
        accessorKey: "record_count",
        header: ({ column }) => <SortHeader column={column} label="Records" />,
        cell: ({ row }) => (
          <span className="num">
            {row.original.sync ? row.original.record_count : "—"}
          </span>
        ),
      },
      {
        id: "reconcile",
        header: "Reconcile",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.sync ? (
            <Badge variant="success" className="text-[10px]">
              on
            </Badge>
          ) : (
            <span className="text-xs text-muted-foreground">off</span>
          ),
      },
      {
        id: "drift",
        header: "Drift",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.drift_count > 0 ? (
            <Badge variant="destructive" className="text-[10px]">
              {row.original.drift_count}
            </Badge>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          ),
      },
    ],
    []
  )

  return (
    <ListPageShell
      title="DNS zones"
      count={query.data ? rows.length : undefined}
      query={query}
      search={{ value: q, onChange: setQ, placeholder: "Filter zones…" }}
    >
      {rows.length === 0 && query.data && !q ? (
        <EmptyState title="No DNS zones synced.">
          Connect a Windows DNS server under Integrations → Windows servers and
          its zones appear here. Turn on reconcile for a zone to store its
          records.
        </EmptyState>
      ) : (
        <DataTable
          data={rows}
          columns={columns}
          tableId="dns-zones-all"
          flexColumn="name"
        />
      )}
    </ListPageShell>
  )
}
