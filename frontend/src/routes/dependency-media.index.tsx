import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import type { DependencyMedium } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { buildDependencyMediumColumns } from "@/components/columns/dependency-medium-columns"
import { DependencyMediumDeleteDialog } from "@/components/dependency-medium-delete-dialog"
import { ListPageShell } from "@/components/list-page-shell"
import { TableActions } from "@/components/table-actions"
import { useUrlTableFilters } from "@/components/table-filters"
import { useMe, objCan } from "@/lib/use-me"
import { useUrlSearch } from "@/lib/url-filters"

export const Route = createFileRoute("/dependency-media/")({
  component: DependencyMediaPage,
})

function DependencyMediaPage() {
  const [q, setQ] = useUrlSearch()
  const [deleting, setDeleting] = useState<DependencyMedium | null>(null)
  const { canDo } = useMe()
  const canAdd = canDo("dependencymedium", "add")
  const canEdit = canDo("dependencymedium", "change")
  const canDelete = canDo("dependencymedium", "delete")

  const query = useQuery({
    queryKey: ["dependency-media", q],
    queryFn: () =>
      apiAll<DependencyMedium>(
        `/api/dependency-media/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })

  const handleDelete = useCallback((m: DependencyMedium) => setDeleting(m), [])
  const columns = useMemo<ColumnDef<DependencyMedium>[]>(
    () =>
      buildDependencyMediumColumns({
        actions: {
          editTo: "/dependency-media/$id/edit",
          editParams: (m) => ({ id: m.id }),
          canEdit: (m) => objCan(m, "change", canEdit),
          onDelete: handleDelete,
          canDelete: (m) => objCan(m, "delete", canDelete),
        },
      }),
    [handleDelete, canEdit, canDelete]
  )

  const allRows = query.data?.results ?? []
  const {
    rail,
    filteredRows,
    snapshot,
    restore,
    activeCount,
    columns: wiredColumns,
  } = useUrlTableFilters(columns, allRows)

  return (
    <ListPageShell
      title="Dependency media"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      savedViews={{
        objectType: "dependencymedium",
        filters: { snapshot, restore, activeCount },
      }}
      search={{ value: q, onChange: setQ, placeholder: "Filter…" }}
      add={
        canAdd && (
          <Button size="sm" asChild>
            <Link to="/dependency-media/new">Add medium</Link>
          </Button>
        )
      }
      actions={<TableActions ioType="dependencymedium" />}
      query={query}
    >
      <DataTable
        data={filteredRows}
        columns={wiredColumns}
        flexColumn="description"
        tableId="dependency-media"
      />
      <DependencyMediumDeleteDialog
        medium={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}
