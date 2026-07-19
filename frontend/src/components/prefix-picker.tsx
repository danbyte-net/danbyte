import { useMemo } from "react"

import type { Prefix } from "@/lib/api"
import {
  ObjectPicker,
  type ObjectPickerProps,
  type ObjectPickerSpec,
} from "@/components/object-picker"
import { StatusBadge } from "@/components/status-badge"

export interface PrefixPickerProps extends Omit<ObjectPickerProps, "label"> {
  label?: string
}

/** Shared detail cache key — the same one prefix detail pages use, so a
 * hydration fetch here warms their cache (and vice versa). */
export const prefixDetailKey = (id: string) => ["prefix", id] as const

/** The prefix preset of ObjectPicker — options read "10.0.0.0/24 · prod",
 * advanced search by VRF / site / location. Replaces the page_size=1000
 * dropdown pattern: the combobox holds one page, the modal finds the rest. */
export function PrefixPicker({ label = "Prefix", ...rest }: PrefixPickerProps) {
  const spec = useMemo<ObjectPickerSpec<Prefix, Prefix>>(
    () => ({
      noun: "prefix",
      // No compact ?picker=1 shape exists for prefixes — the standard list
      // first page is fine for the combobox; the modal covers the long tail.
      pickerEndpoint: "/api/prefixes/",
      pickerQueryKey: ["prefixes-picker"],
      optionLabel: (p) => (p.vrf ? `${p.cidr} · ${p.vrf.name}` : p.cidr),
      detailEndpoint: (id) => `/api/prefixes/${id}/`,
      detailQueryKey: prefixDetailKey,
      detailLabel: (p) => (p.vrf ? `${p.cidr} · ${p.vrf.name}` : p.cidr),
      listEndpoint: "/api/prefixes/",
      searchHint: "Search CIDR, description…",
      filters: [
        {
          key: "vrf",
          label: "VRF",
          endpoint: "/api/vrfs/",
          queryKey: "vrfs-picker",
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
      ],
      columns: [
        {
          header: "Prefix",
          cell: (p) => <span className="font-mono">{p.cidr}</span>,
        },
        {
          header: "VRF",
          cell: (p) => (
            <span className="text-muted-foreground">
              {p.vrf?.name ?? "Global"}
            </span>
          ),
        },
        {
          header: "Site",
          cell: (p) => (
            <span className="text-muted-foreground">{p.site?.name ?? "—"}</span>
          ),
        },
        { header: "Status", cell: (p) => <StatusBadge status={p.status} /> },
        {
          header: "Description",
          cell: (p) => (
            <span className="line-clamp-1 text-muted-foreground">
              {p.description || "—"}
            </span>
          ),
        },
      ],
    }),
    []
  )
  return <ObjectPicker<Prefix, Prefix> spec={spec} label={label} {...rest} />
}
