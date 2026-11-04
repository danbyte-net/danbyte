import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { AutomationTarget } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of automation targets" -
// /automation-targets builds here. The token is write-only and never shown.

export type AutomationTargetColumnId = "name" | "kind" | "url" | "auto"

const CANONICAL_ORDER: AutomationTargetColumnId[] = [
  "name",
  "kind",
  "url",
  "auto",
]

export interface AutomationTargetColumnOpts<
  T extends AutomationTarget = AutomationTarget,
> {
  omit?: AutomationTargetColumnId[]
  /** Leading checkbox column for bulk selection. */
  selection?: boolean
  /** Trailing RowActions column. */
  actions?: ActionsColumnOpts<T>
}

export function buildAutomationTargetColumns<
  T extends AutomationTarget = AutomationTarget,
>(opts: AutomationTargetColumnOpts<T> = {}): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])

  const byId: Record<AutomationTargetColumnId, () => ColumnDef<T, unknown>> = {
    name: () => ({
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <Link
          to="/automation-targets/$id"
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
    kind: () => ({
      id: "kind",
      accessorKey: "kind_display",
      header: "Kind",
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground">
          {row.original.kind_display}
        </span>
      ),
    }),
    url: () => ({
      id: "url",
      accessorKey: "base_url",
      header: "Endpoint",
      cell: ({ row }) => (
        <span className="line-clamp-1 block font-mono text-[11px] text-muted-foreground">
          {row.original.base_url}
          {row.original.kind === "awx" && row.original.job_template_id
            ? ` · JT ${row.original.job_template_id}`
            : ""}
        </span>
      ),
    }),
    auto: () => ({
      id: "auto",
      header: "On change",
      cell: ({ row }) =>
        row.original.auto_on_change ? (
          <Badge variant="secondary" className="text-[10px]">
            auto
          </Badge>
        ) : (
          <span className="text-xs text-muted-foreground">manual</span>
        ),
    }),
  }

  const cols: ColumnDef<T, unknown>[] = []
  if (opts.selection) cols.push(selectionColumn<T>())
  for (const id of CANONICAL_ORDER) if (!omit.has(id)) cols.push(byId[id]())
  if (opts.actions) cols.push(actionsColumn<T>(opts.actions))
  return cols
}
