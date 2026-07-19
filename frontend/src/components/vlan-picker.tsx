import { useMemo } from "react"

import type { VLAN, VLANOption } from "@/lib/api"
import {
  ObjectPicker,
  type ObjectPickerProps,
  type ObjectPickerSpec,
} from "@/components/object-picker"
export interface VlanPickerProps extends Omit<ObjectPickerProps, "label"> {
  label?: string
}

/** The VLAN preset of ObjectPicker — options read "100 · users", advanced
 * search by site / group (server-side, matches the VLAN list filters). */
export function VlanPicker({ label = "VLAN", ...rest }: VlanPickerProps) {
  const spec = useMemo<ObjectPickerSpec<VLAN, VLANOption>>(
    () => ({
      noun: "VLAN",
      pickerEndpoint: "/api/vlans/?picker=1",
      pickerQueryKey: ["vlans-picker"],
      optionLabel: (v) => `${v.vlan_id} · ${v.name}`,
      detailEndpoint: (id) => `/api/vlans/${id}/`,
      detailQueryKey: (id) => ["vlan", id],
      detailLabel: (v) => `${v.vlan_id} · ${v.name}`,
      listEndpoint: "/api/vlans/",
      searchHint: "Search VLAN ID, name, description…",
      filters: [
        {
          key: "site",
          label: "Site",
          endpoint: "/api/sites/?picker=1",
          queryKey: "sites-picker",
        },
        {
          key: "group",
          label: "Group",
          endpoint: "/api/vlan-groups/",
          queryKey: "vlan-groups-picker",
        },
      ],
      columns: [
        {
          header: "VID",
          cell: (v) => <span className="num">{v.vlan_id}</span>,
        },
        { header: "Name", cell: (v) => v.name },
        {
          header: "Site",
          cell: (v) => (
            <span className="text-muted-foreground">
              {v.site?.name ?? "Global"}
            </span>
          ),
        },
        {
          header: "Group",
          cell: (v) => (
            <span className="text-muted-foreground">
              {v.group?.name ?? "—"}
            </span>
          ),
        },
      ],
    }),
    []
  )
  return <ObjectPicker<VLAN, VLANOption> spec={spec} label={label} {...rest} />
}
