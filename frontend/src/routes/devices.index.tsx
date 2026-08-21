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
import { useDriftMap } from "@/components/monitoring/device-drift-badge"
import { usePlannedChangeMap } from "@/components/planning/planned-change-badge"
import { buildDeviceColumns } from "@/components/columns/device-columns"
import { useTableFilters } from "@/components/table-filters"
import { ListPageShell } from "@/components/list-page-shell"
import { DeviceDeleteDialog } from "@/components/device-delete-dialog"
import { DeviceBulkBar } from "@/components/device-bulk-bar"
import { useMe, objCan } from "@/lib/use-me"

export const Route = createFileRoute("/devices/")({
  // Facet seeds from cross-object / dashboard deep-links, e.g. the "Devices by
  // status / type / site / manufacturer" dashboard cards. Keys are optional so a
  // plain `Link to="/devices"` never has to pass search.
  validateSearch: (
    search: Record<string, unknown>
  ): {
    type?: string
    status?: string
    site?: string
    manufacturer?: string
  } => {
    const out: {
      type?: string
      status?: string
      site?: string
      manufacturer?: string
    } = {}
    if (typeof search.type === "string") out.type = search.type
    if (typeof search.status === "string") out.status = search.status
    if (typeof search.site === "string") out.site = search.site
    if (typeof search.manufacturer === "string")
      out.manufacturer = search.manufacturer
    return out
  },
  component: DevicesPage,
})

// Stable empty fallback so `columns` (which depends on `monitoring`) doesn't get
// a fresh object identity every render while the status query is loading - that
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
  // Bulk deploy hands devices to an automation target - gate on being able to
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
    // POST - a page of UUIDs makes a URL longer than proxy request-line
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
  const driftMap = useDriftMap()
  const plannedMap = usePlannedChangeMap()
  // One roll-up request feeds the whole table's "Ports" bars.
  const portUtilQuery = useQuery({
    queryKey: ["port-utilization-rollup"],
    queryFn: () =>
      api<{ results: { id: string; pct: number }[] }>(
        "/api/devices/port-utilization/"
      ),
    staleTime: 60_000,
  })
  const portUtil = useMemo(
    () =>
      new Map(
        (portUtilQuery.data?.results ?? []).map((r) => [r.id, r.pct] as const)
      ),
    [portUtilQuery.data]
  )
  const columns = useMemo<ColumnDef<Device>[]>(
    () =>
      buildDeviceColumns<Device>({
        selection: true,
        humanIds,
        violations: true,
        drift: driftMap,
        planned: plannedMap,
        monitoring,
        portUtil,
        actions: {
          editTo: "/devices/$id/edit",
          editParams: (d) => ({ id: d.id }),
          canEdit: (d) => objCan(d, "change", canEdit),
          onDelete: handleDelete,
          canDelete: (d) => objCan(d, "delete", canDelete),
        },
      }),
    [handleDelete, canEdit, canDelete, monitoring, humanIds, portUtil]
  )
  const {
    type: typeFilter,
    status: statusFilter,
    site: siteFilter,
    manufacturer: manufacturerFilter,
  } = Route.useSearch()
  const initialEnums = useMemo(() => {
    const seed: Record<string, string[]> = {}
    if (typeFilter) seed.type = [typeFilter]
    if (statusFilter) seed.status = [statusFilter]
    if (siteFilter) seed.site = [siteFilter]
    if (manufacturerFilter) seed.manufacturer = [manufacturerFilter]
    return Object.keys(seed).length ? seed : undefined
  }, [typeFilter, statusFilter, siteFilter, manufacturerFilter])
  const { rail, filteredRows, snapshot, restore, activeCount } =
    useTableFilters(columns, allRows, initialEnums)

  return (
    <ListPageShell
      title="Devices"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      savedViews={{
        objectType: "device",
        filters: { snapshot, restore, activeCount },
      }}
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
