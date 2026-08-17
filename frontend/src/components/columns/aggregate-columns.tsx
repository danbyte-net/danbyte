import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { Aggregate } from "@/lib/api"
import { cn } from "@/lib/utils"
import { PlannedChangeMarker } from "@/components/planning/planned-change-badge"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { dash } from "@/components/cells/dash"
import { numidColumn } from "@/components/cells/numid"
import { UtilCell } from "@/components/cells/util-cell"
import { tagsColumn } from "@/components/cells/tag-list"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of aggregates". Every surface that
// lists aggregates — /aggregates and the RIR detail page's aggregates pane —
// builds its columns here so an aggregate row reads identically everywhere.
// Page-specific columns are spliced around this factory's output; the shared
// cells are never re-authored inline.
//
// The /aggregates page drives its own hand-rolled FilterRail (RIR + tags)
// rather than `useTableFilters`, so these columns intentionally carry no facet
// meta — adding it would silently double up that page's rail.

export type AggregateColumnId =
  | "numid"
  | "prefix"
  | "rir"
  | "utilisation"
  | "date_added"
  | "description"
  | "tags"
  | "updated"

const CANONICAL_ORDER: AggregateColumnId[] = [
  "numid",
  "prefix",
  "rir",
  "utilisation",
  "date_added",
  "description",
  "tags",
  "updated",
]

export interface AggregateColumnOpts<T extends Aggregate = Aggregate> {
  /** Drop columns (e.g. the RIR page omits "rir"). */
  omit?: AggregateColumnId[]
  /** Keep only these columns (canonical order still applies). */
  include?: AggregateColumnId[]
  /** Leading checkbox column for bulk selection. */
  selection?: boolean
  /** Leading "#" numid column — gate on `useMe().humanIds`. */
  humanIds?: boolean
  /** Extra class slotted into the prefix link — the /aggregates list renders
   * it a shade smaller than the table's body text. */
  prefixClass?: string
  /** Wire tag chips to a page-level tag filter (defaults to inert). */
  tagFilter?: { activeSlugs: Set<string>; onToggle: (slug: string) => void }
  /** Trailing RowActions column. */
  actions?: ActionsColumnOpts<T>
}

export function buildAggregateColumns<T extends Aggregate = Aggregate>(
  opts: AggregateColumnOpts<T> = {}
): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  // The "#" column only exists where the deployment enables human ids.
  if (!opts.humanIds) omit.add("numid")
  const keep = (id: AggregateColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))

  const byId: Record<AggregateColumnId, () => ColumnDef<T, unknown>> = {
    numid: () => numidColumn<T>({ get: (r) => r.numid }),
    prefix: () => ({
      id: "prefix",
      accessorKey: "prefix",
      header: ({ column }) => <SortHeader column={column} label="Prefix" />,
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-1.5">
          <Link
            to="/aggregates/$id"
            params={{ id: row.original.id }}
            className={cn("font-mono", opts.prefixClass, "link font-medium")}
          >
            {row.original.prefix}
          </Link>
          <PlannedChangeMarker
            objectType="api.aggregate"
            objectId={row.original.id}
          />
        </span>
      ),
    }),
    rir: () => ({
      id: "rir",
      accessorFn: (a) => a.rir?.name ?? "",
      header: "RIR",
      cell: ({ row }) =>
        row.original.rir ? (
          <span className="text-xs">{row.original.rir.name}</span>
        ) : (
          dash
        ),
    }),
    utilisation: () => ({
      id: "utilisation",
      accessorKey: "utilisation_pct",
      header: ({ column }) => (
        <SortHeader column={column} label="Utilisation" />
      ),
      cell: ({ row }) => <UtilCell pct={row.original.utilisation_pct} />,
    }),
    date_added: () => ({
      id: "date_added",
      accessorKey: "date_added",
      header: "Added",
      cell: ({ row }) =>
        row.original.date_added ? (
          <span className="num text-xs">{row.original.date_added}</span>
        ) : (
          dash
        ),
    }),
    description: () => ({
      id: "description",
      accessorKey: "description",
      header: "Description",
      cell: ({ row }) => (
        <span className="line-clamp-1 block text-muted-foreground">
          {row.original.description || "—"}
        </span>
      ),
    }),
    tags: () =>
      tagsColumn<T>({
        getTags: (r) => r.tags,
        activeSlugs: opts.tagFilter?.activeSlugs,
        onToggle: opts.tagFilter?.onToggle,
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
