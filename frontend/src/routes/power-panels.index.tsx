import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type PowerPanel, type Paginated } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { buildPowerPanelColumns } from "@/components/columns/power-panel-columns"
import { useUrlTableFilters } from "@/components/table-filters"
import { ListPageShell } from "@/components/list-page-shell"
import { PowerPanelDeleteDialog } from "@/components/power-panel-delete-dialog"
import { PowerPanelBulkBar } from "@/components/power-bulk-bars"
import { useUrlSearch } from "@/lib/url-filters"

export const Route = createFileRoute("/power-panels/")({
  component: PowerPanelsPage,
})

function PowerPanelsPage() {
  const { humanIds } = useMe()
  const { canDo } = useMe()
  const canAdd = canDo("powerpanel", "add")
  const canEdit = canDo("powerpanel", "change")
  const canDelete = canDo("powerpanel", "delete")
  const [q, setQ] = useUrlSearch()
  const [deleting, setDeleting] = useState<PowerPanel | null>(null)
  const [selectedRows, setSelectedRows] = useState<PowerPanel[]>([])

  const query = useQuery({
    queryKey: ["power-panels", q],
    queryFn: () =>
      api<Paginated<PowerPanel>>(
        `/api/power-panels/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })

  const rows = query.data?.results ?? []
  const onDelete = useCallback((p: PowerPanel) => setDeleting(p), [])
  const columns = useMemo<ColumnDef<PowerPanel>[]>(
    () =>
      buildPowerPanelColumns<PowerPanel>({
        humanIds,
        selection: canEdit || canDelete,
        actions: {
          editTo: "/power-panels/$id/edit",
          editParams: (p) => ({ id: p.id }),
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
    columns: facetColumns,
  } = useUrlTableFilters(columns, rows)

  return (
    <ListPageShell
      title="Power panels"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      savedViews={{
        objectType: "powerpanel",
        filters: { snapshot, restore, activeCount },
      }}
      search={{ value: q, onChange: setQ, placeholder: "Filter panels…" }}
      actions={
        <>
          <TableActions ioType="powerpanel" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/power-panels/new">Add panel</Link>
            </Button>
          )}
        </>
      }
      query={query}
    >
      <DataTable
        data={filteredRows}
        columns={facetColumns}
        onSelectedRowsChange={setSelectedRows}
        selectedRows={selectedRows}
        flexColumn="comments"
        tableId="power-panels"
      />
      <PowerPanelDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
      <PowerPanelBulkBar
        selected={selectedRows}
        onCleared={() => setSelectedRows([])}
        canEdit={canEdit}
        canDelete={canDelete}
        canDeleteFeeds={canDo("powerfeed", "delete")}
      />
    </ListPageShell>
  )
}
