import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { DependencyMedium } from "@/lib/api"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"
import {
  DependencyMediumBadge,
  lineStyleLabel,
} from "@/components/dependency-medium-badge"
import { LocalityBadge } from "@/components/locality-badge"

// The one source of truth for "a table of dependency media" (#450). The name
// renders as the medium's own badge - colour and icon from its data.

export interface DependencyMediumColumnOpts<
  T extends DependencyMedium = DependencyMedium,
> {
  selection?: boolean
  actions?: ActionsColumnOpts<T>
}

export function buildDependencyMediumColumns<
  T extends DependencyMedium = DependencyMedium,
>(opts: DependencyMediumColumnOpts<T> = {}): ColumnDef<T, unknown>[] {
  const cols: ColumnDef<T, unknown>[] = []
  if (opts.selection) cols.push(selectionColumn<T>())
  cols.push(
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <Link
          to="/dependency-media/$id"
          params={{ id: row.original.id }}
          className="hover:opacity-90"
        >
          <DependencyMediumBadge medium={row.original} />
        </Link>
      ),
    },
    {
      id: "line_style",
      accessorKey: "line_style",
      header: ({ column }) => <SortHeader column={column} label="Line" />,
      cell: ({ row }) => lineStyleLabel(row.original.line_style),
      meta: {
        facet: {
          kind: "enum",
          label: "Line",
          get: (r: T) => r.line_style,
          formatValue: (v) => ({ label: lineStyleLabel(v) }),
        },
      },
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
    {
      id: "usage",
      accessorKey: "usage_count",
      header: ({ column }) => (
        <SortHeader column={column} label="Dependencies" />
      ),
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.usage_count}</span>
      ),
    },
    {
      id: "scope",
      accessorFn: (r) => r.owning_site?.name ?? "",
      header: "Scope",
      cell: ({ row }) => (
        <LocalityBadge owningSite={row.original.owning_site} />
      ),
    },
    {
      id: "weight",
      accessorKey: "weight",
      header: ({ column }) => <SortHeader column={column} label="Weight" />,
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.weight}</span>
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
