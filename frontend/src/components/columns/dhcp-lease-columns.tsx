import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { DhcpLease } from "@/lib/api"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { TimeCell } from "@/components/cells/time-ago"
import { dash } from "@/components/kv-card"

// The one source of truth for "a table of DHCP leases" - /dhcp-leases builds
// here. Leases are synced from the server and read-only, so there is no
// actions column.

export type DhcpLeaseColumnId =
  "ip" | "mac" | "hostname" | "scope" | "state" | "expires"

const CANONICAL_ORDER: DhcpLeaseColumnId[] = [
  "ip",
  "mac",
  "hostname",
  "scope",
  "state",
  "expires",
]

export interface DhcpLeaseColumnOpts {
  omit?: DhcpLeaseColumnId[]
  include?: DhcpLeaseColumnId[]
  /** Leading checkbox column for bulk selection. */
  selection?: boolean
}

export function buildDhcpLeaseColumns<T extends DhcpLease = DhcpLease>(
  opts: DhcpLeaseColumnOpts = {}
): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  const keep = (id: DhcpLeaseColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))

  const byId: Record<DhcpLeaseColumnId, () => ColumnDef<T, unknown>> = {
    ip: () => ({
      id: "ip",
      accessorKey: "ip",
      header: ({ column }) => <SortHeader column={column} label="IP" />,
      cell: ({ row }) =>
        row.original.ip_address ? (
          <Link
            to="/ips/$id"
            params={{ id: row.original.ip_address }}
            className="link font-mono text-xs"
          >
            {row.original.ip}
          </Link>
        ) : (
          <span className="font-mono text-xs">{row.original.ip}</span>
        ),
    }),
    mac: () => ({
      id: "mac",
      accessorKey: "mac",
      header: ({ column }) => <SortHeader column={column} label="MAC" />,
      cell: ({ row }) =>
        row.original.mac ? (
          <Link
            to="/macs/$mac"
            params={{ mac: row.original.mac }}
            className="link font-mono text-[11px]"
          >
            {row.original.mac}
          </Link>
        ) : (
          <span className="font-mono text-[11px] text-muted-foreground">-</span>
        ),
    }),
    hostname: () => ({
      id: "hostname",
      accessorKey: "hostname",
      header: ({ column }) => <SortHeader column={column} label="Hostname" />,
      cell: ({ row }) => row.original.hostname || dash,
    }),
    scope: () => ({
      id: "scope",
      accessorKey: "scope_display",
      header: ({ column }) => <SortHeader column={column} label="Scope" />,
      cell: ({ row }) => (
        <span className="font-mono text-[11px] text-muted-foreground">
          {row.original.scope_display}
        </span>
      ),
    }),
    state: () => ({
      id: "state",
      accessorKey: "address_state",
      header: ({ column }) => <SortHeader column={column} label="State" />,
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground">
          {row.original.address_state || "-"}
        </span>
      ),
    }),
    expires: () => ({
      id: "expires",
      header: "Expires",
      enableSorting: false,
      cell: ({ row }) =>
        row.original.expires_at ? (
          <TimeCell iso={row.original.expires_at} />
        ) : (
          dash
        ),
    }),
  }

  const cols: ColumnDef<T, unknown>[] = []
  if (opts.selection) cols.push(selectionColumn<T>())
  for (const id of CANONICAL_ORDER) if (keep(id)) cols.push(byId[id]())
  return cols
}
