import { useMemo } from "react"

import type { IPRange } from "@/lib/api"
import { ObjectPicker } from "@/components/object-picker"
import type {
  ObjectPickerProps,
  ObjectPickerSpec,
} from "@/components/object-picker"
import { StatusBadge } from "@/components/status-badge"

export interface IpRangePickerProps extends Omit<ObjectPickerProps, "label"> {
  label?: string
}

const rangeLabel = (r: IPRange) =>
  `${r.start_address}-${r.end_address}${r.vrf ? ` · ${r.vrf.name}` : ""}`

/** The IP-range preset of ObjectPicker - options read
 * "10.0.0.100-10.0.0.150 · prod", advanced search by prefix / VRF. */
export function IpRangePicker({
  label = "IP range",
  ...rest
}: IpRangePickerProps) {
  const spec = useMemo<ObjectPickerSpec<IPRange, IPRange>>(
    () => ({
      noun: "range",
      // No compact ?picker=1 shape exists for ranges - the first page of
      // the standard list feeds the combobox; the modal covers the rest.
      pickerEndpoint: "/api/ip-ranges/",
      pickerQueryKey: ["ip-ranges-picker"],
      optionLabel: rangeLabel,
      detailEndpoint: (id) => `/api/ip-ranges/${id}/`,
      detailQueryKey: (id) => ["ip-range", id],
      detailLabel: rangeLabel,
      listEndpoint: "/api/ip-ranges/",
      searchHint: "Search address, description…",
      filters: [
        {
          key: "prefix",
          label: "Prefix",
          endpoint: "/api/prefixes/",
          queryKey: "prefixes-picker",
          textOf: (p: { cidr: string }) => p.cidr,
        },
        {
          key: "vrf",
          label: "VRF",
          endpoint: "/api/vrfs/",
          queryKey: "vrfs-picker",
        },
      ],
      columns: [
        {
          header: "Range",
          cell: (r) => (
            <span className="font-mono">
              {r.start_address}-{r.end_address}
            </span>
          ),
        },
        {
          header: "VRF",
          cell: (r) => (
            <span className="text-muted-foreground">
              {r.vrf?.name ?? "Global"}
            </span>
          ),
        },
        { header: "Status", cell: (r) => <StatusBadge status={r.status} /> },
        {
          header: "Description",
          cell: (r) => (
            <span className="line-clamp-1 text-muted-foreground">
              {r.description || "-"}
            </span>
          ),
        },
      ],
    }),
    []
  )
  return <ObjectPicker<IPRange, IPRange> spec={spec} label={label} {...rest} />
}
