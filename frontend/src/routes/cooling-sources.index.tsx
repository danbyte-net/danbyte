import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { apiAll } from "@/lib/api-all"
import type { CoolingSource } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { useUrlSearch } from "@/lib/url-filters"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { TableActions } from "@/components/table-actions"
import { buildCoolingSourceColumns } from "@/components/columns/cooling-source-columns"
import { useUrlTableFilters } from "@/components/table-filters"
import { ListPageShell } from "@/components/list-page-shell"
import { CoolingSourceDeleteDialog } from "@/components/cooling-source-delete-dialog"
import { CoolingSourceBulkBar } from "@/components/cooling-bulk-bars"

export const Route = createFileRoute("/cooling-sources/")({
  component: CoolingSourcesPage,
})

function CoolingSourcesPage() {
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("coolingsource", "add")
  const canEdit = canDo("coolingsource", "change")
  const canDelete = canDo("coolingsource", "delete")
  const [q, setQ] = useUrlSearch()
  const [deleting, setDeleting] = useState<CoolingSource | null>(null)
  const [selectedRows, setSelectedRows] = useState<CoolingSource[]>([])

  const query = useQuery({
    queryKey: ["cooling-sources", q],
    queryFn: () =>
      apiAll<CoolingSource>(
        `/api/cooling-sources/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })

  const rows = query.data?.results ?? []
  const onDelete = useCallback((s: CoolingSource) => setDeleting(s), [])
  const columns = useMemo<ColumnDef<CoolingSource>[]>(
    () =>
      buildCoolingSourceColumns<CoolingSource>({
        humanIds,
        selection: canEdit || canDelete,
        actions: {
          editTo: "/cooling-sources/$id/edit",
          editParams: (s) => ({ id: s.id }),
          onDelete,
        },
      }),
    [onDelete, humanIds, canEdit, canDelete]
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
      title="Cooling sources"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      savedViews={{
        objectType: "coolingsource",
        filters: { snapshot, restore, activeCount },
      }}
      search={{ value: q, onChange: setQ, placeholder: "Filter sources…" }}
      actions={
        <>
          <TableActions ioType="coolingsource" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/cooling-sources/new">Add source</Link>
            </Button>
          )}
        </>
      }
      query={query}
    >
      <DataTable
        data={filteredRows}
        columns={wiredColumns}
        onSelectedRowsChange={setSelectedRows}
        selectedRows={selectedRows}
        flexColumn="name"
        tableId="cooling-sources"
      />
      <CoolingSourceDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
      <CoolingSourceBulkBar
        selected={selectedRows}
        onCleared={() => setSelectedRows([])}
        canEdit={canEdit}
        canDelete={canDelete}
        canDeleteFeeds={canDo("coolingfeed", "delete")}
      />
    </ListPageShell>
  )
}
