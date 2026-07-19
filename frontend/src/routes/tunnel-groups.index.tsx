import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type TunnelGroup, type Paginated } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader, selectionColumn } from "@/components/data-table"
import { useTableFilters } from "@/components/table-filters"
import { ListPageShell } from "@/components/list-page-shell"
import { numidColumn } from "@/components/cells/numid"
import { RowActions } from "@/components/row-actions"
import { TunnelGroupDeleteDialog } from "@/components/tunnel-group-delete-dialog"
import { TunnelGroupBulkBar } from "@/components/tunnel-group-bulk-bar"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/tunnel-groups/")({
  component: TunnelGroupsPage,
})

function TunnelGroupsPage() {
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<TunnelGroup | null>(null)
  const [selectedRows, setSelectedRows] = useState<TunnelGroup[]>([])
  const { humanIds } = useMe()

  const query = useQuery({
    queryKey: ["tunnel-groups"],
    queryFn: () => api<Paginated<TunnelGroup>>("/api/tunnel-groups/"),
  })

  const allRows = query.data?.results ?? []
  const rows = useMemo(() => {
    const n = q.trim().toLowerCase()
    if (!n) return allRows
    return allRows.filter(
      (g) =>
        g.name.toLowerCase().includes(n) ||
        g.description.toLowerCase().includes(n)
    )
  }, [allRows, q])

  const onDelete = useCallback((g: TunnelGroup) => setDeleting(g), [])
  const columns = useMemo<ColumnDef<TunnelGroup>[]>(
    () => [
      selectionColumn<TunnelGroup>(),
      ...(humanIds ? [numidColumn<TunnelGroup>({ get: (r) => r.numid })] : []),
      {
        id: "name",
        accessorKey: "name",
        header: ({ column }) => <SortHeader column={column} label="Name" />,
        cell: ({ row }) => (
          <Link
            to="/tunnel-groups/$id/edit"
            params={{ id: row.original.id }}
            className="font-medium hover:underline"
          >
            {row.original.name}
          </Link>
        ),
      },
      {
        id: "description",
        accessorKey: "description",
        header: "Description",
        cell: ({ row }) => (
          <span className="line-clamp-1 block text-muted-foreground">
            {row.original.description || "—"}
          </span>
        ),
      },
      {
        id: "tunnels",
        accessorKey: "tunnel_count",
        header: ({ column }) => <SortHeader column={column} label="Tunnels" />,
        cell: ({ row }) => (
          <span className="num text-xs">{row.original.tunnel_count}</span>
        ),
        meta: {
          facet: {
            kind: "enum",
            label: "Tunnels",
            get: (r: TunnelGroup) => (r.tunnel_count > 0 ? "in" : "out"),
            formatValue: (v) => ({
              label: v === "in" ? "Has tunnels" : "No tunnels",
            }),
          },
        },
      },
      {
        id: "actions",
        enableHiding: false,
        cell: ({ row }) => (
          <RowActions
            editTo="/tunnel-groups/$id/edit"
            editParams={{ id: row.original.id }}
            onDelete={() => onDelete(row.original)}
          />
        ),
      },
    ],
    [onDelete, humanIds]
  )

  const { rail, filteredRows } = useTableFilters(columns, rows)

  return (
    <ListPageShell
      title="Tunnel groups"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      search={{ value: q, onChange: setQ, placeholder: "Filter groups…" }}
      actions={
        <>
          <TableActions ioType="tunnelgroup" />
          <Button size="sm" asChild>
            <Link to="/tunnel-groups/new">Add group</Link>
          </Button>
        </>
      }
      query={query}
    >
      <DataTable
        data={filteredRows}
        columns={columns}
        onSelectedRowsChange={setSelectedRows}
        flexColumn="description"
        tableId="tunnel-groups"
      />
      <TunnelGroupDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
      <TunnelGroupBulkBar
        selected={selectedRows}
        onCleared={() => setSelectedRows([])}
      />
    </ListPageShell>
  )
}
