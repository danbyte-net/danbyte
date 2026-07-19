import { useMemo } from "react"
import { dash } from "@/components/cells/dash"
import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"

import { api, type DeviceType, type Paginated } from "@/lib/api"
import { DataTable, SortHeader } from "@/components/data-table"
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
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: ({ column }) => <SortHeader column={column} label="Name" />,
        cell: ({ row }) => (
          <Link
            to="/device-types/$id"
            params={{ id: row.original.id }}
            className="font-medium hover:underline"
          >
            {row.original.name}
          </Link>
        ),
      },
      {
        id: "part_number",
        accessorKey: "part_number",
        header: "Part number",
        cell: ({ row }) =>
          row.original.part_number ? (
            <span className="font-mono text-xs">
              {row.original.part_number}
            </span>
          ) : (
            dash
          ),
      },
      {
        id: "u_height",
        accessorKey: "u_height",
        header: ({ column }) => <SortHeader column={column} label="Height" />,
        cell: ({ row }) => (
          <span className="num text-xs">{row.original.u_height}U</span>
        ),
      },
      {
        id: "devices",
        accessorKey: "device_count",
        header: ({ column }) => <SortHeader column={column} label="Devices" />,
        cell: ({ row }) => (
          <span className="num text-xs">{row.original.device_count}</span>
        ),
      },
    ],
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
