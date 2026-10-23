import { useMemo } from "react"

import type { Application, ApplicationMini } from "@/lib/api"
import { ObjectPicker } from "@/components/object-picker"
import type {
  ObjectPickerProps,
  ObjectPickerSpec,
} from "@/components/object-picker"

export interface ApplicationPickerProps extends Omit<
  ObjectPickerProps,
  "label"
> {
  label?: string
}

const ENDPOINT = "/api/applications/"

/** The application preset of ObjectPicker (#436). Options read as the tree
 * path, "Payments › Checkout › checkout-api". */
export function ApplicationPicker({
  label = "Application",
  ...rest
}: ApplicationPickerProps) {
  const spec = useMemo<ObjectPickerSpec<Application, ApplicationMini>>(
    () => ({
      noun: "application",
      pickerEndpoint: `${ENDPOINT}?picker=1`,
      pickerQueryKey: ["applications-picker"],
      optionLabel: (a) => a.path || a.name,
      detailEndpoint: (id) => `${ENDPOINT}${id}/`,
      detailQueryKey: (id) => ["application", id],
      detailLabel: (a) => a.path || a.name,
      listEndpoint: ENDPOINT,
      searchHint: "Search name, description…",
      filters: [
        {
          key: "manufacturer",
          label: "Manufacturer",
          endpoint: "/api/manufacturers/?picker=1",
          queryKey: "manufacturers-picker",
        },
      ],
      columns: [
        { header: "Name", cell: (a) => a.path || a.name },
        {
          header: "Manufacturer",
          cell: (a) => (
            <span className="text-muted-foreground">
              {a.manufacturer?.name ?? "-"}
            </span>
          ),
        },
        {
          header: "Installs",
          cell: (a) => <span className="num">{a.install_count}</span>,
        },
      ],
    }),
    []
  )
  return (
    <ObjectPicker<Application, ApplicationMini>
      spec={spec}
      label={label}
      {...rest}
    />
  )
}
