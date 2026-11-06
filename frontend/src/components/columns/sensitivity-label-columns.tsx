import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { SensitivityLabel } from "@/lib/api"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { dash } from "@/components/cells/dash"
import { numidColumn } from "@/components/cells/numid"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"
import { SensitivityBadge } from "@/components/sensitivity-badge"
import { Badge } from "@/components/ui/badge"

// The one source of truth for "a table of sensitivity labels". The name
// renders as the label's own badge - its colour and icon come from its data.

export interface SensitivityLabelColumnOpts<
  T extends SensitivityLabel = SensitivityLabel,
> {
  selection?: boolean
  humanIds?: boolean
  actions?: ActionsColumnOpts<T>
}

export function buildSensitivityLabelColumns<
  T extends SensitivityLabel = SensitivityLabel,
>(opts: SensitivityLabelColumnOpts<T> = {}): ColumnDef<T, unknown>[] {
  const cols: ColumnDef<T, unknown>[] = []
  if (opts.selection) cols.push(selectionColumn<T>())
  if (opts.humanIds) cols.push(numidColumn<T>({ get: (r) => r.numid }))
  cols.push(
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <Link
          to="/sensitivity-labels/$id"
          params={{ id: row.original.id }}
          className="hover:opacity-90"
        >
          <SensitivityBadge label={row.original} />
        </Link>
      ),
    },
    {
      id: "default",
      accessorKey: "is_default",
      header: "Default",
      cell: ({ row }) =>
        row.original.is_default ? (
          <Badge variant="secondary">Default</Badge>
        ) : (
          dash
        ),
      meta: {
        facet: {
          kind: "enum",
          label: "Default",
          get: (r: T) => (r.is_default ? "yes" : "no"),
          formatValue: (v) => ({ label: v === "yes" ? "Default" : "Other" }),
        },
      },
    },
    {
      id: "weight",
      accessorKey: "weight",
      header: ({ column }) => <SortHeader column={column} label="Weight" />,
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.weight}</span>
      ),
    },
    {
      id: "description",
      accessorKey: "description",
      header: "Description",
      cell: ({ row }) => (
        <span className="line-clamp-1 block text-muted-foreground">
          {row.original.description || "-"}
        </span>
      ),
    },
    timeAgoColumn<T>({
      id: "updated",
      header: "Updated",
      get: (r) => r.updated_at,
      align: "right",
    })
  )
  if (opts.actions) cols.push(actionsColumn<T>(opts.actions))
  return cols
}
