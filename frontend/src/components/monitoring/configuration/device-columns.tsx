import { Link } from "@tanstack/react-router"
import type { ColumnDef } from "@tanstack/react-table"

import type { Device, DeviceRole, DeviceType } from "@/lib/api"
import { SortHeader } from "@/components/data-table"
import { dash } from "@/components/cells/dash"
import { ColorBadge } from "@/components/cells/color-badge"
import { manufacturerColumn } from "@/components/cells/manufacturer-cell"
import { tagsColumn } from "@/components/cells/tag-list"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { buildDeviceColumns } from "@/components/columns/device-columns"
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

export function buildDevicePolicyColumns({
  controls,
}: PolicyColumnContext<Device>): ColumnDef<Device>[] {
  return [
    // The device row itself is the shared factory's — this table only adds the
    // monitoring binding control.
    ...buildDeviceColumns({
      include: [
        "name",
        "status",
        "role",
        "platform",
        "type",
        "site",
        "serial",
        "ips",
        "primary_ip",
        "description",
        "tags",
        "updated",
      ],
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
    manufacturerColumn<DeviceType>({ get: (r) => r.manufacturer }),
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
