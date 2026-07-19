import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type ClusterGroup, type Paginated } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader, selectionColumn } from "@/components/data-table"
import { useTableFilters } from "@/components/table-filters"
import { ListPageShell } from "@/components/list-page-shell"
import { numidColumn } from "@/components/cells/numid"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { ClusterGroupDeleteDialog } from "@/components/cluster-group-delete-dialog"
import { RowActions } from "@/components/row-actions"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/cluster-groups/")({
  component: ClusterGroupsPage,
})

function ClusterGroupsPage() {
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("clustergroup", "add")
  const canEdit = canDo("clustergroup", "change")
  const canDelete = canDo("clustergroup", "delete")
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<ClusterGroup | null>(null)

  const query = useQuery({
    queryKey: ["cluster-groups", q],
    queryFn: () =>
      api<Paginated<ClusterGroup>>(
        `/api/cluster-groups/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })
  const rows = query.data?.results ?? []

  const handleDelete = useCallback((m: ClusterGroup) => setDeleting(m), [])
  const columns = useMemo<ColumnDef<ClusterGroup>[]>(
    () =>
      buildColumns({ onDelete: handleDelete, canEdit, canDelete, humanIds }),
    [handleDelete, canEdit, canDelete, humanIds]
  )
  const { rail, filteredRows } = useTableFilters(columns, rows)

  return (
    <ListPageShell
      title="Cluster groups"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter by name, description…",
      }}
      actions={
        <>
          <TableActions ioType="clustergroup" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/cluster-groups/new">Add cluster group</Link>
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
        tableId="cluster-groups"
      />
      <ClusterGroupDeleteDialog
        clusterGroup={deleting}
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
  onDelete: (m: ClusterGroup) => void
  canEdit: boolean
  canDelete: boolean
  humanIds: boolean
}): ColumnDef<ClusterGroup>[] {
  return [
    selectionColumn<ClusterGroup>(),
    ...(humanIds ? [numidColumn<ClusterGroup>({ get: (r) => r.numid })] : []),
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <Link
          to="/cluster-groups/$id"
          params={{ id: row.original.id }}
          className="font-medium hover:underline"
        >
          {row.original.name}
        </Link>
      ),
    },
    {
      id: "slug",
      accessorKey: "slug",
      header: ({ column }) => <SortHeader column={column} label="Slug" />,
      cell: ({ row }) => (
        <span className="font-mono text-xs text-muted-foreground">
          {row.original.slug}
        </span>
      ),
    },
    {
      id: "clusters",
      accessorKey: "cluster_count",
      header: ({ column }) => <SortHeader column={column} label="Clusters" />,
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.cluster_count}</span>
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "Clusters",
          get: (r: ClusterGroup) => (r.cluster_count > 0 ? "with" : "none"),
          formatValue: (v) => ({
            label: v === "with" ? "Has clusters" : "No clusters",
          }),
        },
      },
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
    timeAgoColumn<ClusterGroup>({
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
          editTo={canEdit ? "/cluster-groups/$id/edit" : undefined}
          editParams={{ id: row.original.id }}
          onDelete={canDelete ? () => onDelete(row.original) : undefined}
        />
      ),
    },
  ]
}
