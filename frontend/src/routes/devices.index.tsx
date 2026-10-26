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
} from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { useDriftMap } from "@/components/monitoring/device-drift-badge"
import { usePrtgDeviceStates } from "@/components/columns/prtg-columns"
import { usePlannedChangeMap } from "@/components/planning/planned-change-badge"
import { buildDeviceColumns } from "@/components/columns/device-columns"
import { useEolSettings } from "@/components/cells/eol-cell"
import { useUrlTableFilters } from "@/components/table-filters"
import {
  AvailabilityFramePicker,
  useSlaStatus,
} from "@/components/monitoring/sla-status"
import { ListPageShell } from "@/components/list-page-shell"
import { DeviceDeleteDialog } from "@/components/device-delete-dialog"
import { DeviceBulkBar } from "@/components/device-bulk-bar"
import { useMe, objCan } from "@/lib/use-me"
import { useUrlSearch } from "@/lib/url-filters"

export const Route = createFileRoute("/devices/")({
  // Typed deep-link params, e.g. the "Devices by status / type / site /
  // manufacturer" dashboard cards. They are the live facet params (the rail
  // reads every filter from the URL), declared here so links type-check. Keys
  // are optional so a plain `Link to="/devices"` never has to pass search.
  validateSearch: (
    search: Record<string, unknown>
  ): {
    type?: string
    status?: string
    site?: string
    manufacturer?: string
    coverage?: string
    platform?: string
    role?: string
    software_version?: string
  } => {
    const out: {
      type?: string
      status?: string
      site?: string
      manufacturer?: string
      coverage?: string
      platform?: string
      role?: string
      software_version?: string
    } = {}
    if (typeof search.type === "string") out.type = search.type
    if (typeof search.status === "string") out.status = search.status
    if (typeof search.site === "string") out.site = search.site
    if (typeof search.manufacturer === "string")
      out.manufacturer = search.manufacturer
    // Support coverage status (#421), from the Support coverage widget.
    if (typeof search.coverage === "string") out.coverage = search.coverage
    // Lifecycle → Versions (#451): a platform and version's devices.
    if (typeof search.platform === "string") out.platform = search.platform
    if (typeof search.role === "string") out.role = search.role
    if (typeof search.software_version === "string")
      out.software_version = search.software_version
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
  const [q, setQ] = useUrlSearch()
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
      apiAll<Device>(
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
  const sla = useSlaStatus("device", deviceIds)
  const prtg = usePrtgDeviceStates()

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
  const { enabled: eolOn } = useEolSettings()
  const columns = useMemo<ColumnDef<Device>[]>(
    () =>
      buildDeviceColumns<Device>({
        selection: true,
        humanIds,
        eol: eolOn,
        violations: true,
        drift: driftMap,
        planned: plannedMap,
        monitoring,
        prtg,
        sla: { entries: sla.entries, frame: sla.frame },
        portUtil,
        actions: {
          editTo: "/devices/$id/edit",
          editParams: (d) => ({ id: d.id }),
          canEdit: (d) => objCan(d, "change", canEdit),
          onDelete: handleDelete,
          canDelete: (d) => objCan(d, "delete", canDelete),
        },
      }),
    [
      handleDelete,
      canEdit,
      canDelete,
      monitoring,
      prtg,
      humanIds,
      eolOn,
      portUtil,
      sla.entries,
      sla.frame,
    ]
  )
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
          <AvailabilityFramePicker value={sla.frame} onChange={sla.setFrame} />
          <TableActions ioType="device" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/devices/new">Add device</Link>
            </Button>
          )}
        </>
      }
      query={query}
      page={query.data}
    >
      <DataTable
        data={filteredRows}
        columns={wiredColumns}
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
