import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type ContactGroup, type Paginated } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader, selectionColumn } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { numidColumn } from "@/components/cells/numid"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { ContactGroupDeleteDialog } from "@/components/contact-group-delete-dialog"
import { RowActions } from "@/components/row-actions"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/contact-groups/")({
  component: ListPage,
})

function ListPage() {
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<ContactGroup | null>(null)
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("contactgroup", "add")
  const canEdit = canDo("contactgroup", "change")
  const canDelete = canDo("contactgroup", "delete")

  const query = useQuery({
    queryKey: ["contact-groups", q],
    queryFn: () =>
      api<Paginated<ContactGroup>>(
        `/api/contact-groups/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })
  const rows = query.data?.results ?? []
  const handleDelete = useCallback((v: ContactGroup) => setDeleting(v), [])
  const columns = useMemo<ColumnDef<ContactGroup>[]>(
    () =>
      buildColumns({ onDelete: handleDelete, canEdit, canDelete, humanIds }),
    [handleDelete, canEdit, canDelete, humanIds]
  )

  return (
    <ListPageShell
      title="Contact groups"
      count={query.data ? rows.length : undefined}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter…",
      }}
      actions={
        <>
          <TableActions ioType="contactgroup" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/contact-groups/new">Add group</Link>
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
        tableId="contact-groups"
      />
      <ContactGroupDeleteDialog
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
  onDelete: (v: ContactGroup) => void
  canEdit: boolean
  canDelete: boolean
  humanIds: boolean
}): ColumnDef<ContactGroup>[] {
  return [
    selectionColumn<ContactGroup>(),
    ...(humanIds ? [numidColumn<ContactGroup>({ get: (r) => r.numid })] : []),
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <Link
          to="/contact-groups/$id/edit"
          params={{ id: row.original.id }}
          className="font-medium hover:underline"
        >
          {row.original.name}
        </Link>
      ),
    },
    {
      id: "parent",
      accessorFn: (r) => r.parent?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Parent" />,
      cell: ({ row }) => (
        <span className="text-muted-foreground">
          {row.original.parent?.name ?? "—"}
        </span>
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
      accessorKey: "contact_count",
      header: ({ column }) => <SortHeader column={column} label="Contacts" />,
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.contact_count}</span>
      ),
    },
    timeAgoColumn<ContactGroup>({
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
          editTo={canEdit ? "/contact-groups/$id/edit" : undefined}
          editParams={{ id: row.original.id }}
          onDelete={canDelete ? () => onDelete(row.original) : undefined}
        />
      ),
    },
  ]
}
