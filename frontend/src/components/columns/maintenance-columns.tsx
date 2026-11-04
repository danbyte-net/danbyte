import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"
import { Wrench, Zap } from "lucide-react"

import type { MaintenanceEvent } from "@/lib/api"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { StatusBadge } from "@/components/status-badge"
import { TimeCell } from "@/components/cells/time-ago"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of maintenance and outage events" -
// /maintenance builds here. Statuses are rows from the tenant's /statuses
// catalog; the kind carries its own colour (amber wrench / red zap), as on
// the calendar.

export type MaintenanceColumnId =
  | "kind"
  | "name"
  | "provider"
  | "status"
  | "window"
  | "impacts"
  | "ref"
  | "updated"

const CANONICAL_ORDER: MaintenanceColumnId[] = [
  "kind",
  "name",
  "provider",
  "status",
  "window",
  "impacts",
  "ref",
  "updated",
]

export interface MaintenanceColumnOpts<
  T extends MaintenanceEvent = MaintenanceEvent,
> {
  omit?: MaintenanceColumnId[]
  /** Leading checkbox column for bulk selection. */
  selection?: boolean
  /** The viewer's date-time format (`useDateFormat().formatDateTime`). */
  formatDateTime: (iso: string) => string
  /** Trailing RowActions column. */
  actions?: ActionsColumnOpts<T>
}

function KindCell({ event }: { event: MaintenanceEvent }) {
  return event.kind === "outage" ? (
    <span className="inline-flex items-center gap-1.5 text-red-600 dark:text-red-400">
      <Zap className="h-3.5 w-3.5" /> Outage
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
      <Wrench className="h-3.5 w-3.5" /> Maintenance
    </span>
  )
}

export function buildMaintenanceColumns<
  T extends MaintenanceEvent = MaintenanceEvent,
>(opts: MaintenanceColumnOpts<T>): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  const fmt = opts.formatDateTime

  const byId: Record<MaintenanceColumnId, () => ColumnDef<T, unknown>> = {
    kind: () => ({
      id: "kind",
      header: "Kind",
      accessorKey: "kind",
      meta: {
        facet: {
          kind: "enum",
          label: "Kind",
          get: (e: T) => e.kind,
          formatValue: (v: string) => ({
            label: v === "outage" ? "Outage" : "Maintenance",
          }),
        },
      },
      cell: ({ row }) => <KindCell event={row.original} />,
    }),
    name: () => ({
      id: "name",
      header: "Name",
      cell: ({ row }) => (
        <Link
          to="/maintenance/$id/edit"
          params={{ id: row.original.id }}
          className="link font-medium"
        >
          {row.original.name}
        </Link>
      ),
    }),
    provider: () => ({
      id: "provider",
      header: "Provider",
      meta: {
        facet: {
          kind: "enum",
          label: "Provider",
          get: (e: T) => e.provider_name || "__none__",
          formatValue: (v: string) => ({
            label: v === "__none__" ? "Internal" : v,
          }),
        },
      },
      cell: ({ row }) =>
        row.original.provider_name || (
          <span className="text-muted-foreground">Internal</span>
        ),
    }),
    status: () => ({
      id: "status",
      accessorFn: (e) => e.status.name,
      header: ({ column }) => <SortHeader column={column} label="Status" />,
      meta: {
        facet: {
          kind: "enum",
          label: "Status",
          get: (e: T) => e.status.name,
        },
      },
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    }),
    window: () => ({
      id: "window",
      header: "Window",
      cell: ({ row }) => {
        const e = row.original
        return (
          <span className="num text-[12px] whitespace-nowrap">
            {fmt(e.starts_at)}
            {" → "}
            {e.ends_at ? (
              fmt(e.ends_at)
            ) : e.etr ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>ETR {fmt(e.etr)}</span>
                </TooltipTrigger>
                <TooltipContent>Estimated time to restore</TooltipContent>
              </Tooltip>
            ) : (
              <span className="text-muted-foreground">open</span>
            )}
          </span>
        )
      },
    }),
    impacts: () => ({
      id: "impacts",
      header: "Impacts",
      cell: ({ row }) => (
        <span className="num">{row.original.impacts.length}</span>
      ),
    }),
    ref: () => ({
      id: "ref",
      header: "Reference",
      cell: ({ row }) =>
        row.original.external_ref ? (
          <span className="font-mono text-[12px]">
            {row.original.external_ref}
          </span>
        ) : null,
    }),
    updated: () => ({
      id: "updated",
      header: "Updated",
      cell: ({ row }) => <TimeCell iso={row.original.updated_at} />,
    }),
  }

  const cols: ColumnDef<T, unknown>[] = []
  if (opts.selection) cols.push(selectionColumn<T>())
  for (const id of CANONICAL_ORDER) if (!omit.has(id)) cols.push(byId[id]())
  if (opts.actions) cols.push(actionsColumn<T>(opts.actions))
  return cols
}
