import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type Cluster, type Paginated } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader, selectionColumn } from "@/components/data-table"
import { tagsColumn } from "@/components/cells/tag-list"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { numidColumn } from "@/components/cells/numid"
import { useTableFilters } from "@/components/table-filters"
import { ListPageShell } from "@/components/list-page-shell"
import { ClusterDeleteDialog } from "@/components/cluster-delete-dialog"
import { StatusBadge } from "@/components/status-badge"
import { RowActions } from "@/components/row-actions"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/clusters/")({ component: ClustersPage })

function ClustersPage() {
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("cluster", "add")
  const canEdit = canDo("cluster", "change")
  const canDelete = canDo("cluster", "delete")
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<Cluster | null>(null)

  const query = useQuery({
    queryKey: ["clusters", q],
    queryFn: () =>
      api<Paginated<Cluster>>(
        `/api/clusters/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })

  const handleDelete = useCallback((c: Cluster) => setDeleting(c), [])

  const columns = useMemo<ColumnDef<Cluster>[]>(
    () =>
      buildColumns({ onDelete: handleDelete, canEdit, canDelete, humanIds }),
    [handleDelete, canEdit, canDelete, humanIds]
  )

  const allRows = query.data?.results ?? []
  const { rail, filteredRows } = useTableFilters(columns, allRows)

  return (
    <ListPageShell
      title="Clusters"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter by name, description…",
      }}
      actions={
        <>
          <TableActions ioType="cluster" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/clusters/new">Add cluster</Link>
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
        tableId="clusters"
      />
      <ClusterDeleteDialog
        cluster={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}

interface ColumnOpts {
  onDelete: (c: Cluster) => void
  canEdit: boolean
  canDelete: boolean
  humanIds: boolean
}

function buildColumns({
  onDelete,
  canEdit,
  canDelete,
  humanIds,
}: ColumnOpts): ColumnDef<Cluster>[] {
  return [
    selectionColumn<Cluster>(),
    ...(humanIds ? [numidColumn<Cluster>({ get: (r) => r.numid })] : []),
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <Link
          to="/clusters/$id"
          params={{ id: row.original.id }}
          className="font-medium hover:underline"
        >
          {row.original.name}
        </Link>
      ),
    },
    {
      id: "type",
      header: ({ column }) => <SortHeader column={column} label="Type" />,
      accessorFn: (r) => r.type.name,
      cell: ({ row }) => (
        <span className="text-xs">{row.original.type.name}</span>
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "Type",
          get: (r: Cluster) => r.type.name,
        },
      },
    },
    {
      id: "group",
      header: ({ column }) => <SortHeader column={column} label="Group" />,
      accessorFn: (r) => r.group?.name ?? "",
      cell: ({ row }) =>
        row.original.group ? (
          <span className="text-xs">{row.original.group.name}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
      meta: {
        facet: {
          kind: "enum",
          label: "Group",
          get: (r: Cluster) => r.group?.name ?? "—",
        },
      },
    },
    {
      id: "site",
      header: ({ column }) => <SortHeader column={column} label="Site" />,
      accessorFn: (r) => r.site?.name ?? "",
      cell: ({ row }) =>
        row.original.site ? (
          <span className="text-xs">{row.original.site.name}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
      meta: {
        facet: {
          kind: "enum",
          label: "Site",
          get: (r: Cluster) => r.site?.name ?? "—",
        },
      },
    },
    {
      id: "status",
      accessorFn: (r) => r.status?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Status" />,
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
      meta: {
        facet: {
          kind: "enum",
          label: "Status",
          get: (r: Cluster) => r.status?.id ?? "__none__",
          formatValue: (_v, r) => ({
            label: r.status?.name ?? "No status",
            color: r.status?.color,
          }),
        },
      },
    },
    {
      id: "vms",
      accessorKey: "vm_count",
      header: ({ column }) => <SortHeader column={column} label="VMs" />,
      cell: ({ row }) =>
        row.original.vm_count > 0 ? (
          <span className="num text-xs">{row.original.vm_count}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    tagsColumn<Cluster>({
      getTags: (r) => r.tags,
    }),
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
    timeAgoColumn<Cluster>({
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
          editTo={canEdit ? "/clusters/$id/edit" : undefined}
          editParams={{ id: row.original.id }}
          onDelete={canDelete ? () => onDelete(row.original) : undefined}
        />
      ),
    },
  ]
}
