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
import { MixedStatusBadge } from "@/components/monitoring/mixed-status-badge"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader, selectionColumn } from "@/components/data-table"
import { tagsColumn } from "@/components/cells/tag-list"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { ColorBadge } from "@/components/cells/color-badge"
import { numidColumn } from "@/components/cells/numid"
import { SiteCell } from "@/components/cells/site-cell"
import { PlatformCell } from "@/components/cells/platform-cell"
import { LifecycleFlag } from "@/components/cells/lifecycle-cell"
import { useTableFilters } from "@/components/table-filters"
import { ListPageShell } from "@/components/list-page-shell"
import { StatusBadge } from "@/components/status-badge"
import { ViolationBadge } from "@/components/compliance/violation-badge"
import { DeviceDeleteDialog } from "@/components/device-delete-dialog"
import { DeviceBulkBar } from "@/components/device-bulk-bar"
import { RowActions } from "@/components/row-actions"
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
      buildColumns({
        onDelete: handleDelete,
        canEdit,
        canDelete,
        monitoring,
        humanIds,
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

// A device IP designation (primary / secondary / management), linked to its IP.
function IpRef({ ip }: { ip?: { id: string; ip_address: string } | null }) {
  if (!ip) return <span className="text-muted-foreground">—</span>
  return (
    <Link
      to="/ips/$id"
      params={{ id: ip.id }}
      className="font-mono text-xs hover:underline"
    >
      {ip.ip_address}
    </Link>
  )
}

function monitoringTooltip(e: BulkStatusEntry): string {
  const counts = e.counts ?? {}
  const parts = Object.entries(counts).map(([s, n]) => `${n} ${s}`)
  const head = `${e.monitored_ips ?? 0} monitored IP${
    e.monitored_ips === 1 ? "" : "s"
  }`
  return parts.length ? `${head} — ${parts.join(", ")}` : head
}

function buildColumns({
  onDelete,
  canEdit,
  canDelete,
  monitoring,
  humanIds,
}: {
  onDelete: (d: Device) => void
  canEdit: boolean
  canDelete: boolean
  monitoring: Record<string, BulkStatusEntry>
  humanIds: boolean
}): ColumnDef<Device>[] {
  return [
    selectionColumn<Device>(),
    ...(humanIds ? [numidColumn<Device>({ get: (r) => r.numid })] : []),
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-1.5">
          <Link
            to="/devices/$id"
            params={{ id: row.original.id }}
            className="font-mono font-medium hover:underline"
          >
            {row.original.name}
          </Link>
          <ViolationBadge objectId={row.original.id} objectType="device" />
        </span>
      ),
    },
    {
      id: "status",
      accessorFn: (r) => r.status?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Status" />,
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
      meta: {
        facet: {
          kind: "enum",
          label: "Status",
          get: (r: Device) => r.status?.id ?? "__none__",
          formatValue: (_v, r) => ({
            label: r.status?.name ?? "No status",
            color: r.status?.color,
          }),
        },
      },
    },
    {
      id: "role",
      accessorFn: (r) => r.role?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Role" />,
      cell: ({ row }) =>
        row.original.role ? (
          <ColorBadge
            name={row.original.role.name}
            color={row.original.role.color || undefined}
          />
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
      meta: {
        facet: {
          kind: "enum",
          label: "Role",
          get: (r: Device) => r.role?.id ?? "__none__",
          formatValue: (_v, r) => ({
            label: r.role?.name ?? "No role",
            color: r.role?.color,
          }),
        },
      },
    },
    {
      id: "platform",
      accessorFn: (r) => r.platform?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Platform" />,
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-1.5">
          <PlatformCell platform={row.original.platform} />
          <LifecycleFlag state={row.original.platform?.lifecycle_state} />
        </span>
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "Platform",
          get: (r: Device) => r.platform?.id ?? "__none__",
          formatValue: (_v, r) => ({
            label: r.platform?.name ?? "No platform",
          }),
        },
      },
    },
    {
      id: "type",
      accessorFn: (r) => r.device_type?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Type" />,
      cell: ({ row }) =>
        row.original.device_type ? (
          <span className="inline-flex items-center gap-1.5">
            {row.original.device_type.name}
            <LifecycleFlag state={row.original.device_type.lifecycle_state} />
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
      meta: {
        facet: {
          kind: "enum",
          label: "Type",
          get: (r: Device) => r.device_type?.id ?? "__none__",
          formatValue: (_v, r) => ({
            label: r.device_type?.name ?? "No type",
          }),
        },
      },
    },
    {
      id: "site",
      accessorFn: (r) => r.site?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Site" />,
      cell: ({ row }) => <SiteCell site={row.original.site} />,
    },
    {
      id: "serial",
      accessorKey: "serial_number",
      header: "Serial",
      cell: ({ row }) =>
        row.original.serial_number ? (
          <span className="font-mono text-xs">
            {row.original.serial_number}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "ips",
      accessorKey: "ip_count",
      header: "IPs",
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.ip_count}</span>
      ),
    },
    {
      id: "monitoring",
      header: "Monitoring",
      enableSorting: false,
      cell: ({ row }) => {
        const e = monitoring[row.original.id]
        if (!e || !e.status)
          return <span className="text-muted-foreground">—</span>
        return (
          <span title={monitoringTooltip(e)}>
            <MixedStatusBadge counts={e.counts} status={e.status} />
          </span>
        )
      },
    },
    {
      id: "primary_ip",
      accessorFn: (r) => r.primary_ip?.ip_address ?? "",
      header: "Primary IP",
      cell: ({ row }) => <IpRef ip={row.original.primary_ip} />,
    },
    {
      id: "secondary_ip",
      accessorFn: (r) => r.secondary_ip?.ip_address ?? "",
      header: "Secondary IP",
      cell: ({ row }) => <IpRef ip={row.original.secondary_ip} />,
    },
    {
      id: "oob_ip",
      accessorFn: (r) => r.oob_ip?.ip_address ?? "",
      header: "Management IP",
      cell: ({ row }) => <IpRef ip={row.original.oob_ip} />,
    },
    {
      id: "description",
      accessorKey: "description",
      header: "Description",
      cell: ({ row }) => (
        <span className="line-clamp-1 block text-muted-foreground">
          {row.original.description || "—"}
        </span>
      ),
    },
    tagsColumn<Device>({
      getTags: (r) => r.tags,
      activeSlugs: new Set<string>(),
      onToggle: () => {},
    }),
    timeAgoColumn<Device>({
      id: "updated",
      header: "Updated",
      get: (r) => r.updated_at,
      align: "right",
    }),
    {
      id: "actions",
      enableHiding: false,
      cell: ({ row }) => (
        <RowActions
          editTo={
            objCan(row.original, "change", canEdit)
              ? "/devices/$id/edit"
              : undefined
          }
          editParams={{ id: row.original.id }}
          onDelete={
            objCan(row.original, "delete", canDelete)
              ? () => onDelete(row.original)
              : undefined
          }
        />
      ),
    },
  ]
}
