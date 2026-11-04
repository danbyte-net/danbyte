import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { WindowsConnection } from "@/lib/api"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { Badge } from "@/components/ui/badge"
import { TimeCell } from "@/components/cells/time-ago"
import { SyncStatusBadge as ConnSyncStatusBadge } from "@/components/integrations/sync-status-badge"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of Windows server connections" -
// /windows-servers builds here; the server page reuses the badges.

export function SyncStatusBadge({
  conn,
}: {
  conn: Pick<
    WindowsConnection,
    "last_sync_status" | "last_sync_error" | "last_sync_skipped"
  >
}) {
  return (
    <ConnSyncStatusBadge
      status={conn.last_sync_status}
      error={conn.last_sync_error}
      skipped={conn.last_sync_skipped}
    />
  )
}

export function roleBadges(conn: WindowsConnection) {
  return (
    <span className="flex gap-1">
      {conn.dhcp_enabled && (
        <Badge variant="outline" className="text-[10px]">
          DHCP
        </Badge>
      )}
      {conn.dns_enabled && (
        <Badge variant="outline" className="text-[10px]">
          DNS
        </Badge>
      )}
    </span>
  )
}

export type WindowsServerColumnId = "name" | "host" | "roles" | "status"

const CANONICAL_ORDER: WindowsServerColumnId[] = [
  "name",
  "host",
  "roles",
  "status",
]

export interface WindowsServerColumnOpts<
  T extends WindowsConnection = WindowsConnection,
> {
  omit?: WindowsServerColumnId[]
  include?: WindowsServerColumnId[]
  /** Leading checkbox column for bulk selection. */
  selection?: boolean
  /** Trailing RowActions column. */
  actions?: ActionsColumnOpts<T>
}

export function buildWindowsServerColumns<
  T extends WindowsConnection = WindowsConnection,
>(opts: WindowsServerColumnOpts<T> = {}): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  const keep = (id: WindowsServerColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))

  const byId: Record<WindowsServerColumnId, () => ColumnDef<T, unknown>> = {
    name: () => ({
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <Link
          to="/windows-servers/$id"
          params={{ id: row.original.id }}
          className="link flex items-center gap-2 font-medium"
        >
          {row.original.name}
          {!row.original.enabled && (
            <Badge variant="secondary" className="text-[10px]">
              disabled
            </Badge>
          )}
        </Link>
      ),
    }),
    host: () => ({
      id: "host",
      accessorKey: "host",
      header: "Host",
      cell: ({ row }) => (
        <span className="font-mono text-[11px] text-muted-foreground">
          {row.original.host}:{row.original.port}
        </span>
      ),
    }),
    roles: () => ({
      id: "roles",
      header: "Syncs",
      enableSorting: false,
      cell: ({ row }) => roleBadges(row.original),
    }),
    status: () => ({
      id: "status",
      header: "Last sync",
      enableSorting: false,
      cell: ({ row }) => (
        <span className="flex items-center gap-2">
          <SyncStatusBadge conn={row.original} />
          {row.original.last_sync_at && (
            <TimeCell iso={row.original.last_sync_at} />
          )}
        </span>
      ),
    }),
  }

  const cols: ColumnDef<T, unknown>[] = []
  if (opts.selection) cols.push(selectionColumn<T>())
  for (const id of CANONICAL_ORDER) if (keep(id)) cols.push(byId[id]())
  if (opts.actions) cols.push(actionsColumn<T>(opts.actions))
  return cols
}
