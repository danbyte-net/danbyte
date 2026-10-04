import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { CabinetType } from "@/lib/api"
import { outerSize, plateSize } from "@/lib/cabinets"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { PlannedChangeMarker } from "@/components/planning/planned-change-badge"
import { dash } from "@/components/cells/dash"
import { numidColumn } from "@/components/cells/numid"
import { manufacturerColumn } from "@/components/cells/manufacturer-cell"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of cabinet types" - the catalog list
// and any embedded listing build their columns here so an enclosure-model row
// reads identically everywhere.

export type CabinetTypeColumnId =
  | "numid"
  | "name"
  | "manufacturer"
  | "size"
  | "plate"
  | "cabinets"
  | "description"
  | "updated"

const CANONICAL_ORDER: CabinetTypeColumnId[] = [
  "numid",
  "name",
  "manufacturer",
  "size",
  "plate",
  "cabinets",
  "description",
  "updated",
]

export interface CabinetTypeColumnOpts<T extends CabinetType = CabinetType> {
  /** Drop columns. */
  omit?: CabinetTypeColumnId[]
  /** Keep only these columns (canonical order still applies). */
  include?: CabinetTypeColumnId[]
  /** Leading checkbox column for bulk selection. */
  selection?: boolean
  /** Leading "#" numid column - gate on `useMe().humanIds`. */
  humanIds?: boolean
  /** Trailing RowActions column. */
  actions?: ActionsColumnOpts<T>
}

export function buildCabinetTypeColumns<T extends CabinetType = CabinetType>(
  opts: CabinetTypeColumnOpts<T> = {}
): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  if (!opts.humanIds) omit.add("numid")
  const keep = (id: CabinetTypeColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))

  const byId: Record<CabinetTypeColumnId, () => ColumnDef<T, unknown>> = {
    numid: () => numidColumn<T>({ get: (r) => r.numid }),
    name: () => ({
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-1.5">
          <Link
            to="/cabinet-types/$id"
            params={{ id: row.original.id }}
            className="link font-medium"
          >
            {row.original.name}
          </Link>
          <PlannedChangeMarker
            objectType="api.cabinettype"
            objectId={row.original.id}
          />
        </span>
      ),
    }),
    manufacturer: () => manufacturerColumn<T>({ get: (r) => r.manufacturer }),
    // The box a cabinet of this model is, W×H×D - copied onto new cabinets.
    size: () => ({
      id: "size",
      header: ({ column }) => <SortHeader column={column} label="Size" />,
      accessorFn: (r) => r.outer_width_mm ?? 0,
      cell: ({ row }) => {
        const size = outerSize(row.original)
        return size ? <span className="num text-xs">{size}</span> : dash
      },
      meta: {
        field: ["outer_width_mm", "outer_height_mm", "outer_depth_mm"],
        export: { value: (r: T) => outerSize(r) ?? "" },
      },
    }),
    plate: () => ({
      id: "plate",
      header: ({ column }) => <SortHeader column={column} label="Plate" />,
      accessorFn: (r) => r.inner_width_mm * r.inner_height_mm,
      cell: ({ row }) => (
        <span className="num text-xs">{plateSize(row.original)}</span>
      ),
      meta: {
        field: ["inner_width_mm", "inner_height_mm"],
        export: { value: (r: T) => plateSize(r) },
      },
    }),
    cabinets: () => ({
      id: "cabinets",
      accessorKey: "cabinet_count",
      header: ({ column }) => <SortHeader column={column} label="Cabinets" />,
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.cabinet_count}</span>
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "Usage",
          get: (r: T) => (r.cabinet_count > 0 ? "in" : "out"),
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
          {row.original.description || "-"}
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
