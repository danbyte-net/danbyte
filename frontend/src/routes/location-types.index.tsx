import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import type { LocationType } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { buildLocationTypeColumns } from "@/components/columns/location-type-columns"
import { LocationTypeDeleteDialog } from "@/components/location-type-delete-dialog"
import { ListPageShell } from "@/components/list-page-shell"
import { SafeBulkEditBar } from "@/components/safe-bulk-edit-bar"
import { TableActions } from "@/components/table-actions"
import { useUrlTableFilters } from "@/components/table-filters"
import { useMe } from "@/lib/use-me"
import { useUrlSearch } from "@/lib/url-filters"

export const Route = createFileRoute("/location-types/")({
  component: LocationTypesPage,
})

function LocationTypesPage() {
  const [q, setQ] = useUrlSearch()
  const [deleting, setDeleting] = useState<LocationType | null>(null)
  const [selected, setSelected] = useState<LocationType[]>([])
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("locationtype", "add")
  const canEdit = canDo("locationtype", "change")
  const canDelete = canDo("locationtype", "delete")

  const query = useQuery({
    queryKey: ["location-types", q],
    queryFn: () =>
      apiAll<LocationType>(
        `/api/location-types/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })

  const handleDelete = useCallback((t: LocationType) => setDeleting(t), [])
  const selectable = canEdit || canDelete
  const columns = useMemo<ColumnDef<LocationType>[]>(
    () =>
      buildLocationTypeColumns({
        selection: selectable,
        humanIds,
        actions: {
          editTo: "/location-types/$id/edit",
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
      title="Location types"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      savedViews={{
        objectType: "locationtype",
        filters: { snapshot, restore, activeCount },
      }}
      search={{ value: q, onChange: setQ, placeholder: "Filter…" }}
      actions={
        <>
          <TableActions ioType="locationtype" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/location-types/new">Add type</Link>
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
        tableId="location-types"
        onSelectedRowsChange={selectable ? setSelected : undefined}
        selectedRows={selectable ? selected : undefined}
      />
      <SafeBulkEditBar
        selected={selected}
        endpoint="/api/location-types/"
        noun={["location type", "location types"]}
        invalidate={[
          ["location-types"],
          ["location-types-picker"],
          ["locations"],
        ]}
        onCleared={() => setSelected([])}
        canEdit={canEdit}
        canDelete={canDelete}
      />
      <LocationTypeDeleteDialog
        locationType={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}
