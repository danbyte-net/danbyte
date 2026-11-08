import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import type { SensitivityLabel } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { buildSensitivityLabelColumns } from "@/components/columns/sensitivity-label-columns"
import { SensitivityLabelDeleteDialog } from "@/components/sensitivity-label-delete-dialog"
import { SENSITIVITY_LABEL_KEYS } from "@/components/sensitivity-label-form"
import { ListPageShell } from "@/components/list-page-shell"
import { SafeBulkEditBar } from "@/components/safe-bulk-edit-bar"
import { TableActions } from "@/components/table-actions"
import { useUrlTableFilters } from "@/components/table-filters"
import { useMe } from "@/lib/use-me"
import { useUrlSearch } from "@/lib/url-filters"

export const Route = createFileRoute("/sensitivity-labels/")({
  component: SensitivityLabelsPage,
})

function SensitivityLabelsPage() {
  const [q, setQ] = useUrlSearch()
  const [deleting, setDeleting] = useState<SensitivityLabel | null>(null)
  const [selected, setSelected] = useState<SensitivityLabel[]>([])
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("sensitivitylabel", "add")
  const canEdit = canDo("sensitivitylabel", "change")
  const canDelete = canDo("sensitivitylabel", "delete")

  const query = useQuery({
    queryKey: ["sensitivity-labels", q],
    queryFn: () =>
      apiAll<SensitivityLabel>(
        `/api/sensitivity-labels/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })

  const handleDelete = useCallback((l: SensitivityLabel) => setDeleting(l), [])
  const selectable = canEdit || canDelete
  const columns = useMemo<ColumnDef<SensitivityLabel>[]>(
    () =>
      buildSensitivityLabelColumns({
        selection: selectable,
        humanIds,
        actions: {
          editTo: "/sensitivity-labels/$id/edit",
          editParams: (l) => ({ id: l.id }),
          canEdit: () => canEdit,
          onDelete: handleDelete,
          canDelete: () => canDelete,
        },
      }),
    [handleDelete, selectable, canEdit, canDelete, humanIds]
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
      title="Sensitivity labels"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      savedViews={{
        objectType: "sensitivitylabel",
        filters: { snapshot, restore, activeCount },
      }}
      search={{ value: q, onChange: setQ, placeholder: "Filter…" }}
      actions={
        <>
          <TableActions ioType="sensitivitylabel" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/sensitivity-labels/new">Add label</Link>
            </Button>
          )}
        </>
      }
      query={query}
    >
      <DataTable
        data={filteredRows}
        columns={wiredColumns}
        flexColumn="description"
        tableId="sensitivity-labels"
        onSelectedRowsChange={selectable ? setSelected : undefined}
        selectedRows={selectable ? selected : undefined}
      />
      <SafeBulkEditBar
        selected={selected}
        endpoint="/api/sensitivity-labels/"
        noun={["sensitivity label", "sensitivity labels"]}
        invalidate={SENSITIVITY_LABEL_KEYS}
        onCleared={() => setSelected([])}
        canEdit={canEdit}
        canDelete={canDelete}
      />
      <SensitivityLabelDeleteDialog
        label={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}
