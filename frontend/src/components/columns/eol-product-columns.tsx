import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { EolCustomProduct } from "@/lib/api"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of custom end-of-life products" -
// /eol-products builds here. Page-specific columns are spliced around the
// output.

export type EolProductColumnId =
  | "label"
  | "name"
  | "cycles"
  | "applications"
  | "platforms"
  | "notes"
  | "updated"

const CANONICAL_ORDER: EolProductColumnId[] = [
  "label",
  "name",
  "cycles",
  "applications",
  "platforms",
  "notes",
  "updated",
]

export interface EolProductColumnOpts<
  T extends EolCustomProduct = EolCustomProduct,
> {
  omit?: EolProductColumnId[]
  include?: EolProductColumnId[]
  /** Leading checkbox column for bulk selection. */
  selection?: boolean
  /** Trailing RowActions column. */
  actions?: ActionsColumnOpts<T>
}

const usage = (n: number) => (n > 0 ? "in" : "out")
const usageLabel = (v: string) => ({ label: v === "in" ? "In use" : "Unused" })

export function buildEolProductColumns<
  T extends EolCustomProduct = EolCustomProduct,
>(opts: EolProductColumnOpts<T> = {}): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  const keep = (id: EolProductColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))

  const byId: Record<EolProductColumnId, () => ColumnDef<T, unknown>> = {
    label: () => ({
      id: "label",
      accessorKey: "label",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <Link
          to="/eol-products/$id"
          params={{ id: row.original.id }}
          className="link font-medium"
        >
          {row.original.label}
        </Link>
      ),
    }),
    name: () => ({
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Key" />,
      cell: ({ row }) => (
        <span className="font-mono text-xs">{row.original.name}</span>
      ),
    }),
    cycles: () => ({
      id: "cycles",
      accessorKey: "cycle_count",
      header: ({ column }) => <SortHeader column={column} label="Cycles" />,
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.cycle_count}</span>
      ),
      meta: {
        facet: {
          kind: "range",
          label: "Cycles",
          get: (r: T) => r.cycle_count,
          min: 0,
        },
      },
    }),
    applications: () => ({
      id: "applications",
      accessorKey: "application_count",
      header: ({ column }) => (
        <SortHeader column={column} label="Applications" />
      ),
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.application_count}</span>
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "Applications",
          get: (r: T) => usage(r.application_count),
          formatValue: usageLabel,
        },
      },
    }),
    platforms: () => ({
      id: "platforms",
      accessorKey: "platform_count",
      header: ({ column }) => <SortHeader column={column} label="Platforms" />,
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.platform_count}</span>
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "Platforms",
          get: (r: T) => usage(r.platform_count),
          formatValue: usageLabel,
        },
      },
    }),
    notes: () => ({
      id: "notes",
      accessorKey: "notes",
      header: "Notes",
      enableSorting: false,
      cell: ({ row }) => (
        <span className="line-clamp-1 block text-muted-foreground">
          {row.original.notes || "-"}
        </span>
      ),
    }),
    updated: () =>
      timeAgoColumn<T>({
        id: "updated",
        header: "Updated",
        get: (r) => r.updated_at,
        align: "right",
      }),
  }

  const cols: ColumnDef<T, unknown>[] = []
  if (opts.selection) cols.push(selectionColumn<T>())
  for (const id of CANONICAL_ORDER) if (keep(id)) cols.push(byId[id]())
  if (opts.actions) cols.push(actionsColumn<T>(opts.actions))
  return cols
}
