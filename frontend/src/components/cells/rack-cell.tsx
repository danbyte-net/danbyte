import { type ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import { SortHeader } from "@/components/data-table"

// Canonical "render a Rack reference" + "Rack column" pair. Surfaces a
// rack name as a clickable link to /racks/$id.
//
//   <RackCell rack={...} />
//   rackColumn<MyRow>({ get: r => r.rack })

export interface RackLike {
  id: string
  name: string
}

export interface RackCellProps {
  rack: RackLike | null | undefined
  /** Wrap the name in a /racks/$id link. Default true. */
  linked?: boolean
  /** Optional class on the wrapper (e.g. text sizing). */
  className?: string
}

export function RackCell({ rack, linked = true, className }: RackCellProps) {
  if (!rack) {
    return <span className="text-muted-foreground">—</span>
  }
  if (!linked) {
    return <span className={className}>{rack.name}</span>
  }
  return (
    <Link
      to="/racks/$id"
      params={{ id: rack.id }}
      className={className ? `${className} hover:underline` : "hover:underline"}
    >
      {rack.name}
    </Link>
  )
}

export interface RackColumnOpts<T> {
  id?: string
  header?: string
  get: (row: T) => RackLike | null | undefined
  linked?: boolean
}

export function rackColumn<T>(opts: RackColumnOpts<T>): ColumnDef<T, unknown> {
  const id = opts.id ?? "rack"
  const header = opts.header ?? "Rack"
  return {
    id,
    accessorFn: (r) => opts.get(r)?.name ?? "",
    header: ({ column }) => <SortHeader column={column} label={header} />,
    cell: ({ row }) => (
      <RackCell rack={opts.get(row.original)} linked={opts.linked} />
    ),
    meta: {
      facet: {
        kind: "enum",
        label: header,
        get: (r: T) => opts.get(r)?.id ?? "__none__",
        formatValue: (_v, sample) => ({
          label: opts.get(sample)?.name ?? "No rack",
        }),
      },
    },
  }
}
