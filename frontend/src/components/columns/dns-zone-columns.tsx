import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { DnsZone } from "@/lib/api"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { Badge } from "@/components/ui/badge"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of DNS zones" - /dns-zones builds here.

export type DnsZoneColumnId =
  "name" | "type" | "server" | "records" | "reconcile" | "drift"

const CANONICAL_ORDER: DnsZoneColumnId[] = [
  "name",
  "type",
  "server",
  "records",
  "reconcile",
  "drift",
]

export interface DnsZoneColumnOpts<T extends DnsZone = DnsZone> {
  omit?: DnsZoneColumnId[]
  include?: DnsZoneColumnId[]
  /** Leading checkbox column for bulk selection. */
  selection?: boolean
  /** Trailing RowActions column. */
  actions?: ActionsColumnOpts<T>
}

export function buildDnsZoneColumns<T extends DnsZone = DnsZone>(
  opts: DnsZoneColumnOpts<T> = {}
): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  const keep = (id: DnsZoneColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))

  const byId: Record<DnsZoneColumnId, () => ColumnDef<T, unknown>> = {
    name: () => ({
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Zone" />,
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-1.5">
          <Link
            to="/dns-zones/$id"
            params={{ id: row.original.id }}
            className="link font-mono text-xs font-medium"
          >
            {row.original.name}
          </Link>
          {row.original.managed && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge
                  variant="outline"
                  className="text-[9px] text-muted-foreground"
                >
                  managed
                </Badge>
              </TooltipTrigger>
              <TooltipContent variant="panel">
                Authored in Danbyte - not mirrored from a server
              </TooltipContent>
            </Tooltip>
          )}
        </span>
      ),
    }),
    type: () => ({
      id: "type",
      accessorKey: "zone_type",
      header: "Type",
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground">
          {row.original.zone_type}
          {row.original.is_reverse ? " · reverse" : ""}
        </span>
      ),
    }),
    server: () => ({
      id: "server",
      accessorKey: "connection_name",
      header: "Server",
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
          <span className="text-xs text-muted-foreground">Local</span>
        ),
    }),
    records: () => ({
      id: "records",
      accessorKey: "record_count",
      header: ({ column }) => <SortHeader column={column} label="Records" />,
      cell: ({ row }) =>
        row.original.sync && row.original.record_count > 0 ? (
          <Link
            to="/dns-records"
            search={{ zone: row.original.id }}
            className="num link"
          >
            {row.original.record_count}
          </Link>
        ) : (
          <span className="num">
            {row.original.sync ? row.original.record_count : "-"}
          </span>
        ),
    }),
    reconcile: () => ({
      id: "reconcile",
      header: "Reconcile",
      enableSorting: false,
      cell: ({ row }) =>
        row.original.sync ? (
          <Badge variant="success" className="text-[10px]">
            on
          </Badge>
        ) : (
          <span className="text-xs text-muted-foreground">off</span>
        ),
    }),
    drift: () => ({
      id: "drift",
      header: "Drift",
      enableSorting: false,
      cell: ({ row }) =>
        row.original.drift_count > 0 ? (
          <Badge variant="destructive" className="text-[10px]">
            {row.original.drift_count}
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
