import { useMemo } from "react"

import type { Rack } from "@/lib/api"
import {
  ObjectPicker,
  type ObjectPickerProps,
  type ObjectPickerSpec,
} from "@/components/object-picker"

export interface RackPickerProps extends Omit<ObjectPickerProps, "label"> {
  label?: string
}

/** The rack preset of ObjectPicker — advanced search by site / location,
 * result table with height + utilisation. */
export function RackPicker({ label = "Rack", ...rest }: RackPickerProps) {
  const spec = useMemo<ObjectPickerSpec<Rack>>(
    () => ({
      noun: "rack",
      pickerEndpoint: "/api/racks/?picker=1",
      pickerQueryKey: ["racks-picker"],
      detailEndpoint: (id) => `/api/racks/${id}/`,
      detailQueryKey: (id) => ["rack", id],
      listEndpoint: "/api/racks/",
      searchHint: "Search name, facility ID…",
      filters: [
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
      ],
      columns: [
        { header: "Name", cell: (r) => r.name },
        {
          header: "Site",
          cell: (r) => (
            <span className="text-muted-foreground">{r.site.name}</span>
          ),
        },
        {
          header: "Location",
          cell: (r) => (
            <span className="text-muted-foreground">
              {r.location?.name ?? "—"}
            </span>
          ),
        },
        {
          header: "Height",
          cell: (r) => <span className="num">{r.u_height}U</span>,
        },
        {
          header: "Used",
          cell: (r) => (
            <span className="num">
              {r.used_units} / {r.u_height} U
            </span>
          ),
        },
      ],
    }),
    []
  )
  return <ObjectPicker<Rack> spec={spec} label={label} {...rest} />
}
