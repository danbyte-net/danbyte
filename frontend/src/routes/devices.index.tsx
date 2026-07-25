import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import {
  api,
  type BulkStatusEntry,
  type BulkStatusResponse,
  type Device,
  type Paginated,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { buildDeviceColumns } from "@/components/columns/device-columns"
import { useTableFilters } from "@/components/table-filters"
import { ListPageShell } from "@/components/list-page-shell"
import { DeviceDeleteDialog } from "@/components/device-delete-dialog"
import { DeviceBulkBar } from "@/components/device-bulk-bar"
import { useMe, objCan } from "@/lib/use-me"

export const Route = createFileRoute("/devices/")({
  // `?type=<device-type-id>` seeds the Type facet so cross-object links (e.g.
  // the device count on a device-type page) land on the pre-filtered table.
  // Omit the key when absent so `type` stays optional for plain navigation —
  // `{ type: undefined }` would force every `Link to="/devices"` to pass search.
  validateSearch: (search: Record<string, unknown>): { type?: string } =>
    typeof search.type === "string" ? { type: search.type } : {},
  component: DevicesPage,
})

// Stable empty fallback so `columns` (which depends on `monitoring`) doesn't get
// a fresh object identity every render while the status query is loading — that
// would rebuild the columns each render, give `filteredRows` a new identity, and
// retrigger DataTable's selection effect in a loop (devices pass
// onSelectedRowsChange for bulk deploy).
const EMPTY_MON: Record<string, BulkStatusEntry> = {}

function DevicesPage() {
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<Device | null>(null)
  const [selected, setSelected] = useState<Device[]>([])

  const { canDo, humanIds } = useMe()
  const canAdd = canDo("device", "add")
  const canEdit = canDo("device", "change")
  const canDelete = canDo("device", "delete")
  // Bulk deploy hands devices to an automation target — gate on being able to
  // see targets (the backend re-checks on the target itself).
  const canDeploy = canDo("automationtarget", "view")

  const query = useQuery({
    queryKey: ["devices", q],
    queryFn: () =>
      api<Paginated<Device>>(
        `/api/devices/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })
  const allRows = query.data?.results ?? []

  // Monitoring roll-up status for the fetched devices (separate query so the
  // api app stays decoupled from the monitoring app). Each device rolls up
  // across its assigned IPs' checks. Merged into the table as a status column.
  const deviceIds = useMemo(() => allRows.map((r) => r.id), [allRows])
  const monQuery = useQuery({
    queryKey: ["device-mon-status", deviceIds],
    // POST — a page of UUIDs makes a URL longer than proxy request-line
    // limits (gunicorn 400s at ~110 ids), which blanked the whole column.
    queryFn: () =>
      api<BulkStatusResponse>("/api/monitoring/status/", {
        method: "POST",
        body: JSON.stringify({ devices: deviceIds }),
      }),
    enabled: deviceIds.length > 0,
  })
  const monitoring = monQuery.data?.statuses ?? EMPTY_MON

  const handleDelete = useCallback((d: Device) => setDeleting(d), [])
  const columns = useMemo<ColumnDef<Device>[]>(
    () =>
      buildDeviceColumns<Device>({
        selection: true,
        humanIds,
        violations: true,
        monitoring,
        actions: {
          editTo: "/devices/$id/edit",
          editParams: (d) => ({ id: d.id }),
          canEdit: (d) => objCan(d, "change", canEdit),
          onDelete: handleDelete,
          canDelete: (d) => objCan(d, "delete", canDelete),
        },
      }),
    [handleDelete, canEdit, canDelete, monitoring, humanIds]
  )
  const { type: typeFilter } = Route.useSearch()
  const initialEnums = useMemo(
    () => (typeFilter ? { type: [typeFilter] } : undefined),
    [typeFilter]
  )
  const { rail, filteredRows } = useTableFilters(columns, allRows, initialEnums)

  return (
    <ListPageShell
      title="Devices"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter by name, serial…",
      }}
      actions={
        <>
          <TableActions ioType="device" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/devices/new">Add device</Link>
            </Button>
          )}
        </>
      }
      query={query}
    >
      <DataTable
        data={filteredRows}
        columns={columns}
        flexColumn="description"
        tableId="devices"
        initialColumnVisibility={{
          primary_ip: false,
          secondary_ip: false,
          oob_ip: false,
        }}
        onSelectedRowsChange={canDeploy ? setSelected : undefined}
      />
      <DeviceDeleteDialog
        device={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
      {canDeploy && (
        <DeviceBulkBar selected={selected} onCleared={() => setSelected([])} />
      )}
    </ListPageShell>
  )
}
