import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"

import { api, type DeviceType, type Paginated } from "@/lib/api"
import { buildDeviceTypeColumns } from "@/components/columns/device-type-columns"
import { DataTable } from "@/components/data-table"
import { QueryError } from "@/components/query-error"

/** The Device types table, embedded on a related object's detail page
 * (manufacturer). `filter` scopes it, e.g. {manufacturer: id}. */
export function EmbeddedDeviceTypeTable({
  filter,
  emptyText = "No device types.",
}: {
  filter: Record<string, string>
  emptyText?: string
}) {
  const qs = useMemo(
    () => new URLSearchParams({ ...filter, page_size: "500" }).toString(),
    [filter]
  )
  const q = useQuery({
    queryKey: ["embedded-device-types", qs],
    queryFn: () => api<Paginated<DeviceType>>(`/api/device-types/?${qs}`),
  })
  const rows = q.data?.results ?? []

  const columns = useMemo<ColumnDef<DeviceType>[]>(
    () =>
      buildDeviceTypeColumns<DeviceType>({
        include: ["name", "part_number", "u_height", "devices"],
        heightHeader: "Height",
      }),
    []
  )

  if (q.isError) return <QueryError error={q.error} />
  if (q.isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>
  if (rows.length === 0)
    return <p className="text-sm text-muted-foreground">{emptyText}</p>

  return (
    <DataTable
      data={rows}
      columns={columns}
      flexColumn="name"
      tableId="embedded-device-types"
    />
  )
}
