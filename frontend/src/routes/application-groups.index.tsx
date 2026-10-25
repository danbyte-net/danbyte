import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { useCallback, useMemo, useState } from "react"

import type { ApplicationGroup } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { SafeBulkDeleteBar } from "@/components/safe-bulk-delete-bar"
import { TableActions } from "@/components/table-actions"
import { useUrlTableFilters } from "@/components/table-filters"
import { ApplicationGroupDeleteDialog } from "@/components/application-group-delete-dialog"
import { buildApplicationGroupColumns } from "@/components/columns/application-group-columns"
import { useMe } from "@/lib/use-me"
import { useUrlSearch } from "@/lib/url-filters"

// Application groups (#436): named sets of applications a device or VM gets
// in one step.

export const Route = createFileRoute("/application-groups/")({
  component: ApplicationGroupsPage,
})

function ApplicationGroupsPage() {
  const [q, setQ] = useUrlSearch()
  const [deleting, setDeleting] = useState<ApplicationGroup | null>(null)
  const [selected, setSelected] = useState<ApplicationGroup[]>([])
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("applicationgroup", "add")
  const canEdit = canDo("applicationgroup", "change")
  const canDelete = canDo("applicationgroup", "delete")

  const query = useQuery({
    queryKey: ["application-groups", q],
    queryFn: () =>
      apiAll<ApplicationGroup>(
        `/api/application-groups/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })
  const rows = query.data?.results ?? []
  const onDelete = useCallback((g: ApplicationGroup) => setDeleting(g), [])
  const columns = useMemo(
    () =>
      buildApplicationGroupColumns<ApplicationGroup>({
        selection: canDelete,
        humanIds,
        actions: {
          editTo: "/application-groups/$id/edit",
          editParams: (g) => ({ id: g.id }),
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
      title="Application groups"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      savedViews={{
        objectType: "applicationgroup",
        filters: { snapshot, restore, activeCount },
      }}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter by name, description…",
      }}
      actions={
        <>
          <TableActions ioType="applicationgroup" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/application-groups/new">Add group</Link>
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
        tableId="application-groups"
      />
      <ApplicationGroupDeleteDialog
        group={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
      <SafeBulkDeleteBar
        selected={selected}
        endpoint="/api/application-groups/"
        noun={["group", "groups"]}
        invalidate={[["application-groups"], ["application-groups-picker"]]}
        onCleared={() => setSelected([])}
      />
    </ListPageShell>
  )
}
