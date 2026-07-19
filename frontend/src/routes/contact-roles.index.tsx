import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type ContactRole, type Paginated } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader, selectionColumn } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { numidColumn } from "@/components/cells/numid"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { ContactRoleDeleteDialog } from "@/components/contact-role-delete-dialog"
import { RowActions } from "@/components/row-actions"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/contact-roles/")({ component: ListPage })

function ListPage() {
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<ContactRole | null>(null)
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("contactrole", "add")
  const canEdit = canDo("contactrole", "change")
  const canDelete = canDo("contactrole", "delete")

  const query = useQuery({
    queryKey: ["contact-roles", q],
    queryFn: () =>
      api<Paginated<ContactRole>>(
        `/api/contact-roles/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })
  const rows = query.data?.results ?? []
  const handleDelete = useCallback((v: ContactRole) => setDeleting(v), [])
  const columns = useMemo<ColumnDef<ContactRole>[]>(
    () =>
      buildColumns({ onDelete: handleDelete, canEdit, canDelete, humanIds }),
    [handleDelete, canEdit, canDelete, humanIds]
  )

  return (
    <ListPageShell
      title="Contact roles"
      count={query.data ? rows.length : undefined}
      search={{ value: q, onChange: setQ, placeholder: "Filter…" }}
      actions={
        <>
          <TableActions ioType="contactrole" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/contact-roles/new">Add role</Link>
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
        tableId="contact-roles"
      />
      <ContactRoleDeleteDialog
        item={deleting}
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
  onDelete: (v: ContactRole) => void
  canEdit: boolean
  canDelete: boolean
  humanIds: boolean
}): ColumnDef<ContactRole>[] {
  return [
    selectionColumn<ContactRole>(),
    ...(humanIds ? [numidColumn<ContactRole>({ get: (r) => r.numid })] : []),
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <Link
          to="/contact-roles/$id/edit"
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
      id: "count",
      accessorKey: "assignment_count",
      header: ({ column }) => (
        <SortHeader column={column} label="Assignments" />
      ),
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.assignment_count}</span>
      ),
    },
    timeAgoColumn<ContactRole>({
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
          editTo={canEdit ? "/contact-roles/$id/edit" : undefined}
          editParams={{ id: row.original.id }}
          onDelete={canDelete ? () => onDelete(row.original) : undefined}
        />
      ),
    },
  ]
}
