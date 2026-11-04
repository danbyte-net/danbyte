import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { DhcpReservation } from "@/lib/api"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { Badge } from "@/components/ui/badge"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { dash } from "@/components/kv-card"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of DHCP reservations" -
// /dhcp-reservations builds here.

export type DhcpReservationColumnId =
  "ip" | "mac" | "name" | "scope" | "server" | "origin" | "drift"

const CANONICAL_ORDER: DhcpReservationColumnId[] = [
  "ip",
  "mac",
  "name",
  "scope",
  "server",
  "origin",
  "drift",
]

export interface DhcpReservationColumnOpts<
  T extends DhcpReservation = DhcpReservation,
> {
  omit?: DhcpReservationColumnId[]
  include?: DhcpReservationColumnId[]
  /** Leading checkbox column for bulk selection. */
  selection?: boolean
  /** Trailing RowActions column. */
  actions?: ActionsColumnOpts<T>
}

export function buildDhcpReservationColumns<
  T extends DhcpReservation = DhcpReservation,
>(opts: DhcpReservationColumnOpts<T> = {}): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  const keep = (id: DhcpReservationColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))

  const byId: Record<DhcpReservationColumnId, () => ColumnDef<T, unknown>> = {
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
      cell: ({ row }) => (
        <Link
          to="/macs/$mac"
          params={{ mac: row.original.mac }}
          className="link font-mono text-[11px]"
        >
          {row.original.mac}
        </Link>
      ),
    }),
    name: () => ({
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => row.original.name || dash,
    }),
    scope: () => ({
      id: "scope",
      accessorKey: "scope_display",
      header: ({ column }) => <SortHeader column={column} label="Scope" />,
      // Scopes have no detail page - the informative destination is the
      // prefix the scope backs in IPAM.
      cell: ({ row }) =>
        row.original.scope_prefix ? (
          <Link
            to="/prefixes/$id"
            params={{ id: row.original.scope_prefix }}
            className="link font-mono text-[11px]"
          >
            {row.original.scope_display}
          </Link>
        ) : (
          <span className="font-mono text-[11px] text-muted-foreground">
            {row.original.scope_display}
          </span>
        ),
    }),
    server: () => ({
      id: "server",
      accessorKey: "connection_name",
      header: ({ column }) => <SortHeader column={column} label="Server" />,
      cell: ({ row }) =>
        row.original.connection ? (
          <Link
            to="/windows-servers/$id"
            params={{ id: row.original.connection }}
            className="link text-xs"
          >
            {row.original.connection_name}
          </Link>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-xs text-muted-foreground">Local</span>
            </TooltipTrigger>
            <TooltipContent variant="panel">
              Reservation in a local (Danbyte-owned) scope
            </TooltipContent>
          </Tooltip>
        ),
    }),
    origin: () => ({
      id: "origin",
      header: "Origin",
      enableSorting: false,
      cell: ({ row }) =>
        row.original.managed ? (
          <Badge variant="outline" className="text-[10px]">
            Danbyte
          </Badge>
        ) : (
          <span className="text-xs text-muted-foreground">server</span>
        ),
    }),
    drift: () => ({
      id: "drift",
      header: "Drift",
      enableSorting: false,
      cell: ({ row }) =>
        row.original.drift ? (
          <Badge variant="destructive" className="text-[10px]">
            {row.original.drift === "missing" ? "missing" : "modified"}
          </Badge>
        ) : (
          <span className="text-xs text-muted-foreground">-</span>
        ),
    }),
  }

  const cols: ColumnDef<T, unknown>[] = []
  if (opts.selection) cols.push(selectionColumn<T>())
  for (const id of CANONICAL_ORDER) if (keep(id)) cols.push(byId[id]())
  if (opts.actions) cols.push(actionsColumn<T>(opts.actions))
  return cols
}
