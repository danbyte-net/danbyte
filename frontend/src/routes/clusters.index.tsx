import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type Cluster, type Paginated } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { buildClusterColumns } from "@/components/columns/cluster-columns"
import { useTableFilters } from "@/components/table-filters"
import { ListPageShell } from "@/components/list-page-shell"
import { ClusterDeleteDialog } from "@/components/cluster-delete-dialog"
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
      buildClusterColumns({
        selection: true,
        humanIds,
        actions: {
          editTo: "/clusters/$id/edit",
          editParams: (c) => ({ id: c.id }),
          canEdit: () => canEdit,
          onDelete: handleDelete,
          canDelete: () => canDelete,
        },
      }),
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
