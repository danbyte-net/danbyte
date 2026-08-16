import { useMemo, useState } from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"

import { api, type DhcpReservation, type Paginated } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { DataTable, SortHeader } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { ListPageShell } from "@/components/list-page-shell"
import { dash } from "@/components/kv-card"

export const Route = createFileRoute("/dhcp-reservations/")({
  component: DhcpReservationsPage,
})

function DhcpReservationsPage() {
  const [q, setQ] = useState("")
  const query = useQuery({
    queryKey: ["dhcp-reservations", "all", q],
    queryFn: () =>
      api<Paginated<DhcpReservation>>(
        `/api/dhcp-reservations/?${new URLSearchParams({ search: q })}&page_size=500`
      ),
  })
  const rows = query.data?.results ?? []

  const columns = useMemo<ColumnDef<DhcpReservation>[]>(
    () => [
      {
        id: "ip",
        accessorKey: "ip",
        header: ({ column }) => <SortHeader column={column} label="IP" />,
        cell: ({ row }) =>
          row.original.ip_address ? (
            <Link
              to="/ips/$id"
              params={{ id: row.original.ip_address }}
              className="font-mono text-xs hover:underline"
            >
              {row.original.ip}
            </Link>
          ) : (
            <span className="font-mono text-xs">{row.original.ip}</span>
          ),
      },
      {
        id: "mac",
        accessorKey: "mac",
        header: "MAC",
        cell: ({ row }) => (
          <span className="font-mono text-[11px] text-muted-foreground">
            {row.original.mac}
          </span>
        ),
      },
      {
        id: "name",
        accessorKey: "name",
        header: "Name",
        cell: ({ row }) => row.original.name || dash,
      },
      {
        id: "scope",
        accessorKey: "scope_display",
        header: "Scope",
        cell: ({ row }) => (
          <span className="font-mono text-[11px] text-muted-foreground">
            {row.original.scope_display}
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
        id: "origin",
        header: "Origin",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.managed ? (
            <Badge variant="outline" className="text-[10px]">
              Danbyte
            </Badge>
          ) : (
            <span className="text-xs text-muted-foreground">server</span>
          ),
      },
      {
        id: "drift",
        header: "Drift",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.drift ? (
            <Badge variant="destructive" className="text-[10px]">
              {row.original.drift === "missing" ? "missing" : "modified"}
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
      title="DHCP reservations"
      count={query.data ? rows.length : undefined}
      query={query}
      search={{ value: q, onChange: setQ, placeholder: "IP, MAC or name…" }}
    >
      {rows.length === 0 && query.data && !q ? (
        <EmptyState title="No DHCP reservations synced.">
          Reservations from your Windows DHCP servers — and any you create on a
          server's page — appear here.
        </EmptyState>
      ) : (
        <DataTable
          data={rows}
          columns={columns}
          tableId="dhcp-reservations-all"
        />
      )}
    </ListPageShell>
  )
}
