import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api } from "@/lib/api"
import type { CoolingFeed, Paginated } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { useUrlSearch } from "@/lib/url-filters"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { TableActions } from "@/components/table-actions"
import { buildCoolingFeedColumns } from "@/components/columns/cooling-feed-columns"
import { useUrlTableFilters } from "@/components/table-filters"
import { ListPageShell } from "@/components/list-page-shell"
import { CoolingFeedDeleteDialog } from "@/components/cooling-feed-delete-dialog"
import { CoolingFeedBulkBar } from "@/components/cooling-bulk-bars"

export const Route = createFileRoute("/cooling-feeds/")({
  component: CoolingFeedsPage,
})

function CoolingFeedsPage() {
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("coolingfeed", "add")
  const canEdit = canDo("coolingfeed", "change")
  const canDelete = canDo("coolingfeed", "delete")
  const [q, setQ] = useUrlSearch()
  const [deleting, setDeleting] = useState<CoolingFeed | null>(null)
  const [selectedRows, setSelectedRows] = useState<CoolingFeed[]>([])

  const query = useQuery({
    queryKey: ["cooling-feeds", q],
    queryFn: () =>
      api<Paginated<CoolingFeed>>(
        `/api/cooling-feeds/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })

  const rows = query.data?.results ?? []
  const onDelete = useCallback((f: CoolingFeed) => setDeleting(f), [])
  const columns = useMemo<ColumnDef<CoolingFeed>[]>(
    () =>
      buildCoolingFeedColumns<CoolingFeed>({
        humanIds,
        selection: canEdit || canDelete,
        actions: {
          editTo: "/cooling-feeds/$id/edit",
          editParams: (f) => ({ id: f.id }),
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
      title="Cooling feeds"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      savedViews={{
        objectType: "coolingfeed",
        filters: { snapshot, restore, activeCount },
      }}
      search={{ value: q, onChange: setQ, placeholder: "Filter feeds…" }}
      actions={
        <>
          <TableActions ioType="coolingfeed" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/cooling-feeds/new">Add feed</Link>
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
        tableId="cooling-feeds"
      />
      <CoolingFeedDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
      <CoolingFeedBulkBar
        selected={selectedRows}
        onCleared={() => setSelectedRows([])}
        canEdit={canEdit}
        canDelete={canDelete}
      />
    </ListPageShell>
  )
}
