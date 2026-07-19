import { type ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import { SortHeader } from "@/components/data-table"

// Canonical "render a Manufacturer reference" + "Manufacturer column"
// pair. Surfaces a name as a clickable link to /manufacturers/$id.
//
//   <ManufacturerCell manufacturer={...} />
//   manufacturerColumn<MyRow>({ get: r => r.manufacturer })

export interface ManufacturerLike {
  id: string
  name: string
}

export interface ManufacturerCellProps {
  manufacturer: ManufacturerLike | null | undefined
  /** Wrap the name in a /manufacturers/$id link. Default true. */
  linked?: boolean
  /** Optional class on the wrapper (e.g. text sizing). */
  className?: string
}

export function ManufacturerCell({
  manufacturer,
  linked = true,
  className,
}: ManufacturerCellProps) {
  if (!manufacturer) {
    return <span className="text-muted-foreground">—</span>
  }
  if (!linked) {
    return <span className={className}>{manufacturer.name}</span>
  }
  return (
    <Link
      to="/manufacturers/$id"
      params={{ id: manufacturer.id }}
      className={className ? `${className} hover:underline` : "hover:underline"}
    >
      {manufacturer.name}
    </Link>
  )
}

export interface ManufacturerColumnOpts<T> {
  id?: string
  header?: string
  get: (row: T) => ManufacturerLike | null | undefined
  linked?: boolean
}

export function manufacturerColumn<T>(
  opts: ManufacturerColumnOpts<T>
): ColumnDef<T, unknown> {
  const id = opts.id ?? "manufacturer"
  const header = opts.header ?? "Manufacturer"
  return {
    id,
    accessorFn: (r) => opts.get(r)?.name ?? "",
    header: ({ column }) => <SortHeader column={column} label={header} />,
    cell: ({ row }) => (
      <ManufacturerCell
        manufacturer={opts.get(row.original)}
        linked={opts.linked}
      />
    ),
    meta: {
      facet: {
        kind: "enum",
        label: header,
        get: (r: T) => opts.get(r)?.id ?? "__none__",
        formatValue: (_v, sample) => ({
          label: opts.get(sample)?.name ?? "No manufacturer",
        }),
      },
    },
  }
}
