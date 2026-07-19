import { Link } from "@tanstack/react-router"
import type { ColumnDef } from "@tanstack/react-table"

import type { Device, DeviceRole, DeviceType } from "@/lib/api"
import { SortHeader } from "@/components/data-table"
import { dash } from "@/components/cells/dash"
import { ColorBadge } from "@/components/cells/color-badge"
import { ManufacturerCell } from "@/components/cells/manufacturer-cell"
import { PlatformCell } from "@/components/cells/platform-cell"
import { SiteCell } from "@/components/cells/site-cell"
import { tagsColumn } from "@/components/cells/tag-list"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { StatusBadge } from "@/components/status-badge"
import {
  monitoringControlColumn,
  type PolicyColumnContext,
} from "./policy-table"

type EnumMeta<T> = NonNullable<ColumnDef<T>["meta"]>

export function enumFacet<T>(
  label: string,
  get: (row: T) => string,
  format: (row: T) => { label: string; color?: string; textColor?: string }
): EnumMeta<T> {
  return {
    facet: {
      kind: "enum",
      label,
      get,
      formatValue: (_value, row) => format(row),
    },
  }
}

export function IpRef({
  ip,
}: {
  ip: { id: string; ip_address: string; dns_name?: string } | null | undefined
}) {
  if (!ip) return dash
  return (
    <Link
      to="/ips/$id"
      params={{ id: ip.id }}
      className="font-mono text-xs text-primary hover:underline"
      title={ip.dns_name || undefined}
    >
      {ip.ip_address}
    </Link>
  )
}

export function buildDevicePolicyColumns({
  controls,
}: PolicyColumnContext<Device>): ColumnDef<Device>[] {
  return [
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
      accessorFn: (r) => r.status?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Status" />,
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
      meta: enumFacet<Device>(
        "Status",
        (row) => row.status?.id ?? "__none__",
        (row) => ({
          label: row.status?.name ?? "No status",
          color: row.status?.color,
          textColor: row.status?.text_color,
        })
      ),
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
      meta: enumFacet<Device>(
        "Role",
        (row) => row.role?.id ?? "__none__",
        (row) => ({
          label: row.role?.name ?? "No role",
          color: row.role?.color,
        })
      ),
    },
    {
      id: "platform",
      accessorFn: (r) => r.platform?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Platform" />,
      cell: ({ row }) => <PlatformCell platform={row.original.platform} />,
      meta: enumFacet<Device>(
        "Platform",
        (row) => row.platform?.id ?? "__none__",
        (row) => ({
          label: row.platform?.name ?? "No platform",
        })
      ),
    },
    {
      id: "type",
      accessorFn: (r) => r.device_type?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Type" />,
      cell: ({ row }) => row.original.device_type?.name ?? dash,
      meta: enumFacet<Device>(
        "Type",
        (row) => row.device_type?.id ?? "__none__",
        (row) => ({
          label: row.device_type?.name ?? "No type",
        })
      ),
    },
    {
      id: "site",
      accessorFn: (r) => r.site?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Site" />,
      cell: ({ row }) => <SiteCell site={row.original.site} />,
      meta: enumFacet<Device>(
        "Site",
        (row) => row.site?.id ?? "__none__",
        (row) => ({
          label: row.site?.name ?? "No site",
        })
      ),
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
          dash
        ),
    },
    {
      id: "ips",
      accessorKey: "ip_count",
      header: "IPs",
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.ip_count}</span>
      ),
      meta: {
        facet: {
          kind: "range",
          label: "IPs",
          get: (row: Device) => row.ip_count,
          min: 0,
        },
      },
    },
    {
      id: "primary_ip",
      accessorFn: (r) => r.primary_ip?.ip_address ?? "",
      header: "Primary IP",
      cell: ({ row }) => <IpRef ip={row.original.primary_ip} />,
    },
    {
      id: "description",
      accessorKey: "description",
      header: "Description",
      cell: ({ row }) => (
        <span className="line-clamp-1 block max-w-[34ch] text-muted-foreground">
          {row.original.description || "—"}
        </span>
      ),
    },
    tagsColumn<Device>({ getTags: (r) => r.tags }),
    timeAgoColumn<Device>({
      id: "updated",
      header: "Updated",
      get: (r) => r.updated_at,
      align: "right",
    }),
    monitoringControlColumn(controls),
  ]
}

export function buildDeviceTypePolicyColumns({
  controls,
}: PolicyColumnContext<DeviceType>): ColumnDef<DeviceType>[] {
  return [
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
      id: "manufacturer",
      accessorFn: (r) => r.manufacturer?.name ?? "",
      header: ({ column }) => (
        <SortHeader column={column} label="Manufacturer" />
      ),
      cell: ({ row }) => (
        <ManufacturerCell manufacturer={row.original.manufacturer} />
      ),
      meta: enumFacet<DeviceType>(
        "Manufacturer",
        (row) => row.manufacturer?.id ?? "__none__",
        (row) => ({
          label: row.manufacturer?.name ?? "No manufacturer",
        })
      ),
    },
    {
      id: "model",
      accessorKey: "model",
      header: "Model",
      cell: ({ row }) =>
        row.original.model ? (
          <span className="font-mono text-xs">{row.original.model}</span>
        ) : (
          dash
        ),
    },
    {
      id: "u_height",
      accessorKey: "u_height",
      header: ({ column }) => <SortHeader column={column} label="U" />,
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.u_height}U</span>
      ),
      meta: {
        facet: {
          kind: "range",
          label: "U",
          get: (row: DeviceType) => row.u_height,
          min: 0,
          unit: "U",
        },
      },
    },
    {
      id: "devices",
      accessorKey: "device_count",
      header: ({ column }) => <SortHeader column={column} label="Devices" />,
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.device_count}</span>
      ),
      meta: {
        facet: {
          kind: "range",
          label: "Devices",
          get: (row: DeviceType) => row.device_count,
          min: 0,
        },
      },
    },
    {
      id: "description",
      accessorKey: "description",
      header: "Description",
      cell: ({ row }) => (
        <span className="line-clamp-1 block max-w-[34ch] text-muted-foreground">
          {row.original.description || "—"}
        </span>
      ),
    },
    tagsColumn<DeviceType>({ getTags: (r) => r.tags }),
    timeAgoColumn<DeviceType>({
      id: "updated",
      header: "Updated",
      get: (r) => r.updated_at,
      align: "right",
    }),
    monitoringControlColumn(controls),
  ]
}

export function buildDeviceRolePolicyColumns({
  controls,
}: PolicyColumnContext<DeviceRole>): ColumnDef<DeviceRole>[] {
  return [
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <Link
          to="/device-roles/$id"
          params={{ id: row.original.id }}
          className="hover:opacity-90"
        >
          <ColorBadge
            name={row.original.name}
            color={row.original.color || undefined}
          />
        </Link>
      ),
    },
    {
      id: "description",
      accessorKey: "description",
      header: "Description",
      cell: ({ row }) => (
        <span className="line-clamp-1 block max-w-[34ch] text-muted-foreground">
          {row.original.description || "—"}
        </span>
      ),
    },
    {
      id: "devices",
      accessorKey: "device_count",
      header: ({ column }) => <SortHeader column={column} label="Devices" />,
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.device_count}</span>
      ),
      meta: {
        facet: {
          kind: "range",
          label: "Devices",
          get: (row: DeviceRole) => row.device_count,
          min: 0,
        },
      },
    },
    {
      id: "vms",
      accessorKey: "vm_count",
      header: ({ column }) => <SortHeader column={column} label="VMs" />,
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.vm_count}</span>
      ),
      meta: {
        facet: {
          kind: "range",
          label: "VMs",
          get: (row: DeviceRole) => row.vm_count,
          min: 0,
        },
      },
    },
    timeAgoColumn<DeviceRole>({
      id: "updated",
      header: "Updated",
      get: (r) => r.updated_at,
      align: "right",
    }),
    monitoringControlColumn(controls),
  ]
}
