import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type Paginated, type PlatformGroup } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader, selectionColumn } from "@/components/data-table"
import { useTableFilters } from "@/components/table-filters"
import { ListPageShell } from "@/components/list-page-shell"
import { numidColumn } from "@/components/cells/numid"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { PlatformGroupDeleteDialog } from "@/components/platform-group-delete-dialog"
import { RowActions } from "@/components/row-actions"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/platform-groups/")({
  component: PlatformGroupsPage,
})

function PlatformGroupsPage() {
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<PlatformGroup | null>(null)
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("platformgroup", "add")
  const canEdit = canDo("platformgroup", "change")
  const canDelete = canDo("platformgroup", "delete")

  const query = useQuery({
    queryKey: ["platform-groups", q],
    queryFn: () =>
      api<Paginated<PlatformGroup>>(
        `/api/platform-groups/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })
  const rows = query.data?.results ?? []

  const handleDelete = useCallback((g: PlatformGroup) => setDeleting(g), [])
  const columns = useMemo<ColumnDef<PlatformGroup>[]>(
    () =>
      buildColumns({ onDelete: handleDelete, canEdit, canDelete, humanIds }),
    [handleDelete, canEdit, canDelete, humanIds]
  )
  const { rail, filteredRows } = useTableFilters(columns, rows)

  return (
    <ListPageShell
      title="Platform groups"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter by name, description…",
      }}
      actions={
        <>
          <TableActions ioType="platformgroup" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/platform-groups/new">Add group</Link>
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
        tableId="platform-groups"
      />
      <PlatformGroupDeleteDialog
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
  humanIds,
}: {
  onDelete: (g: PlatformGroup) => void
  canEdit: boolean
  canDelete: boolean
  humanIds: boolean
}): ColumnDef<PlatformGroup>[] {
  return [
    selectionColumn<PlatformGroup>(),
    ...(humanIds ? [numidColumn<PlatformGroup>({ get: (r) => r.numid })] : []),
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <Link
          to="/platform-groups/$id"
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
      cell: ({ row }) =>
        row.original.parent ? (
          <Link
            to="/platform-groups/$id"
            params={{ id: row.original.parent.id }}
            className="text-xs text-primary hover:underline"
          >
            {row.original.parent.name}
          </Link>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
      meta: {
        facet: {
          kind: "enum",
          label: "Parent",
          get: (r: PlatformGroup) => r.parent?.id ?? "__none__",
          formatValue: (_v, r) => ({
            label: r.parent?.name ?? "No parent",
          }),
        },
      },
    },
    {
      id: "platforms",
      accessorKey: "platform_count",
      header: ({ column }) => <SortHeader column={column} label="Platforms" />,
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.platform_count}</span>
      ),
    },
    {
      id: "children",
      accessorKey: "child_count",
      header: ({ column }) => <SortHeader column={column} label="Subgroups" />,
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.child_count}</span>
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
    timeAgoColumn<PlatformGroup>({
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
          editTo={canEdit ? "/platform-groups/$id/edit" : undefined}
          editParams={{ id: row.original.id }}
          onDelete={canDelete ? () => onDelete(row.original) : undefined}
        />
      ),
    },
  ]
}
