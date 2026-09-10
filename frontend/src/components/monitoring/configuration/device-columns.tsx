import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type {
  Device,
  DeviceRole,
  DeviceType,
  Platform,
  Region,
  Site,
} from "@/lib/api"
import { SortHeader } from "@/components/data-table"
import { buildDeviceColumns } from "@/components/columns/device-columns"
import { buildSiteColumns } from "@/components/columns/site-columns"
import { buildDeviceRoleColumns } from "@/components/columns/device-role-columns"
import { buildDeviceTypeColumns } from "@/components/columns/device-type-columns"
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
    // The device row itself is the shared factory's - this table only adds the
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
    // The device-type row itself is the shared factory's - this table only adds
    // the monitoring binding control. As with roles, this tab filters the
    // device count by range rather than the list page's in-use / unused split.
    ...buildDeviceTypeColumns({
      include: [
        "name",
        "manufacturer",
        "model",
        "u_height",
        "devices",
        "description",
        "tags",
        "updated",
      ],
      countFacets: "range",
    }),
    monitoringControlColumn(controls),
  ]
}

export function buildDeviceRolePolicyColumns({
  controls,
}: PolicyColumnContext<DeviceRole>): ColumnDef<DeviceRole>[] {
  return [
    // The role row itself is the shared factory's; this tab filters the counts
    // by range rather than the list page's in-use / unused split.
    ...buildDeviceRoleColumns({
      include: ["name", "description", "devices", "vms", "updated"],
      countFacets: "range",
    }),
    monitoringControlColumn(controls),
  ]
}

export function buildSitePolicyColumns({
  controls,
}: PolicyColumnContext<Site>): ColumnDef<Site>[] {
  return [
    ...buildSiteColumns<Site>({
      omit: ["gateway_policy", "vlans", "vrfs", "tags"],
    }),
    monitoringControlColumn(controls),
  ]
}

/** Regions and platforms have no shared column factory, so these are the two
 * columns a policy tab actually needs - name, and what it contains. */
export function buildRegionPolicyColumns({
  controls,
}: PolicyColumnContext<Region>): ColumnDef<Region>[] {
  return [
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Region" />,
      cell: ({ row }) => (
        <Link to="/regions/$id" params={{ id: row.original.id }} className="link">
          {row.original.name}
        </Link>
      ),
    },
    {
      id: "parent",
      header: "Parent",
      enableSorting: false,
      cell: ({ row }) =>
        row.original.parent?.name ?? (
          <span className="text-muted-foreground">-</span>
        ),
    },
    {
      id: "description",
      accessorKey: "description",
      header: "Description",
      enableSorting: false,
    },
    monitoringControlColumn(controls),
  ]
}

export function buildPlatformPolicyColumns({
  controls,
}: PolicyColumnContext<Platform>): ColumnDef<Platform>[] {
  return [
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Platform" />,
      cell: ({ row }) => (
        <Link
          to="/platforms/$id"
          params={{ id: row.original.id }}
          className="link"
        >
          {row.original.name}
        </Link>
      ),
    },
    {
      id: "description",
      accessorKey: "description",
      header: "Description",
      enableSorting: false,
    },
    monitoringControlColumn(controls),
  ]
}
