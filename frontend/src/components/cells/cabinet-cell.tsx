import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import { SortHeader } from "@/components/data-table"
import { dash } from "@/components/cells/dash"

// Canonical "render a Cabinet reference" + "Cabinet column" pair - the rack
// cell's twin. Surfaces a cabinet name as a link to /cabinets/$id.
//
//   <CabinetCell cabinet={...} />
//   cabinetColumn<MyRow>({ get: r => r.cabinet })

export interface CabinetLike {
  id: string
  name: string
}

export function CabinetCell({
  cabinet,
  className,
}: {
  cabinet: CabinetLike | null | undefined
  /** Optional class on the link (e.g. text sizing). */
  className?: string
}) {
  if (!cabinet) return dash
  return (
    <Link
      to="/cabinets/$id"
      params={{ id: cabinet.id }}
      className={className ? `${className} link` : "link"}
    >
      {cabinet.name}
    </Link>
  )
}

export interface CabinetColumnOpts<T> {
  id?: string
  header?: string
  get: (row: T) => CabinetLike | null | undefined
  /** Class on the cell (e.g. `text-xs` where the table runs small). */
  className?: string
}

/** A sortable Cabinet column. No facet: a cabinet narrows a list less often
 * than its site does, and the rail stays short without one. */
export function cabinetColumn<T>(
  opts: CabinetColumnOpts<T>
): ColumnDef<T, unknown> {
  const id = opts.id ?? "cabinet"
  const header = opts.header ?? "Cabinet"
  return {
    id,
    accessorFn: (r) => opts.get(r)?.name ?? "",
    header: ({ column }) => <SortHeader column={column} label={header} />,
    cell: ({ row }) => (
      <CabinetCell
        cabinet={opts.get(row.original)}
        className={opts.className}
      />
    ),
    meta: { label: header, export: { value: (r) => opts.get(r)?.name ?? "" } },
  }
}
