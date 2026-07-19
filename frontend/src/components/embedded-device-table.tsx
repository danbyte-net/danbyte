import { useMemo } from "react"
import { dash } from "@/components/cells/dash"
import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"

import { api, type Device, type Paginated } from "@/lib/api"
import { DataTable, SortHeader } from "@/components/data-table"
import { ColorBadge } from "@/components/cells/color-badge"
import { StatusBadge } from "@/components/status-badge"
import { QueryError } from "@/components/query-error"

/**
 * The Devices table, embedded on a related object's detail page (device type,
 * role, platform, manufacturer, site, location…). `filter` is the
 * /api/devices/ query params that scope it — e.g. {device_type: id}. Replaces
 * the old "N devices · View devices →" links: the data loads in place.
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

  const columns = useMemo<ColumnDef<Device>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: ({ column }) => <SortHeader column={column} label="Name" />,
        cell: ({ row }) => (
          <Link
            to="/devices/$id"
            params={{ id: row.original.id }}
            className="font-mono font-medium hover:underline"
          >
            {row.original.name}
          </Link>
        ),
      },
      {
        id: "status",
        header: ({ column }) => <SortHeader column={column} label="Status" />,
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
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
            dash
          ),
      },
      {
        id: "type",
        accessorFn: (r) => r.device_type?.name ?? "",
        header: "Type",
        cell: ({ row }) =>
          row.original.device_type ? (
            <span className="text-xs">{row.original.device_type.name}</span>
          ) : (
            dash
          ),
      },
      {
        id: "site",
        accessorFn: (r) => r.site?.name ?? "",
        header: "Site",
        cell: ({ row }) =>
          row.original.site ? (
            <Link
              to="/sites/$id"
              params={{ id: row.original.site.id }}
              className="text-xs text-primary hover:underline"
            >
              {row.original.site.name}
            </Link>
          ) : (
            dash
          ),
      },
      {
        id: "primary_ip",
        accessorFn: (r) => r.primary_ip?.ip_address ?? "",
        header: "Primary IP",
        cell: ({ row }) =>
          row.original.primary_ip ? (
            <Link
              to="/ips/$id"
              params={{ id: row.original.primary_ip.id }}
              className="font-mono text-xs text-primary hover:underline"
            >
              {row.original.primary_ip.ip_address}
            </Link>
          ) : (
            dash
          ),
      },
    ],
    []
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
