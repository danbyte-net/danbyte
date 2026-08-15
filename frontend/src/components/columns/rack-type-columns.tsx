import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { RackType } from "@/lib/api"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { PlannedChangeMarker } from "@/components/planning/planned-change-badge"
import { numidColumn } from "@/components/cells/numid"
import { manufacturerColumn } from "@/components/cells/manufacturer-cell"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of rack types" — the catalog list and
// any embedded listing build their columns here so a rack-model row reads
// identically everywhere.

export type RackTypeColumnId =
  | "numid"
  | "name"
  | "manufacturer"
  | "dimensions"
  | "accessories"
  | "racks"
  | "description"
  | "updated"

const CANONICAL_ORDER: RackTypeColumnId[] = [
  "numid",
  "name",
  "manufacturer",
  "dimensions",
  "accessories",
  "racks",
  "description",
  "updated",
]

export interface RackTypeColumnOpts<T extends RackType = RackType> {
  /** Drop columns. */
  omit?: RackTypeColumnId[]
  /** Keep only these columns (canonical order still applies). */
  include?: RackTypeColumnId[]
  /** Leading checkbox column for bulk selection. */
  selection?: boolean
  /** Leading "#" numid column — gate on `useMe().humanIds`. */
  humanIds?: boolean
  /** Trailing RowActions column. */
  actions?: ActionsColumnOpts<T>
}

export function buildRackTypeColumns<T extends RackType = RackType>(
  opts: RackTypeColumnOpts<T> = {}
): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  if (!opts.humanIds) omit.add("numid")
  const keep = (id: RackTypeColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))

  const byId: Record<RackTypeColumnId, () => ColumnDef<T, unknown>> = {
    numid: () => numidColumn<T>({ get: (r) => r.numid }),
    name: () => ({
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-1.5">
          <Link
            to="/rack-types/$id"
            params={{ id: row.original.id }}
            className="font-medium hover:underline"
          >
            {row.original.name}
          </Link>
          <PlannedChangeMarker
            objectType="api.racktype"
            objectId={row.original.id}
          />
        </span>
      ),
    }),
    manufacturer: () => manufacturerColumn<T>({ get: (r) => r.manufacturer }),
    dimensions: () => ({
      id: "dimensions",
      accessorKey: "u_height",
      header: ({ column }) => <SortHeader column={column} label="Size" />,
      // 42U · 19″ · 600×1070 mm — the profile a rack inherits on pick.
      cell: ({ row }) => {
        const r = row.original
        const outer =
          r.outer_width_mm != null && r.outer_depth_mm != null
            ? ` · ${r.outer_width_mm}×${r.outer_depth_mm} mm`
            : ""
        return (
          <span className="num text-xs">
            {r.u_height}U · {r.width}″{outer}
          </span>
        )
      },
    }),
    accessories: () => ({
      id: "accessories",
      accessorFn: (r) => r.accessories.length,
      header: ({ column }) => (
        <SortHeader column={column} label="Accessories" />
      ),
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.accessories.length}</span>
      ),
    }),
    racks: () => ({
      id: "racks",
      accessorKey: "rack_count",
      header: ({ column }) => <SortHeader column={column} label="Racks" />,
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.rack_count}</span>
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "Usage",
          get: (r: T) => (r.rack_count > 0 ? "in" : "out"),
          formatValue: (v: string) => ({
            label: v === "in" ? "In use" : "Unused",
          }),
        },
      },
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
