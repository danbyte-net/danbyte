import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type CustomFieldGroup, type Paginated } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader, selectionColumn } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { CustomFieldGroupDeleteDialog } from "@/components/custom-field-group-delete-dialog"
import { RowActions } from "@/components/row-actions"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/custom-field-groups/")({
  component: CustomFieldGroupsPage,
})

function CustomFieldGroupsPage() {
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<CustomFieldGroup | null>(null)
  const { canDo } = useMe()
  const canAdd = canDo("customfieldgroup", "add")
  const canEdit = canDo("customfieldgroup", "change")
  const canDelete = canDo("customfieldgroup", "delete")

  const query = useQuery({
    queryKey: ["custom-field-groups", q],
    queryFn: () =>
      api<Paginated<CustomFieldGroup>>(
        `/api/custom-field-groups/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })
  const rows = query.data?.results ?? []

  const handleDelete = useCallback((g: CustomFieldGroup) => setDeleting(g), [])
  const columns = useMemo<ColumnDef<CustomFieldGroup>[]>(
    () => buildColumns({ onDelete: handleDelete, canEdit, canDelete }),
    [handleDelete, canEdit, canDelete]
  )

  return (
    <ListPageShell
      title="Custom field groups"
      count={query.data ? rows.length : undefined}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter by name, description…",
      }}
      actions={
        <>
          <TableActions ioType="customfieldgroup" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/custom-field-groups/new">Add group</Link>
            </Button>
          )}
        </>
      }
      query={query}
    >
      <DataTable
        data={rows}
        columns={columns}
        flexColumn="description"
        tableId="custom-field-groups"
      />
      <CustomFieldGroupDeleteDialog
        group={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}

function buildColumns({
  onDelete,
  canEdit,
  canDelete,
}: {
  onDelete: (g: CustomFieldGroup) => void
  canEdit: boolean
  canDelete: boolean
}): ColumnDef<CustomFieldGroup>[] {
  return [
    selectionColumn<CustomFieldGroup>(),
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <Link
          to="/custom-field-groups/$id/edit"
          params={{ id: row.original.id }}
          className="font-medium hover:underline"
        >
          {row.original.name}
        </Link>
      ),
    },
    {
      id: "fields",
      accessorKey: "field_count",
      header: ({ column }) => <SortHeader column={column} label="Fields" />,
      cell: ({ row }) => (
        <span className="num text-xs text-muted-foreground">
          {row.original.field_count}
        </span>
      ),
    },
    {
      id: "weight",
      accessorKey: "weight",
      header: ({ column }) => <SortHeader column={column} label="Weight" />,
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.weight}</span>
      ),
    },
    {
      id: "collapsed",
      accessorKey: "collapsed",
      header: "Collapsed",
      cell: ({ row }) =>
        row.original.collapsed ? (
          <span className="text-xs text-muted-foreground">yes</span>
        ) : (
          <span className="text-muted-foreground">—</span>
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
      id: "actions",
      enableHiding: false,
      cell: ({ row }) => (
        <RowActions
          editTo={canEdit ? "/custom-field-groups/$id/edit" : undefined}
          editParams={{ id: row.original.id }}
          onDelete={canDelete ? () => onDelete(row.original) : undefined}
        />
      ),
    },
  ]
}
