import type { ColumnDef } from "@tanstack/react-table"

import type { Device, DeviceRole, DeviceType } from "@/lib/api"
import { buildDeviceColumns } from "@/components/columns/device-columns"
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
    // The device-type row itself is the shared factory's — this table only adds
    // the monitoring binding control.
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
