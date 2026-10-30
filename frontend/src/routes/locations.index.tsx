import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { type Location } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { useMe } from "@/lib/use-me"
import { nestByParent } from "@/lib/nest"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { ComponentBulkBar } from "@/components/component-bulk-bar"
import { useUrlTableFilters } from "@/components/table-filters"
import { ListPageShell } from "@/components/list-page-shell"
import { LocationDeleteDialog } from "@/components/location-delete-dialog"
import { buildLocationColumns } from "@/components/columns/location-columns"
import { useUrlSearch } from "@/lib/url-filters"

export const Route = createFileRoute("/locations/")({
  component: LocationsPage,
})

// Depth-first tree order + `_depth` markers - shared with the Regions list
// (frontend/src/lib/nest.ts), same treatment as the prefix tree.

function LocationsPage() {
  const { canDo } = useMe()
  const canAdd = canDo("location", "add")
  const canEdit = canDo("location", "change")
  const [sel, setSel] = useState<Location[]>([])
  const { humanIds } = useMe()
  const [q, setQ] = useUrlSearch()
  const [deleting, setDeleting] = useState<Location | null>(null)

  const query = useQuery({
    queryKey: ["locations", q],
    queryFn: () =>
      apiAll<Location>(
        `/api/locations/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })

  const allRows = useMemo(() => query.data?.results ?? [], [query.data])
  const onDelete = useCallback((l: Location) => setDeleting(l), [])
  const columns = useMemo<ColumnDef<Location>[]>(
    () =>
      buildLocationColumns<Location>({
        selection: canEdit,
        humanIds,
        nested: true,
        actions: {
          editTo: "/locations/$id/edit",
          editParams: (l) => ({ id: l.id }),
          onDelete,
        },
      }),
    [onDelete, humanIds, canEdit]
  )

  // Rail derives from the columns' facet metadata (Status, Site) - filter
  // first, then nest, so children of a hidden parent surface at the root
  // instead of dangling indented under nothing.
  const {
    rail,
    filteredRows,
    snapshot,
    restore,
    activeCount,
    columns: wiredColumns,
  } = useUrlTableFilters(columns, allRows)
  const rows = useMemo(() => nestByParent(filteredRows), [filteredRows])

  return (
    <ListPageShell
      title="Locations"
      count={query.data ? rows.length : undefined}
      rail={rail}
      savedViews={{
        objectType: "location",
        filters: { snapshot, restore, activeCount },
      }}
      search={{ value: q, onChange: setQ, placeholder: "Filter locations…" }}
      actions={
        <>
          <TableActions ioType="location" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/locations/new">Add location</Link>
            </Button>
          )}
        </>
      }
      query={query}
    >
      <DataTable
        data={rows}
        columns={wiredColumns}
        flexColumn="name"
        tableId="locations"
        onSelectedRowsChange={setSel}
      />
      <ComponentBulkBar
        endpoint="/api/locations/"
        kindLabel="location"
        selected={sel}
        onCleared={() => setSel([])}
        invalidate={[["locations"]]}
        canDelete={false}
        rename={false}
        clone={false}
        fields={[
          { key: "color", label: "Marker colour", kind: "color" },
          { key: "icon", label: "Marker icon", kind: "icon" },
        ]}
      />
      <LocationDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}
