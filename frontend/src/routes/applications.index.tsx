import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { useCallback, useMemo, useState } from "react"

import { type Application } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { SafeBulkDeleteBar } from "@/components/safe-bulk-delete-bar"
import { TableActions } from "@/components/table-actions"
import { useUrlTableFilters } from "@/components/table-filters"
import { ApplicationDeleteDialog } from "@/components/application-delete-dialog"
import { buildApplicationColumns } from "@/components/columns/application-columns"
import { useMe } from "@/lib/use-me"
import { useUrlSearch } from "@/lib/url-filters"

// The application catalog (#436): software the tenant runs, nested into a
// domain → process → application tree.

export const Route = createFileRoute("/applications/")({
  component: ApplicationsPage,
})

function ApplicationsPage() {
  const [q, setQ] = useUrlSearch()
  const [deleting, setDeleting] = useState<Application | null>(null)
  const [selected, setSelected] = useState<Application[]>([])
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("application", "add")
  const canEdit = canDo("application", "change")
  const canDelete = canDo("application", "delete")

  const query = useQuery({
    queryKey: ["applications", q],
    queryFn: () =>
      apiAll<Application>(
        `/api/applications/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })
  const rows = query.data?.results ?? []
  const onDelete = useCallback((a: Application) => setDeleting(a), [])
  const columns = useMemo(
    () =>
      buildApplicationColumns<Application>({
        selection: canDelete,
        humanIds,
        actions: {
          editTo: "/applications/$id/edit",
          editParams: (a) => ({ id: a.id }),
          canEdit: () => canEdit,
          onDelete,
          canDelete: () => canDelete,
        },
      }),
    [onDelete, canEdit, canDelete, humanIds]
  )
  const {
    rail,
    filteredRows,
    snapshot,
    restore,
    activeCount,
    columns: wiredColumns,
  } = useUrlTableFilters(columns, rows)

  return (
    <ListPageShell
      title="Applications"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      savedViews={{
        objectType: "application",
        filters: { snapshot, restore, activeCount },
      }}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter by name, description…",
      }}
      actions={
        <>
          <TableActions ioType="application" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/applications/new">Add application</Link>
            </Button>
          )}
        </>
      }
      query={query}
    >
      <DataTable
        data={filteredRows}
        columns={wiredColumns}
        onSelectedRowsChange={setSelected}
        selectedRows={selected}
        flexColumn="description"
        tableId="applications"
      />
      <ApplicationDeleteDialog
        application={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
      <SafeBulkDeleteBar
        selected={selected}
        endpoint="/api/applications/"
        noun={["application", "applications"]}
        invalidate={[["applications"], ["applications-picker"]]}
        onCleared={() => setSelected([])}
      />
    </ListPageShell>
  )
}
