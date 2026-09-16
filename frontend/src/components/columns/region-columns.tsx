import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"
import { CornerDownRight } from "lucide-react"

import type { Region } from "@/lib/api"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { numidColumn } from "@/components/cells/numid"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of regions" - /regions and the
// monitoring policy tab both build here, so a region row reads the same in
// each. Page-specific columns are spliced around the output.

export type RegionColumnId =
  | "numid"
  | "name"
  | "parent"
  | "children"
  | "sites"
  | "description"

const CANONICAL_ORDER: RegionColumnId[] = [
  "numid",
  "name",
  "parent",
  "children",
  "sites",
  "description",
]

export interface RegionColumnOpts<T extends Region = Region> {
  omit?: RegionColumnId[]
  include?: RegionColumnId[]
  /** Leading checkbox column for bulk selection. */
  selection?: boolean
  /** Leading "#" numid column - gate on `useMe().humanIds`. */
  humanIds?: boolean
  /** Columns whose header stays plain text instead of a sortable SortHeader. */
  plainHeaders?: RegionColumnId[]
  /** Trailing RowActions column. */
  actions?: ActionsColumnOpts<T>
}

export function buildRegionColumns<T extends Region = Region>(
  opts: RegionColumnOpts<T> = {}
): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  if (!opts.humanIds) omit.add("numid")
  const keep = (id: RegionColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))

  const plain = new Set(opts.plainHeaders ?? [])
  const head = (
    id: RegionColumnId,
    label: string
  ): ColumnDef<T, unknown>["header"] =>
    plain.has(id)
      ? label
      : ({ column }) => <SortHeader column={column} label={label} />

  const byId: Record<RegionColumnId, () => ColumnDef<T, unknown>> = {
    numid: () => numidColumn<T>({ get: (r) => r.numid }),
    name: () => ({
      id: "name",
      accessorKey: "name",
      header: head("name", "Name"),
      cell: ({ row }) => {
        // `_depth` is stamped by nestByParent on the list page; a flat table
        // has none and gets no indent.
        const depth = (row.original as T & { _depth?: number })._depth ?? 0
        return (
          <div className="flex items-center gap-0.5">
            {Array.from({ length: depth }, (_, i) => (
              <CornerDownRight
                key={i}
                aria-hidden
                className="h-3 w-3 shrink-0 text-muted-foreground/40"
              />
            ))}
            <Link
              to="/regions/$id"
              params={{ id: row.original.id }}
              className="link font-medium"
            >
              {row.original.name}
            </Link>
          </div>
        )
      },
    }),
    parent: () => ({
      id: "parent",
      accessorFn: (r) => r.parent?.name ?? "",
      header: head("parent", "Parent"),
      cell: ({ row }) =>
        row.original.parent ? (
          <span className="text-xs">{row.original.parent.name}</span>
        ) : (
          <span className="text-muted-foreground">-</span>
        ),
    }),
    children: () => ({
      id: "children",
      accessorKey: "child_count",
      header: head("children", "Sub-regions"),
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.child_count}</span>
      ),
    }),
    sites: () => ({
      id: "sites",
      accessorKey: "site_count",
      header: head("sites", "Sites"),
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.site_count}</span>
      ),
    }),
    description: () => ({
      id: "description",
      accessorKey: "description",
      header: "Description",
      enableSorting: false,
      cell: ({ row }) => (
        <span className="line-clamp-1 block text-muted-foreground">
          {row.original.description || "-"}
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
