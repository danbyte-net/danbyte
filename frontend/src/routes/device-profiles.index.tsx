import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { useCallback, useMemo, useState } from "react"

import type { DeviceProfile } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { SafeBulkDeleteBar } from "@/components/safe-bulk-delete-bar"
import { useUrlTableFilters } from "@/components/table-filters"
import { DeviceProfileDeleteDialog } from "@/components/device-profile-delete-dialog"
import { buildDeviceProfileColumns } from "@/components/columns/device-profile-columns"
import { useMe } from "@/lib/use-me"
import { useUrlSearch } from "@/lib/url-filters"

// Device profiles: a use case described once and given to devices and VMs.

export const Route = createFileRoute("/device-profiles/")({
  component: DeviceProfilesPage,
})

export function DeviceProfilesPage() {
  const [q, setQ] = useUrlSearch()
  const [deleting, setDeleting] = useState<DeviceProfile | null>(null)
  const [selected, setSelected] = useState<DeviceProfile[]>([])
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("deviceprofile", "add")
  const canEdit = canDo("deviceprofile", "change")
  const canDelete = canDo("deviceprofile", "delete")

  const query = useQuery({
    queryKey: ["device-profiles", q],
    queryFn: () =>
      apiAll<DeviceProfile>(
        `/api/device-profiles/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })
  const rows = query.data?.results ?? []
  const onDelete = useCallback((p: DeviceProfile) => setDeleting(p), [])
  const columns = useMemo(
    () =>
      buildDeviceProfileColumns<DeviceProfile>({
        selection: canDelete,
        humanIds,
        actions: {
          editTo: "/device-profiles/$id/edit",
          editParams: (p) => ({ id: p.id }),
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
      title="Device profiles"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      savedViews={{
        objectType: "deviceprofile",
        filters: { snapshot, restore, activeCount },
      }}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter by name, description…",
      }}
      actions={
        canAdd && (
          <Button size="sm" asChild>
            <Link to="/device-profiles/new">Add profile</Link>
          </Button>
        )
      }
      query={query}
    >
      <DataTable
        data={filteredRows}
        columns={wiredColumns}
        onSelectedRowsChange={setSelected}
        selectedRows={selected}
        flexColumn="description"
        tableId="device-profiles"
      />
      <DeviceProfileDeleteDialog
        profile={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
      <SafeBulkDeleteBar
        selected={selected}
        endpoint="/api/device-profiles/"
        noun={["profile", "profiles"]}
        invalidate={[["device-profiles"], ["device-profiles-picker"]]}
        onCleared={() => setSelected([])}
      />
    </ListPageShell>
  )
}
