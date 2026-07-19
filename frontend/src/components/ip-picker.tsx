import { useMemo } from "react"

import type { IPAddress } from "@/lib/api"
import {
  ObjectPicker,
  type ObjectPickerProps,
  type ObjectPickerSpec,
} from "@/components/object-picker"
import { StatusBadge } from "@/components/status-badge"

export interface IpPickerProps extends Omit<ObjectPickerProps, "label"> {
  label?: string
}

/** The IP-address preset of ObjectPicker — advanced search by prefix / VRF /
 * site plus free text over address + DNS name. Replaces the page_size=500
 * dropdown pattern: the combobox holds one page, the modal scales to any
 * address space. */
export function IpPicker({ label = "IP address", ...rest }: IpPickerProps) {
  const spec = useMemo<ObjectPickerSpec<IPAddress, IPAddress>>(
    () => ({
      noun: "IP",
      // No compact ?picker=1 shape exists for IPs — first page of the
      // standard list feeds the combobox; the modal covers the rest.
      pickerEndpoint: "/api/ips/",
      pickerQueryKey: ["ips-picker"],
      optionLabel: (ip) =>
        ip.dns_name ? `${ip.ip_address} · ${ip.dns_name}` : ip.ip_address,
      detailEndpoint: (id) => `/api/ips/${id}/`,
      detailQueryKey: (id) => ["ip", id],
      detailLabel: (ip) =>
        ip.dns_name ? `${ip.ip_address} · ${ip.dns_name}` : ip.ip_address,
      listEndpoint: "/api/ips/",
      searchHint: "Search address, DNS name…",
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
        {
          key: "site",
          label: "Site",
          endpoint: "/api/sites/?picker=1",
          queryKey: "sites-picker",
        },
      ],
      columns: [
        {
          header: "Address",
          cell: (ip) => <span className="font-mono">{ip.ip_address}</span>,
        },
        {
          header: "DNS name",
          cell: (ip) => (
            <span className="font-mono text-muted-foreground">
              {ip.dns_name || "—"}
            </span>
          ),
        },
        { header: "Status", cell: (ip) => <StatusBadge status={ip.status} /> },
        {
          header: "Assigned to",
          cell: (ip) => (
            <span className="text-muted-foreground">
              {ip.assigned_device?.name ?? ip.assigned_vm?.name ?? "—"}
            </span>
          ),
        },
        {
          header: "Prefix",
          cell: (ip) => (
            <span className="font-mono text-muted-foreground">
              {ip.prefix?.cidr ?? "—"}
            </span>
          ),
        },
      ],
    }),
    []
  )
  return (
    <ObjectPicker<IPAddress, IPAddress> spec={spec} label={label} {...rest} />
  )
}
