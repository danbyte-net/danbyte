import { useMemo, useState } from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"

import { api, type DhcpLease, type Paginated } from "@/lib/api"
import { DataTable, SortHeader } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { ListPageShell } from "@/components/list-page-shell"
import { TimeCell } from "@/components/cells/time-ago"
import { dash } from "@/components/kv-card"
import { useFacetRail } from "@/lib/use-facet-rail"

export const Route = createFileRoute("/dhcp-leases/")({
  component: DhcpLeasesPage,
})

function DhcpLeasesPage() {
  const [q, setQ] = useState("")
  const query = useQuery({
    queryKey: ["dhcp-leases", "all", q],
    queryFn: () =>
      api<Paginated<DhcpLease>>(
        `/api/dhcp-leases/?${new URLSearchParams({ search: q })}&page_size=500`
      ),
  })
  const rows = query.data?.results ?? []

  const columns = useMemo<ColumnDef<DhcpLease>[]>(
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
              className="link font-mono text-xs"
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
        header: ({ column }) => <SortHeader column={column} label="MAC" />,
        cell: ({ row }) =>
          row.original.mac ? (
            <Link
              to="/macs/$mac"
              params={{ mac: row.original.mac }}
              className="link font-mono text-[11px]"
            >
              {row.original.mac}
            </Link>
          ) : (
            <span className="font-mono text-[11px] text-muted-foreground">
              —
            </span>
          ),
      },
      {
        id: "hostname",
        accessorKey: "hostname",
        header: ({ column }) => <SortHeader column={column} label="Hostname" />,
        cell: ({ row }) => row.original.hostname || dash,
      },
      {
        id: "scope",
        accessorKey: "scope_display",
        header: ({ column }) => <SortHeader column={column} label="Scope" />,
        cell: ({ row }) => (
          <span className="font-mono text-[11px] text-muted-foreground">
            {row.original.scope_display}
          </span>
        ),
      },
      {
        id: "state",
        accessorKey: "address_state",
        header: ({ column }) => <SortHeader column={column} label="State" />,
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">
            {row.original.address_state || "—"}
          </span>
        ),
      },
      {
        id: "expires",
        header: "Expires",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.expires_at ? (
            <TimeCell iso={row.original.expires_at} />
          ) : (
            dash
          ),
      },
    ],
    []
  )

  const { rail, filtered } = useFacetRail(rows, [
    {
      key: "scope",
      label: "Scope",
      get: (r) => ({ value: r.scope_display, label: r.scope_display }),
    },
    {
      key: "state",
      label: "State",
      get: (r) =>
        r.address_state
          ? { value: r.address_state, label: r.address_state }
          : null,
    },
  ])

  return (
    <ListPageShell
      title="DHCP leases"
      count={query.data ? filtered.length : undefined}
      query={query}
      rail={rail}
      search={{ value: q, onChange: setQ, placeholder: "IP, MAC or hostname…" }}
    >
      {rows.length === 0 && query.data && !q ? (
        <EmptyState title="No leases synced.">
          Lease sync is opt-in per scope — turn it on for a scope on its Windows
          server's page, and its active leases appear here.
        </EmptyState>
      ) : (
        <DataTable
          data={filtered}
          columns={columns}
          tableId="dhcp-leases-all"
        />
      )}
    </ListPageShell>
  )
}
