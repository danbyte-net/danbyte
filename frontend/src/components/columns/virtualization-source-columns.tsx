import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"
import { Inbox } from "lucide-react"

import type { VirtualizationSource } from "@/lib/api"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { TimeCell } from "@/components/cells/time-ago"
import { SyncStatusBadge } from "@/components/integrations/sync-status-badge"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of virtualization sources" -
// /virtualization-sources builds here.

export type VirtualizationSourceColumnId =
  "name" | "kind" | "mode" | "host" | "status"

const CANONICAL_ORDER: VirtualizationSourceColumnId[] = [
  "name",
  "kind",
  "mode",
  "host",
  "status",
]

const MODE_LABEL: Record<string, string> = {
  auto: "automatic",
  manual: "manual",
  review: "review",
}

export interface VirtualizationSourceColumnOpts<
  T extends VirtualizationSource = VirtualizationSource,
> {
  omit?: VirtualizationSourceColumnId[]
  include?: VirtualizationSourceColumnId[]
  /** Leading checkbox column for bulk selection. */
  selection?: boolean
  /** Opens the source's review inbox from the Mode cell's pending count. */
  onReview?: (row: T) => void
  /** Trailing RowActions column. */
  actions?: ActionsColumnOpts<T>
}

export function buildVirtualizationSourceColumns<
  T extends VirtualizationSource = VirtualizationSource,
>(opts: VirtualizationSourceColumnOpts<T> = {}): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  const keep = (id: VirtualizationSourceColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))

  const byId: Record<
    VirtualizationSourceColumnId,
    () => ColumnDef<T, unknown>
  > = {
    name: () => ({
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <span className="flex items-center gap-2 font-medium">
          <Link
            to="/virtualization-sources/$id"
            params={{ id: row.original.id }}
            className="link"
          >
            {row.original.name}
          </Link>
          {!row.original.enabled && (
            <Badge variant="secondary" className="text-[10px]">
              disabled
            </Badge>
          )}
        </span>
      ),
    }),
    kind: () => ({
      id: "kind",
      accessorKey: "kind_display",
      header: "Platform",
      cell: ({ row }) => (
        <Badge variant="outline" className="text-[10px]">
          {row.original.kind_display}
        </Badge>
      ),
    }),
    mode: () => ({
      id: "mode",
      accessorKey: "sync_mode",
      header: "Mode",
      cell: ({ row }) => (
        <span className="flex items-center gap-2">
          <Badge variant="secondary" className="text-[10px]">
            {MODE_LABEL[row.original.sync_mode] ?? "review"}
          </Badge>
          {row.original.pending_count > 0 && opts.onReview && (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-1.5 text-[11px]"
              onClick={() => opts.onReview!(row.original)}
            >
              <Inbox className="h-3.5 w-3.5" />
              {row.original.pending_count} to review
            </Button>
          )}
        </span>
      ),
    }),
    host: () => ({
      id: "host",
      accessorKey: "host",
      header: "API",
      cell: ({ row }) => (
        <span className="font-mono text-[11px] text-muted-foreground">
          https://{row.original.host}:{row.original.port}
        </span>
      ),
    }),
    status: () => ({
      id: "status",
      header: "Last sync",
      enableSorting: false,
      cell: ({ row }) => {
        const s = row.original
        return (
          <span className="flex items-center gap-2">
            <SyncStatusBadge
              status={s.last_sync_status}
              error={s.last_sync_error}
              skipped={s.last_sync_skipped}
            />
            {s.last_sync_at && <TimeCell iso={s.last_sync_at} />}
          </span>
        )
      },
    }),
  }

  const cols: ColumnDef<T, unknown>[] = []
  if (opts.selection) cols.push(selectionColumn<T>())
  for (const id of CANONICAL_ORDER) if (keep(id)) cols.push(byId[id]())
  if (opts.actions) cols.push(actionsColumn<T>(opts.actions))
  return cols
}
