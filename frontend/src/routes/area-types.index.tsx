import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import type { AreaType } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { buildAreaTypeColumns } from "@/components/columns/area-type-columns"
import { AreaTypeDeleteDialog } from "@/components/area-type-delete-dialog"
import { ListPageShell } from "@/components/list-page-shell"
import { SafeBulkEditBar } from "@/components/safe-bulk-edit-bar"
import { TableActions } from "@/components/table-actions"
import { useUrlTableFilters } from "@/components/table-filters"
import { useMe } from "@/lib/use-me"
import { useUrlSearch } from "@/lib/url-filters"

export const Route = createFileRoute("/area-types/")({
  component: AreaTypesPage,
})

function AreaTypesPage() {
  const [q, setQ] = useUrlSearch()
  const [deleting, setDeleting] = useState<AreaType | null>(null)
  const [selected, setSelected] = useState<AreaType[]>([])
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("areatype", "add")
  const canEdit = canDo("areatype", "change")
  const canDelete = canDo("areatype", "delete")

  const query = useQuery({
    queryKey: ["area-types", q],
    queryFn: () =>
      apiAll<AreaType>(
        `/api/area-types/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })

  const handleDelete = useCallback((t: AreaType) => setDeleting(t), [])
  const selectable = canEdit || canDelete
  const columns = useMemo<ColumnDef<AreaType>[]>(
    () =>
      buildAreaTypeColumns({
        selection: selectable,
        humanIds,
        actions: {
          editTo: "/area-types/$id/edit",
          editParams: (t) => ({ id: t.id }),
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
      title="Area types"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      savedViews={{
        objectType: "areatype",
        filters: { snapshot, restore, activeCount },
      }}
      search={{ value: q, onChange: setQ, placeholder: "Filter…" }}
      actions={
        <>
          <TableActions ioType="areatype" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/area-types/new">Add type</Link>
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
        tableId="area-types"
        onSelectedRowsChange={selectable ? setSelected : undefined}
        selectedRows={selectable ? selected : undefined}
      />
      <SafeBulkEditBar
        selected={selected}
        endpoint="/api/area-types/"
        noun={["area type", "area types"]}
        invalidate={[
          ["area-types"],
          ["area-types-picker"],
          ["floor-plan-contents"],
        ]}
        onCleared={() => setSelected([])}
        canEdit={canEdit}
        canDelete={canDelete}
      />
      <AreaTypeDeleteDialog
        areaType={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}
