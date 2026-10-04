import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { Paginated, VirtualChassis } from "@/lib/api"
import { ObjectPicker } from "@/components/object-picker"
import type {
  ObjectPickerProps,
  ObjectPickerSpec,
} from "@/components/object-picker"

export interface VirtualChassisPickerProps extends Omit<
  ObjectPickerProps,
  "label"
> {
  label?: string
}

const ENDPOINT = "/api/virtual-chassis/"
const QUERY_KEY = ["virtual-chassis-picker"] as const

/** The virtual-chassis preset of ObjectPicker. A stack with no members has
 * nothing to stand for, so it is left out. The list endpoint has no picker
 * shape; it is the one the device form's stack field already caches. */
export function VirtualChassisPicker({
  label = "Virtual chassis",
  excludeIds,
  ...rest
}: VirtualChassisPickerProps) {
  const spec = useMemo<ObjectPickerSpec<VirtualChassis, VirtualChassis>>(
    () => ({
      noun: "stack",
      pickerEndpoint: ENDPOINT,
      pickerQueryKey: QUERY_KEY,
      optionState: (vc) => ({ hint: vc.master?.name }),
      detailEndpoint: (id) => `/api/virtual-chassis/${id}/`,
      detailQueryKey: (id) => ["virtual-chassis", id],
      listEndpoint: ENDPOINT,
      searchHint: "Search name, domain, description…",
      filters: [],
      columns: [
        { header: "Name", cell: (vc) => vc.name },
        {
          header: "Master",
          cell: (vc) => (
            <span className="text-muted-foreground">
              {vc.master?.name ?? "-"}
            </span>
          ),
        },
        {
          header: "Members",
          cell: (vc) => <span className="num">{vc.member_count}</span>,
        },
      ],
    }),
    []
  )
  // The same query ObjectPicker makes for its list, so this costs nothing.
  const all = useQuery({
    queryKey: [...QUERY_KEY, ""],
    queryFn: () => api<Paginated<VirtualChassis>>(ENDPOINT),
    staleTime: 10 * 60_000,
  })
  const hidden = useMemo(
    () => [
      ...(excludeIds ?? []),
      ...(all.data?.results ?? [])
        .filter((vc) => vc.member_count === 0)
        .map((vc) => vc.id),
    ],
    [all.data, excludeIds]
  )
  return (
    <ObjectPicker<VirtualChassis, VirtualChassis>
      spec={spec}
      label={label}
      excludeIds={hidden}
      {...rest}
    />
  )
}
