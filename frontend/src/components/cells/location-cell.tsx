import { type ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import { SortHeader } from "@/components/data-table"

// Canonical "render a Location reference" + "Location column" pair.
// Surfaces a location name as a clickable link to /locations/$id.
//
//   <LocationCell location={...} />
//   locationColumn<MyRow>({ get: r => r.location })

export interface LocationLike {
  id: string
  name: string
}

export interface LocationCellProps {
  location: LocationLike | null | undefined
  /** Wrap the name in a /locations/$id link. Default true. */
  linked?: boolean
  /** Optional class on the wrapper (e.g. text sizing). */
  className?: string
  /** Shown, muted, for no location (default a dash) - e.g. "Whole site". */
  emptyLabel?: string
}

export function LocationCell({
  location,
  linked = true,
  className,
  emptyLabel,
}: LocationCellProps) {
  if (!location) {
    return (
      <span
        className={
          className
            ? `${className} text-muted-foreground`
            : "text-muted-foreground"
        }
      >
        {emptyLabel ?? "-"}
      </span>
    )
  }
  if (!linked) {
    return <span className={className}>{location.name}</span>
  }
  return (
    <Link
      to="/locations/$id"
      params={{ id: location.id }}
      className={className ? `${className} link` : "link"}
    >
      {location.name}
    </Link>
  )
}

export interface LocationColumnOpts<T> {
  id?: string
  header?: string
  get: (row: T) => LocationLike | null | undefined
  linked?: boolean
  /** Class on the cell (e.g. `text-xs` where the table runs small). */
  className?: string
  /** What a row with no location reads (default a dash). */
  emptyLabel?: string
}

export function locationColumn<T>(
  opts: LocationColumnOpts<T>
): ColumnDef<T, unknown> {
  const id = opts.id ?? "location"
  const header = opts.header ?? "Location"
  return {
    id,
    accessorFn: (r) => opts.get(r)?.name ?? opts.emptyLabel ?? "",
    header: ({ column }) => <SortHeader column={column} label={header} />,
    cell: ({ row }) => (
      <LocationCell
        location={opts.get(row.original)}
        linked={opts.linked}
        className={opts.className}
        emptyLabel={opts.emptyLabel}
      />
    ),
    meta: {
      facet: {
        kind: "enum",
        label: header,
        get: (r: T) => opts.get(r)?.id ?? "__none__",
        formatValue: (_v, sample) => ({
          label: opts.get(sample)?.name ?? opts.emptyLabel ?? "No location",
        }),
      },
    },
  }
}
