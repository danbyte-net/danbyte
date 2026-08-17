import { createFileRoute, Link } from "@tanstack/react-router"
import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"

import { api, type Paginated, type VirtualSwitch } from "@/lib/api"
import { DataTable, SortHeader } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { EmptyState } from "@/components/empty-state"
import { Badge } from "@/components/ui/badge"

export const Route = createFileRoute("/virtual-switches/")({
  component: VirtualSwitchesPage,
})

function VirtualSwitchesPage() {
  const [q, setQ] = useState("")
  const query = useQuery({
    queryKey: ["virtual-switches", q],
    queryFn: () =>
      api<Paginated<VirtualSwitch>>(
        `/api/virtual-switches/?${new URLSearchParams({ search: q })}`
      ),
  })
  const rows = query.data?.results ?? []

  const columns = useMemo<ColumnDef<VirtualSwitch>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: ({ column }) => <SortHeader column={column} label="Name" />,
        cell: ({ row }) => (
          <span className="font-medium">{row.original.name}</span>
        ),
      },
      {
        id: "kind",
        accessorKey: "kind_display",
        header: "Kind",
        cell: ({ row }) =>
          row.original.kind_display ? (
            <Badge variant="outline" className="text-[10px]">
              {row.original.kind_display}
            </Badge>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "cluster",
        header: "Cluster",
        cell: ({ row }) =>
          row.original.cluster ? (
            <Link
              to="/clusters/$id"
              params={{ id: row.original.cluster.id }}
              className="link text-xs"
            >
              {row.original.cluster.name}
            </Link>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "uplinks",
        accessorKey: "uplinks",
        header: "Uplinks",
        cell: ({ row }) => (
          <span className="font-mono text-xs">
            {row.original.uplinks || "—"}
          </span>
        ),
      },
      {
        id: "mtu",
        accessorKey: "mtu",
        header: "MTU",
        cell: ({ row }) =>
          row.original.mtu != null ? (
            <span className="num text-xs">{row.original.mtu}</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
    ],
    []
  )

  return (
    <ListPageShell
      title="Virtual switches"
      count={query.data ? rows.length : undefined}
      query={query}
      search={{ value: q, onChange: setQ, placeholder: "Filter switches…" }}
    >
      {rows.length === 0 && query.data && !q ? (
        <EmptyState title="No virtual switches.">
          Virtual switches appear here once a virtualization source with{" "}
          <span className="font-medium">
            Sync virtual switches &amp; networks
          </span>{" "}
          enabled has run — the bridges / vSwitches its VMs use are imported
          automatically.
        </EmptyState>
      ) : (
        <DataTable
          data={rows}
          columns={columns}
          tableId="virtual-switches"
          flexColumn="name"
        />
      )}
    </ListPageShell>
  )
}
