import { type ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import { SortHeader } from "@/components/data-table"

// Canonical "render a Site reference" + "Site column" pair. Surfaces a
// site name as a clickable link to /sites/$id (never plain text).
//
//   <SiteCell site={...} />                   single inline render
//   siteColumn<MyRow>({ get: r => r.site })   drop into ColumnDef[]

export interface SiteLike {
  id: string
  name: string
}

export interface SiteCellProps {
  site: SiteLike | null | undefined
  /** Wrap the name in a /sites/$id link. Default true. */
  linked?: boolean
  /** Optional class on the wrapper (e.g. text sizing). */
  className?: string
}

export function SiteCell({ site, linked = true, className }: SiteCellProps) {
  if (!site) {
    return <span className="text-muted-foreground">—</span>
  }
  if (!linked) {
    return <span className={className}>{site.name}</span>
  }
  return (
    <Link
      to="/sites/$id"
      params={{ id: site.id }}
      className={className ? `${className} hover:underline` : "hover:underline"}
    >
      {site.name}
    </Link>
  )
}

export interface SiteColumnOpts<T> {
  id?: string
  header?: string
  get: (row: T) => SiteLike | null | undefined
  linked?: boolean
}

export function siteColumn<T>(opts: SiteColumnOpts<T>): ColumnDef<T, unknown> {
  const id = opts.id ?? "site"
  const header = opts.header ?? "Site"
  return {
    id,
    accessorFn: (r) => opts.get(r)?.name ?? "",
    header: ({ column }) => <SortHeader column={column} label={header} />,
    cell: ({ row }) => (
      <SiteCell site={opts.get(row.original)} linked={opts.linked} />
    ),
    meta: {
      facet: {
        kind: "enum",
        label: header,
        get: (r: T) => opts.get(r)?.id ?? "__none__",
        formatValue: (_v, sample) => ({
          label: opts.get(sample)?.name ?? "No site",
        }),
      },
    },
  }
}
