import { useMemo } from "react"

import type { ApplicationGroup, ApplicationGroupMini } from "@/lib/api"
import { ObjectPicker } from "@/components/object-picker"
import type {
  ObjectPickerProps,
  ObjectPickerSpec,
} from "@/components/object-picker"

export interface ApplicationGroupPickerProps extends Omit<
  ObjectPickerProps,
  "label"
> {
  label?: string
}

const ENDPOINT = "/api/application-groups/"

/** The application group preset of ObjectPicker (#436). */
export function ApplicationGroupPicker({
  label = "Application group",
  ...rest
}: ApplicationGroupPickerProps) {
  const spec = useMemo<
    ObjectPickerSpec<ApplicationGroup, ApplicationGroupMini>
  >(
    () => ({
      noun: "application group",
      pickerEndpoint: `${ENDPOINT}?picker=1`,
      pickerQueryKey: ["application-groups-picker"],
      detailEndpoint: (id) => `${ENDPOINT}${id}/`,
      detailQueryKey: (id) => ["application-group", id],
      listEndpoint: ENDPOINT,
      searchHint: "Search name, description…",
      filters: [],
      columns: [
        { header: "Name", cell: (g) => g.name },
        {
          header: "Applications",
          cell: (g) => (
            <span className="text-muted-foreground">
              {g.members.map((m) => m.application.name).join(", ") || "-"}
            </span>
          ),
        },
        {
          header: "Hosts",
          cell: (g) => <span className="num">{g.host_count}</span>,
        },
      ],
    }),
    []
  )
  return (
    <ObjectPicker<ApplicationGroup, ApplicationGroupMini>
      spec={spec}
      label={label}
      {...rest}
    />
  )
}
