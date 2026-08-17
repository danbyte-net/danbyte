import { useMemo, useState } from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"

import { api, type DhcpReservation, type Paginated } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { ListPageShell } from "@/components/list-page-shell"
import { dash } from "@/components/kv-card"
import { useFacetRail } from "@/lib/use-facet-rail"

export const Route = createFileRoute("/dhcp-reservations/")({
  validateSearch: (s: Record<string, unknown>) => ({
    scope: typeof s.scope === "string" ? s.scope : undefined,
  }),
  component: DhcpReservationsPage,
})

const DRIFT_LABEL: Record<string, string> = {
  modified: "Modified on server",
  missing: "Missing on server",
}

function DhcpReservationsPage() {
  const { scope } = Route.useSearch()
  const [q, setQ] = useState("")
  const query = useQuery({
    queryKey: ["dhcp-reservations", "all", q, scope ?? ""],
    queryFn: () => {
      const p = new URLSearchParams({ search: q })
      if (scope) p.set("scope", scope)
      return api<Paginated<DhcpReservation>>(
        `/api/dhcp-reservations/?${p}&page_size=500`
      )
    },
  })
  const rows = query.data?.results ?? []
  const scopeLabel = scope ? rows[0]?.scope_display : undefined

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
        cell: ({ row }) => (
          <span className="font-mono text-[11px] text-muted-foreground">
            {row.original.mac}
          </span>
        ),
      },
      {
        id: "name",
        accessorKey: "name",
        header: ({ column }) => <SortHeader column={column} label="Name" />,
        cell: ({ row }) => row.original.name || dash,
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
        id: "server",
        accessorKey: "connection_name",
        header: ({ column }) => <SortHeader column={column} label="Server" />,
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

  const { rail, filtered } = useFacetRail(rows, [
    {
      key: "server",
      label: "Server",
      get: (r) => ({ value: r.connection_name, label: r.connection_name }),
    },
    {
      key: "origin",
      label: "Origin",
      get: (r) => ({
        value: r.managed ? "danbyte" : "server",
        label: r.managed ? "Danbyte" : "Server",
      }),
    },
    {
      key: "drift",
      label: "Drift",
      get: (r) => ({
        value: r.drift || "ok",
        label: r.drift ? DRIFT_LABEL[r.drift] : "In sync",
      }),
    },
  ])

  return (
    <ListPageShell
      title="DHCP reservations"
      count={query.data ? filtered.length : undefined}
      query={query}
      rail={rail}
      search={{ value: q, onChange: setQ, placeholder: "IP, MAC or name…" }}
    >
      {scope && (
        <div className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="secondary">Scope {scopeLabel || scope}</Badge>
          <Button variant="ghost" size="sm" className="h-6 px-2" asChild>
            <Link to="/dhcp-reservations" search={{ scope: undefined }}>
              Clear
            </Link>
          </Button>
        </div>
      )}
      {rows.length === 0 && query.data && !q && !scope ? (
        <EmptyState title="No DHCP reservations synced.">
          Reservations from your Windows DHCP servers — and any you create on a
          server's page — appear here.
        </EmptyState>
      ) : (
        <DataTable
          data={filtered}
          columns={columns}
          tableId="dhcp-reservations-all"
        />
      )}
    </ListPageShell>
  )
}
