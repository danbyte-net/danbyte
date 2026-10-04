import { Link } from "@tanstack/react-router"
import type { ColumnDef } from "@tanstack/react-table"

import { SortHeader } from "@/components/data-table"
import { dash } from "@/components/cells/dash"
import { DeviceCell } from "@/components/cells/device-cell"
import { TimeCell } from "@/components/cells/time-ago"
import { VlanBadge } from "@/components/cells/vlan-badge"
import { Badge } from "@/components/ui/badge"
import { TruncatedText } from "@/components/ui/truncated-text"
import {
  IpList,
  MacLink,
  MacStateBadge,
  UplinkBadge,
  WhereCell,
} from "@/components/learned-macs-cell"
import type { MacLocationRef, MacVendor } from "@/lib/api"

/**
 * One learned-MAC sighting as a table row (#284): a MAC on a switch port in a
 * VLAN, present or gone. The interface MACs tab, the MAC page's Ports table
 * and the network-wide Learned list are all this entity, so they share one
 * column factory; each row shape fills the fields it has.
 */
export interface LearnedMacRow {
  mac?: string
  vendor?: MacVendor | null
  device?: { id: string; name: string } | null
  interface?: { id: string; name: string } | null
  port_name?: string | null
  /** The Learned list: where the MAC's Location is. */
  kind?: "access" | "behind_uplink" | null
  vlan?: number | null
  vlan_object?: { id: string; name: string; vid: number } | null
  ips?: { ip: string; id: string | null }[]
  name?: string | null
  /** The MAC page: is the port an access port or an uplink. */
  role?: "access" | "uplink" | null
  /** An uplink's MACs tab: located on this port, or where instead. */
  here?: boolean
  location?: MacLocationRef | null
  first_seen?: string | null
  last_seen?: string | null
  state: "present" | "gone"
  stale?: boolean
}

export type LearnedMacColumnId =
  | "mac"
  | "vendor"
  | "device"
  | "port"
  | "vlan"
  | "ip"
  | "name"
  | "location"
  | "role"
  | "first_seen"
  | "last_seen"
  | "state"

export interface LearnedMacColumnOpts {
  include: LearnedMacColumnId[]
  /** Sort headers - for tables holding their whole list. A server-paged table
   * leaves them off: sorting one page would only reorder that page. */
  sortable?: boolean
}

export function buildLearnedMacColumns<T extends LearnedMacRow>({
  include,
  sortable = true,
}: LearnedMacColumnOpts): ColumnDef<T, unknown>[] {
  const head = (label: string) =>
    sortable
      ? ({
          column,
        }: {
          column: Parameters<typeof SortHeader>[0]["column"]
        }) => <SortHeader column={column} label={label} />
      : label

  const byId: Record<LearnedMacColumnId, () => ColumnDef<T, unknown>> = {
    mac: () => ({
      id: "mac",
      accessorFn: (r) => r.mac ?? "",
      header: head("MAC"),
      cell: ({ row }) =>
        row.original.mac ? (
          <MacLink mac={row.original.mac} className="font-medium" />
        ) : (
          dash
        ),
    }),
    vendor: () => ({
      id: "vendor",
      accessorFn: (r) => r.vendor?.name ?? "",
      header: head("Vendor"),
      cell: ({ row }) =>
        row.original.vendor ? (
          <TruncatedText className="block max-w-36 text-xs">
            {row.original.vendor.name}
          </TruncatedText>
        ) : (
          dash
        ),
    }),
    device: () => ({
      id: "device",
      accessorFn: (r) => r.device?.name ?? "",
      header: head("Device"),
      cell: ({ row }) => (
        <DeviceCell
          device={row.original.device}
          className="font-mono text-xs"
        />
      ),
    }),
    port: () => ({
      id: "port",
      accessorFn: (r) => r.interface?.name ?? r.port_name ?? "",
      header: head("Port"),
      cell: ({ row }) => {
        const r = row.original
        const name = r.interface?.name ?? r.port_name
        if (!name) return dash
        return (
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
            {r.interface ? (
              <Link
                to="/interfaces/$id"
                params={{ id: r.interface.id }}
                className="link font-mono text-xs"
              >
                {name}
              </Link>
            ) : (
              <span className="font-mono text-xs">{name}</span>
            )}
            {r.kind === "behind_uplink" && (
              <UplinkBadge
                uplink={{ mode: "auto", reasons: [] }}
                label="uplink"
                small
              />
            )}
          </span>
        )
      },
    }),
    vlan: () => ({
      id: "vlan",
      accessorFn: (r) => r.vlan ?? -1,
      header: head("VLAN"),
      cell: ({ row }) => {
        const { vlan, vlan_object: v } = row.original
        if (v)
          return <VlanBadge vlan={{ id: v.id, vlan_id: v.vid, name: v.name }} />
        return vlan != null ? <span className="num text-xs">{vlan}</span> : dash
      },
    }),
    ip: () => ({
      id: "ip",
      accessorFn: (r) => r.ips?.[0]?.ip ?? "",
      header: "IP",
      cell: ({ row }) => <IpList ips={row.original.ips ?? []} />,
    }),
    name: () => ({
      id: "name",
      accessorFn: (r) => r.name ?? "",
      header: head("Name"),
      cell: ({ row }) =>
        row.original.name ? (
          <span className="text-xs">{row.original.name}</span>
        ) : (
          dash
        ),
    }),
    location: () => ({
      id: "location",
      accessorFn: (r) =>
        r.here
          ? ""
          : `${r.location?.device.name ?? ""} ${r.location?.port_name ?? ""}`,
      header: "Location",
      cell: ({ row }) =>
        row.original.state === "gone" ? (
          dash
        ) : (
          <WhereCell
            here={!!row.original.here}
            loc={row.original.location ?? null}
          />
        ),
    }),
    role: () => ({
      id: "role",
      accessorFn: (r) => r.role ?? "",
      header: head("Role"),
      cell: ({ row }) =>
        row.original.role === "uplink" ? (
          <Badge variant="secondary">Uplink</Badge>
        ) : row.original.role === "access" ? (
          <span className="text-xs">Access</span>
        ) : (
          dash
        ),
    }),
    first_seen: () => timeColumn<T>("first_seen", "First seen", head),
    last_seen: () => timeColumn<T>("last_seen", "Last seen", head),
    state: () => ({
      id: "state",
      accessorFn: (r) => r.state,
      header: "State",
      cell: ({ row }) => (
        <MacStateBadge state={row.original.state} stale={row.original.stale} />
      ),
    }),
  }
  return include.map((id) => byId[id]())
}

function timeColumn<T extends LearnedMacRow>(
  id: "first_seen" | "last_seen",
  label: string,
  head: (label: string) => ColumnDef<T, unknown>["header"]
): ColumnDef<T, unknown> {
  return {
    id,
    accessorFn: (r) => r[id] ?? "",
    header: head(label),
    cell: ({ row }) => {
      const iso = row.original[id]
      return iso ? <TimeCell iso={iso} /> : dash
    },
  }
}
