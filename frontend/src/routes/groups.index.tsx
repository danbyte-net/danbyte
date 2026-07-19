import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type RBACGroup, type Paginated } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { RowActions } from "@/components/row-actions"
import { GroupDeleteDialog } from "@/components/group-delete-dialog"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/groups/")({ component: GroupsPage })

function GroupsPage() {
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<RBACGroup | null>(null)
  const { canDo } = useMe()
  const canAdd = canDo("group", "add")
  const canEdit = canDo("group", "change")
  const canDelete = canDo("group", "delete")

  const query = useQuery({
    queryKey: ["groups"],
    queryFn: () => api<Paginated<RBACGroup>>("/api/groups/"),
  })

  const allRows = query.data?.results ?? []
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return allRows
    return allRows.filter(
      (g) =>
        g.name.toLowerCase().includes(needle) ||
        g.description.toLowerCase().includes(needle)
    )
  }, [allRows, q])

  const handleDelete = useCallback((g: RBACGroup) => setDeleting(g), [])
  const columns = useMemo<ColumnDef<RBACGroup>[]>(
    () => buildColumns({ onDelete: handleDelete, canEdit, canDelete }),
    [handleDelete, canEdit, canDelete]
  )

  return (
    <ListPageShell
      title="Groups"
      count={query.data ? rows.length : undefined}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter groups…",
      }}
      actions={
        <>
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/groups/new">Add group</Link>
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
        tableId="groups"
      />
      <GroupDeleteDialog
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
  onDelete: (g: RBACGroup) => void
  canEdit: boolean
  canDelete: boolean
}): ColumnDef<RBACGroup>[] {
  return [
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <Link
          to="/groups/$id/edit"
          params={{ id: String(row.original.id) }}
          className="flex items-center gap-2 font-medium hover:underline"
        >
          {row.original.name}
          {row.original.built_in && (
            <Badge variant="secondary" className="text-[10px]">
              built-in
            </Badge>
          )}
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
      id: "users",
      accessorKey: "user_count",
      header: ({ column }) => <SortHeader column={column} label="Users" />,
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.user_count}</span>
      ),
    },
    {
      id: "permissions",
      accessorKey: "permission_count",
      header: ({ column }) => (
        <SortHeader column={column} label="Permissions" />
      ),
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.permission_count}</span>
      ),
    },
    {
      id: "actions",
      enableHiding: false,
      cell: ({ row }) => (
        <RowActions
          editTo={canEdit ? "/groups/$id/edit" : undefined}
          editParams={{ id: String(row.original.id) }}
          onDelete={
            canDelete && !row.original.built_in
              ? () => onDelete(row.original)
              : undefined
          }
        />
      ),
    },
  ]
}
