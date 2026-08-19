import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type DeviceType, type Paginated } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { ImportBundleDialog } from "@/components/device-bundle"
import { buildDeviceTypeColumns } from "@/components/columns/device-type-columns"
import { useTableFilters } from "@/components/table-filters"
import { DeviceTypeBulkBar } from "@/components/device-type-bulk-bar"
import { DeviceTypeDeleteDialog } from "@/components/device-type-delete-dialog"
import { DeviceTypeImportDialog } from "@/components/device-type-import-dialog"
import { DeviceTypeReimportImagesDialog } from "@/components/device-type-reimport-images-dialog"
import { useMe, objCan } from "@/lib/use-me"

export const Route = createFileRoute("/device-types/")({
  component: DeviceTypesPage,
})

function DeviceTypesPage() {
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("devicetype", "add")
  const canEdit = canDo("devicetype", "change")
  const canDelete = canDo("devicetype", "delete")
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<DeviceType | null>(null)
  const [selectedRows, setSelectedRows] = useState<DeviceType[]>([])
  const [importing, setImporting] = useState(false)
  const [importingBundle, setImportingBundle] = useState(false)
  const [reimportingImages, setReimportingImages] = useState(false)

  const query = useQuery({
    queryKey: ["device-types", q],
    queryFn: () =>
      api<Paginated<DeviceType>>(
        `/api/device-types/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })
  const allRows = useMemo(() => query.data?.results ?? [], [query.data])

  // A hardware catalog runs to thousands of rows, so the rail carries the whole
  // facet set the factory declares - manufacturer, height, images, faceplate,
  // usage, lifecycle, scope, tags - and a new facetable column joins it for
  // free. These facet-source columns are never rendered; the render columns
  // below add selection, the tag-chip wiring, and row actions.
  const facetColumns = useMemo<ColumnDef<DeviceType>[]>(
    () => buildDeviceTypeColumns<DeviceType>({ omit: ["part_number"] }),
    []
  )
  const {
    rail,
    filteredRows,
    toggleValue,
    selectedValues,
    snapshot,
    restore,
    activeCount,
  } = useTableFilters(facetColumns, allRows)
  const tagSelection = selectedValues("tags")

  const handleDelete = useCallback((d: DeviceType) => setDeleting(d), [])
  const columns = useMemo<ColumnDef<DeviceType>[]>(
    () =>
      buildDeviceTypeColumns<DeviceType>({
        selection: true,
        humanIds,
        omit: ["part_number"],
        tagFilter: {
          activeSlugs: tagSelection,
          onToggle: (slug) => toggleValue("tags", slug),
        },
        actions: {
          editTo: "/device-types/$id/edit",
          editParams: (d) => ({ id: d.id }),
          canEdit: (d) => objCan(d, "change", canEdit),
          onDelete: handleDelete,
          canDelete: (d) => objCan(d, "delete", canDelete),
        },
      }),
    [handleDelete, canEdit, canDelete, humanIds, tagSelection, toggleValue]
  )

  return (
    <ListPageShell
      title="Device types"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      savedViews={{
        objectType: "devicetype",
        filters: { snapshot, restore, activeCount },
      }}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter by name, model…",
      }}
      actions={
        <>
          <TableActions ioType="devicetype" />
          {/* Recovery tool - rewrites image fields on EXISTING types, so it
              rides the `change` grant, not `add`. */}
          {canEdit && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setReimportingImages(true)}
            >
              Reimport images
            </Button>
          )}
          {canAdd && (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setImporting(true)}
              >
                Import CSV
              </Button>
              {/* A bundle is a whole configured model - templates, faceplate,
                  photo ports, sensors - not just catalog rows. */}
              <Button
                size="sm"
                variant="outline"
                onClick={() => setImportingBundle(true)}
              >
                Import bundle
              </Button>
              <Button size="sm" asChild>
                <Link to="/device-types/new">Add device type</Link>
              </Button>
            </>
          )}
        </>
      }
      query={query}
    >
      <DataTable
        data={filteredRows}
        columns={columns}
        onSelectedRowsChange={setSelectedRows}
        flexColumn="description"
        tableId="device-types"
      />
      <DeviceTypeDeleteDialog
        deviceType={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
      {/* Selection comes from the table's filtered rows, so the bar only ever
          acts on what the rail is showing. Gated on the same `delete` grant
          as the per-row action - the server re-checks it either way. */}
      {canDelete && (
        <DeviceTypeBulkBar
          selected={selectedRows}
          onCleared={() => setSelectedRows([])}
        />
      )}
      <DeviceTypeImportDialog open={importing} onOpenChange={setImporting} />
      <ImportBundleDialog
        open={importingBundle}
        onOpenChange={setImportingBundle}
      />
      <DeviceTypeReimportImagesDialog
        open={reimportingImages}
        onOpenChange={setReimportingImages}
      />
    </ListPageShell>
  )
}
