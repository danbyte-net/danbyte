import { useMemo } from "react"

import type { Cabinet, CabinetOption } from "@/lib/api"
import { ColorBadge } from "@/components/cells/color-badge"
import { ObjectPicker } from "@/components/object-picker"
import type {
  ObjectPickerProps,
  ObjectPickerSpec,
} from "@/components/object-picker"

export interface CabinetPickerProps extends Omit<ObjectPickerProps, "label"> {
  label?: string
  /** Only cabinets at this site - in the list, and as the search's starting
   * filter. Every cabinet when null. */
  siteId?: string | null
}

const DASH = <span className="text-muted-foreground">-</span>

/** The cabinet preset of ObjectPicker - search by site / location / role,
 * result table with the plate and its rails. */
export function CabinetPicker({
  label = "Cabinet",
  siteId,
  ...rest
}: CabinetPickerProps) {
  const spec = useMemo<ObjectPickerSpec<Cabinet, CabinetOption>>(
    () => ({
      noun: "cabinet",
      pickerEndpoint: `/api/cabinets/?picker=1${siteId ? `&site=${siteId}` : ""}`,
      pickerQueryKey: ["cabinets-picker", ...(siteId ? ["site", siteId] : [])],
      // Names are unique per site only: across sites, say which.
      optionLabel: (o) => (siteId ? o.name : `${o.name} · ${o.site.name}`),
      detailEndpoint: (id) => `/api/cabinets/${id}/`,
      detailQueryKey: (id) => ["cabinet", id],
      listEndpoint: "/api/cabinets/",
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
        {
          key: "role",
          label: "Role",
          endpoint: "/api/cabinet-roles/?picker=1",
          queryKey: "cabinet-roles-picker",
        },
      ],
      columns: [
        { header: "Name", cell: (c) => c.name },
        {
          header: "Site",
          cell: (c) => (
            <span className="text-muted-foreground">{c.site.name}</span>
          ),
        },
        {
          header: "Role",
          cell: (c) =>
            c.role ? (
              <ColorBadge
                name={c.role.name}
                color={c.role.color || undefined}
              />
            ) : (
              DASH
            ),
        },
        {
          header: "Rails",
          cell: (c) => <span className="num">{c.rails.length}</span>,
        },
      ],
    }),
    [siteId]
  )
  return (
    <ObjectPicker<Cabinet, CabinetOption>
      spec={spec}
      label={label}
      initialFilters={siteId ? { site: siteId } : undefined}
      {...rest}
    />
  )
}
