import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type Paginated, type RackRole } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader, selectionColumn } from "@/components/data-table"
import { useTableFilters } from "@/components/table-filters"
import { ListPageShell } from "@/components/list-page-shell"
import { ColorBadge } from "@/components/cells/color-badge"
import { numidColumn } from "@/components/cells/numid"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { RackRoleDeleteDialog } from "@/components/rack-role-delete-dialog"
import { RowActions } from "@/components/row-actions"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/rack-roles/")({
  component: RackRolesPage,
})

function RackRolesPage() {
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<RackRole | null>(null)
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("rackrole", "add")
  const canEdit = canDo("rackrole", "change")
  const canDelete = canDo("rackrole", "delete")

  const query = useQuery({
    queryKey: ["rack-roles", q],
    queryFn: () =>
      api<Paginated<RackRole>>(
        `/api/rack-roles/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })
  const rows = query.data?.results ?? []

  const handleDelete = useCallback((r: RackRole) => setDeleting(r), [])
  const columns = useMemo<ColumnDef<RackRole>[]>(
    () =>
      buildColumns({ onDelete: handleDelete, canEdit, canDelete, humanIds }),
    [handleDelete, canEdit, canDelete, humanIds]
  )
  const { rail, filteredRows } = useTableFilters(columns, rows)

  return (
    <ListPageShell
      title="Rack roles"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      search={{ value: q, onChange: setQ, placeholder: "Filter…" }}
      actions={
        <>
          <TableActions ioType="rackrole" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/rack-roles/new">Add role</Link>
            </Button>
          )}
        </>
      }
      query={query}
    >
      <DataTable
        data={filteredRows}
        columns={columns}
        flexColumn="description"
        tableId="rack-roles"
      />
      <RackRoleDeleteDialog
        role={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}

function buildColumns({
  onDelete,
  canEdit,
  canDelete,
  humanIds,
}: {
  onDelete: (r: RackRole) => void
  canEdit: boolean
  canDelete: boolean
  humanIds: boolean
}): ColumnDef<RackRole>[] {
  return [
    selectionColumn<RackRole>(),
    ...(humanIds ? [numidColumn<RackRole>({ get: (r) => r.numid })] : []),
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <Link
          to="/rack-roles/$id"
          params={{ id: row.original.id }}
          className="hover:opacity-90"
        >
          <ColorBadge
            name={row.original.name}
            color={row.original.color || undefined}
          />
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
      id: "racks",
      accessorKey: "rack_count",
      header: ({ column }) => <SortHeader column={column} label="Racks" />,
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.rack_count}</span>
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "Racks",
          get: (r: RackRole) => (r.rack_count > 0 ? "in" : "out"),
          formatValue: (v) => ({
            label: v === "in" ? "In use" : "Unused",
          }),
        },
      },
    },
    timeAgoColumn<RackRole>({
      id: "updated",
      header: "Updated",
      get: (r) => r.updated_at,
      align: "right",
    }),
    {
      id: "actions",
      enableHiding: false,
      cell: ({ row }) => (
        <RowActions
          editTo={canEdit ? "/rack-roles/$id/edit" : undefined}
          editParams={{ id: row.original.id }}
          onDelete={canDelete ? () => onDelete(row.original) : undefined}
        />
      ),
    },
  ]
}
