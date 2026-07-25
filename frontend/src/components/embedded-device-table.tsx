import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"

import { api, type Device, type Paginated } from "@/lib/api"
import { DataTable } from "@/components/data-table"
import { useDriftMap } from "@/components/monitoring/device-drift-badge"
import { buildDeviceColumns } from "@/components/columns/device-columns"
import { QueryError } from "@/components/query-error"

/**
 * The Devices table, embedded on a related object's detail page (device type,
 * role, platform, manufacturer, site, location…). `filter` is the
 * /api/devices/ query params that scope it — e.g. {device_type: id}. Replaces
 * the old "N devices · View devices →" links: the data loads in place.
 *
 * Columns come from the shared device factory, so a device row here reads
 * exactly like the same device on /devices.
 */
export function EmbeddedDeviceTable({
  filter,
  emptyText = "No devices.",
}: {
  filter: Record<string, string>
  emptyText?: string
}) {
  const qs = useMemo(() => {
    const p = new URLSearchParams({ ...filter, page_size: "500" })
    return p.toString()
  }, [filter])

  const q = useQuery({
    queryKey: ["embedded-devices", qs],
    queryFn: () => api<Paginated<Device>>(`/api/devices/?${qs}`),
  })
  const rows = q.data?.results ?? []

  const driftMap = useDriftMap()
  const columns = useMemo<ColumnDef<Device>[]>(
    () =>
      buildDeviceColumns({
        include: ["name", "status", "role", "type", "site", "primary_ip"],
        violations: true,
        drift: driftMap,
      }),
    [driftMap]
  )

  if (q.isError) return <QueryError error={q.error} />
  if (q.isLoading)
    return <p className="text-sm text-muted-foreground">Loading devices…</p>
  if (rows.length === 0)
    return <p className="text-sm text-muted-foreground">{emptyText}</p>

  return (
    <DataTable
      data={rows}
      columns={columns}
      flexColumn="type"
      tableId="embedded-devices"
    />
  )
}
