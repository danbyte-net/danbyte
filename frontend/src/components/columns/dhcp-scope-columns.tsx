import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { DhcpScope } from "@/lib/api"
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

// The one source of truth for "a table of DHCP scopes" - /dhcp-scopes builds
// here.

export type DhcpScopeColumnId =
  "scope" | "name" | "prefix" | "range" | "server" | "state" | "reservations"

const CANONICAL_ORDER: DhcpScopeColumnId[] = [
  "scope",
  "name",
  "prefix",
  "range",
  "server",
  "state",
  "reservations",
]

export interface DhcpScopeColumnOpts<T extends DhcpScope = DhcpScope> {
  omit?: DhcpScopeColumnId[]
  include?: DhcpScopeColumnId[]
  /** Leading checkbox column for bulk selection. */
  selection?: boolean
  /** Trailing RowActions column. */
  actions?: ActionsColumnOpts<T>
}

export function buildDhcpScopeColumns<T extends DhcpScope = DhcpScope>(
  opts: DhcpScopeColumnOpts<T> = {}
): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  const keep = (id: DhcpScopeColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))

  const byId: Record<DhcpScopeColumnId, () => ColumnDef<T, unknown>> = {
    scope: () => ({
      id: "scope",
      accessorKey: "scope_id",
      header: ({ column }) => <SortHeader column={column} label="Scope" />,
      cell: ({ row }) => (
        <span className="font-mono text-xs font-medium">
          {row.original.scope_id}
        </span>
      ),
    }),
    name: () => ({
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => row.original.name || dash,
    }),
    prefix: () => ({
      id: "prefix",
      header: "Prefix",
      enableSorting: false,
      cell: ({ row }) =>
        row.original.prefix ? (
          <span className="inline-flex items-center gap-1.5">
            <Link
              to="/prefixes/$id"
              params={{ id: row.original.prefix }}
              className="link font-mono text-xs"
            >
              {row.original.prefix_cidr}
            </Link>
            {row.original.vrf_name && (
              <span className="text-[10px] text-muted-foreground">
                · {row.original.vrf_name}
              </span>
            )}
          </span>
        ) : (
          dash
        ),
    }),
    range: () => ({
      id: "range",
      header: "Range",
      enableSorting: false,
      cell: ({ row }) => (
        <span className="font-mono text-[11px] text-muted-foreground">
          {row.original.start_range}–{row.original.end_range}
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
              Danbyte-owned scope - no DHCP server behind it
            </TooltipContent>
          </Tooltip>
        ),
    }),
    state: () => ({
      id: "state",
      accessorKey: "state",
      header: ({ column }) => <SortHeader column={column} label="State" />,
      cell: ({ row }) => (
        <Badge
          variant={row.original.state === "Active" ? "success" : "secondary"}
          className="text-[10px]"
        >
          {row.original.state || "unknown"}
        </Badge>
      ),
    }),
    reservations: () => ({
      id: "reservations",
      accessorKey: "reservation_count",
      header: ({ column }) => (
        <SortHeader column={column} label="Reservations" />
      ),
      cell: ({ row }) =>
        row.original.reservation_count > 0 ? (
          <Link
            to="/dhcp-reservations"
            search={{ scope: row.original.id }}
            className="link"
          >
            <span className="num">{row.original.reservation_count}</span>
            {row.original.drift_count > 0 && (
              <Badge variant="destructive" className="ml-2 text-[10px]">
                {row.original.drift_count} drift
              </Badge>
            )}
          </Link>
        ) : (
          <span className="num text-muted-foreground">0</span>
        ),
    }),
  }

  const cols: ColumnDef<T, unknown>[] = []
  if (opts.selection) cols.push(selectionColumn<T>())
  for (const id of CANONICAL_ORDER) if (keep(id)) cols.push(byId[id]())
  if (opts.actions) cols.push(actionsColumn<T>(opts.actions))
  return cols
}
