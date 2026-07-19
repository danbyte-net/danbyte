import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type ClusterType, type Paginated } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader, selectionColumn } from "@/components/data-table"
import { useTableFilters } from "@/components/table-filters"
import { ListPageShell } from "@/components/list-page-shell"
import { numidColumn } from "@/components/cells/numid"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { ClusterTypeDeleteDialog } from "@/components/cluster-type-delete-dialog"
import { RowActions } from "@/components/row-actions"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/cluster-types/")({
  component: ClusterTypesPage,
})

function ClusterTypesPage() {
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("clustertype", "add")
  const canEdit = canDo("clustertype", "change")
  const canDelete = canDo("clustertype", "delete")
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<ClusterType | null>(null)

  const query = useQuery({
    queryKey: ["cluster-types", q],
    queryFn: () =>
      api<Paginated<ClusterType>>(
        `/api/cluster-types/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })
  const rows = query.data?.results ?? []

  const handleDelete = useCallback((m: ClusterType) => setDeleting(m), [])
  const columns = useMemo<ColumnDef<ClusterType>[]>(
    () =>
      buildColumns({ onDelete: handleDelete, canEdit, canDelete, humanIds }),
    [handleDelete, canEdit, canDelete, humanIds]
  )
  const { rail, filteredRows } = useTableFilters(columns, rows)

  return (
    <ListPageShell
      title="Cluster types"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter by name, description…",
      }}
      actions={
        <>
          <TableActions ioType="clustertype" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/cluster-types/new">Add cluster type</Link>
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
        tableId="cluster-types"
      />
      <ClusterTypeDeleteDialog
        clusterType={deleting}
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
  onDelete: (m: ClusterType) => void
  canEdit: boolean
  canDelete: boolean
  humanIds: boolean
}): ColumnDef<ClusterType>[] {
  return [
    selectionColumn<ClusterType>(),
    ...(humanIds ? [numidColumn<ClusterType>({ get: (r) => r.numid })] : []),
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <Link
          to="/cluster-types/$id"
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
          get: (r: ClusterType) => (r.cluster_count > 0 ? "with" : "none"),
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
    timeAgoColumn<ClusterType>({
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
          editTo={canEdit ? "/cluster-types/$id/edit" : undefined}
          editParams={{ id: row.original.id }}
          onDelete={canDelete ? () => onDelete(row.original) : undefined}
        />
      ),
    },
  ]
}
