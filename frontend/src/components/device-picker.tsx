import { useMemo } from "react"

import type { Device } from "@/lib/api"
import { ColorBadge } from "@/components/cells/color-badge"
import {
  ObjectPicker,
  type ObjectPickerProps,
  type ObjectPickerSpec,
} from "@/components/object-picker"
import { StatusBadge } from "@/components/status-badge"

export interface DevicePickerProps extends Omit<ObjectPickerProps, "label"> {
  /** Field label (defaults to "Device"). */
  label?: string
  /** Ghost (show disabled, with an "in <stack>" hint) any device that already
   * belongs to a virtual chassis — a switch can only be in one stack. */
  ghostAssignedVc?: boolean
}

/** ?picker=1&with_vc=1 shape — the compact option plus its current stack. */
interface DeviceVcOption {
  id: string
  name: string
  virtual_chassis?: { id: string; name: string } | null
}

const DASH = <span className="text-muted-foreground">—</span>

/**
 * The device preset of ObjectPicker — searchable combobox + advanced-search
 * modal (tag / manufacturer / type / role / status / site / location /
 * region, all server-side). Drop-in for the old FormCombobox pattern.
 */
export function DevicePicker({
  label = "Device",
  ghostAssignedVc,
  ...rest
}: DevicePickerProps) {
  const spec = useMemo<ObjectPickerSpec<Device, DeviceVcOption>>(
    () => ({
      noun: "device",
      // With ghosting on we need each device's stack, so fetch the with_vc
      // picker shape under its own cache key (no collision with the plain
      // list every other form shares).
      pickerEndpoint: ghostAssignedVc
        ? "/api/devices/?picker=1&with_vc=1"
        : "/api/devices/?picker=1",
      pickerQueryKey: ghostAssignedVc
        ? ["devices-picker", "with-vc"]
        : ["devices-picker"],
      optionState: ghostAssignedVc
        ? (o) =>
            o.virtual_chassis
              ? { disabled: true, hint: `in ${o.virtual_chassis.name}` }
              : {}
        : undefined,
      detailEndpoint: (id) => `/api/devices/${id}/`,
      detailQueryKey: (id) => ["device", id],
      listEndpoint: "/api/devices/",
      searchHint: "Search name, serial, asset tag, description…",
      filters: [
        {
          key: "tag",
          label: "Tag",
          endpoint: "/api/tags/",
          queryKey: "tags-picker",
          paramOf: (t: { slug: string }) => t.slug,
        },
        {
          key: "manufacturer",
          label: "Manufacturer",
          endpoint: "/api/manufacturers/?picker=1",
          queryKey: "manufacturers-picker",
        },
        {
          key: "device_type",
          label: "Type",
          endpoint: "/api/device-types/?picker=1",
          queryKey: "device-types-picker",
        },
        {
          key: "role",
          label: "Role",
          endpoint: "/api/device-roles/?picker=1",
          queryKey: "device-roles-picker",
        },
        {
          key: "status",
          label: "Status",
          endpoint: "/api/statuses/?available_to=device&picker=1",
          queryKey: "device-statuses-picker",
        },
        {
          key: "site",
          label: "Site",
          endpoint: "/api/sites/?picker=1",
          queryKey: "sites-picker",
        },
        {
          key: "location",
          label: "Location",
          endpoint: "/api/locations/?picker=1",
          queryKey: "locations-picker",
        },
        {
          key: "region",
          label: "Region",
          endpoint: "/api/regions/?picker=1",
          queryKey: "regions-picker",
        },
      ],
      columns: [
        { header: "Name", cell: (d) => d.name },
        {
          header: "Type",
          cell: (d) => (
            <span className="text-muted-foreground">
              {d.device_type?.name ?? "—"}
            </span>
          ),
        },
        {
          header: "Role",
          cell: (d) =>
            d.role ? (
              <ColorBadge
                name={d.role.name}
                color={d.role.color || undefined}
              />
            ) : (
              DASH
            ),
        },
        {
          header: "Site",
          cell: (d) => (
            <span className="text-muted-foreground">{d.site?.name ?? "—"}</span>
          ),
        },
        { header: "Status", cell: (d) => <StatusBadge status={d.status} /> },
      ],
      rowState: ghostAssignedVc
        ? (d) =>
            d.virtual_chassis
              ? { disabled: true, note: `in ${d.virtual_chassis.name}` }
              : {}
        : undefined,
    }),
    [ghostAssignedVc]
  )

  return (
    <ObjectPicker<Device, DeviceVcOption> spec={spec} label={label} {...rest} />
  )
}
