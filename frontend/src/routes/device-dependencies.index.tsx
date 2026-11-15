import { createFileRoute } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { useMemo, useState } from "react"
import { WandSparkles } from "lucide-react"

import type { DeviceDependency } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { buildDeviceDependencyColumns } from "@/components/columns/device-dependency-columns"
import {
  DEVICE_DEPENDENCY_KEYS,
  DeviceDependencyDialog,
} from "@/components/device-dependencies/dependency-dialog"
import { DeviceDependencyDeleteDialog } from "@/components/device-dependencies/dependency-delete-dialog"
import { SuggestDependenciesDialog } from "@/components/device-dependencies/suggest-dialog"
import { ListPageShell } from "@/components/list-page-shell"
import { SafeBulkEditBar } from "@/components/safe-bulk-edit-bar"
import { TableActions } from "@/components/table-actions"
import { useUrlTableFilters } from "@/components/table-filters"
import { useMe } from "@/lib/use-me"
import { useUrlSearch } from "@/lib/url-filters"

// Device dependencies (#450): which device depends on which, over what
// medium, with redundancy groups and peer links. Add and edit in a dialog;
// bulk edit covers the medium, group, description, tags and custom fields.
// Suggest… proposes them from cables and LLDP towards a core device.
export const Route = createFileRoute("/device-dependencies/")({
  component: DeviceDependenciesPage,
})

function DeviceDependenciesPage() {
  const [q, setQ] = useUrlSearch()
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("devicedependency", "add")
  const canEdit = canDo("devicedependency", "change")
  const canDelete = canDo("devicedependency", "delete")
  const [adding, setAdding] = useState(false)
  const [suggesting, setSuggesting] = useState(false)
  const [editing, setEditing] = useState<DeviceDependency | null>(null)
  const [deleting, setDeleting] = useState<DeviceDependency | null>(null)
  const [selected, setSelected] = useState<DeviceDependency[]>([])

  const query = useQuery({
    queryKey: ["device-dependencies", "list", q],
    queryFn: () =>
      apiAll<DeviceDependency>(
        `/api/device-dependencies/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })

  const selectable = canEdit || canDelete
  const columns = useMemo<ColumnDef<DeviceDependency>[]>(
    () =>
      buildDeviceDependencyColumns({
        selection: selectable,
        humanIds,
        actions: {
          onEdit: setEditing,
          canEdit: () => canEdit,
          onDelete: setDeleting,
          canDelete: () => canDelete,
        },
      }),
    [selectable, humanIds, canEdit, canDelete]
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
      title="Dependencies"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      savedViews={{
        objectType: "devicedependency",
        filters: { snapshot, restore, activeCount },
      }}
      search={{ value: q, onChange: setQ, placeholder: "Filter…" }}
      add={
        canAdd && (
          <Button size="sm" onClick={() => setAdding(true)}>
            Add dependency
          </Button>
        )
      }
      actions={
        <>
          {canAdd && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setSuggesting(true)}
            >
              <WandSparkles className="h-3.5 w-3.5" /> Suggest…
            </Button>
          )}
          <TableActions ioType="devicedependency" />
        </>
      }
      query={query}
    >
      <DataTable
        data={filteredRows}
        columns={wiredColumns}
        flexColumn="description"
        tableId="device-dependencies"
        onSelectedRowsChange={selectable ? setSelected : undefined}
        selectedRows={selectable ? selected : undefined}
      />
      <SafeBulkEditBar
        selected={selected}
        endpoint="/api/device-dependencies/"
        noun={["dependency", "dependencies"]}
        invalidate={DEVICE_DEPENDENCY_KEYS}
        onCleared={() => setSelected([])}
        canEdit={canEdit}
        canDelete={canDelete}
        ioType="devicedependency"
      />
      <DeviceDependencyDialog
        mode={{ kind: "add" }}
        open={adding}
        onOpenChange={setAdding}
      />
      {editing && (
        <DeviceDependencyDialog
          mode={{ kind: "edit", dependency: editing }}
          open
          onOpenChange={(o) => !o && setEditing(null)}
        />
      )}
      <SuggestDependenciesDialog
        open={suggesting}
        onOpenChange={setSuggesting}
      />
      <DeviceDependencyDeleteDialog
        dependency={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}
