import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { CabinetRole } from "@/lib/api"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { ColorBadge } from "@/components/cells/color-badge"
import { numidColumn } from "@/components/cells/numid"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of cabinet roles". A role is a
// coloured catalog object, so its name always renders as its ColorBadge.

export type CabinetRoleColumnId =
  | "numid"
  | "name"
  | "description"
  | "cabinets"
  | "updated"

const CANONICAL_ORDER: CabinetRoleColumnId[] = [
  "numid",
  "name",
  "description",
  "cabinets",
  "updated",
]

export interface CabinetRoleColumnOpts<T extends CabinetRole = CabinetRole> {
  /** Drop columns. */
  omit?: CabinetRoleColumnId[]
  /** Keep only these columns (canonical order still applies). */
  include?: CabinetRoleColumnId[]
  /** Leading checkbox column for bulk selection. */
  selection?: boolean
  /** Leading "#" numid column - gate on `useMe().humanIds`. */
  humanIds?: boolean
  /** Trailing RowActions column. */
  actions?: ActionsColumnOpts<T>
}

export function buildCabinetRoleColumns<T extends CabinetRole = CabinetRole>(
  opts: CabinetRoleColumnOpts<T> = {}
): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  if (!opts.humanIds) omit.add("numid")
  const keep = (id: CabinetRoleColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))

  const byId: Record<CabinetRoleColumnId, () => ColumnDef<T, unknown>> = {
    numid: () => numidColumn<T>({ get: (r) => r.numid }),
    name: () => ({
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <Link
          to="/cabinet-roles/$id"
          params={{ id: row.original.id }}
          className="hover:opacity-90"
        >
          <ColorBadge
            name={row.original.name}
            color={row.original.color || undefined}
          />
        </Link>
      ),
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
