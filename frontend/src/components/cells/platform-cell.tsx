import { type ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import { SortHeader } from "@/components/data-table"

// Canonical "render a Platform reference" + "Platform column" pair.
// Surfaces a platform name as a clickable link to /platforms/$id.
//
//   <PlatformCell platform={...} />
//   platformColumn<MyRow>({ get: r => r.platform })

export interface PlatformLike {
  id: string
  name: string
}

export interface PlatformCellProps {
  platform: PlatformLike | null | undefined
  /** Wrap the name in a /platforms/$id link. Default true. */
  linked?: boolean
  /** Optional class on the wrapper (e.g. text sizing). */
  className?: string
}

export function PlatformCell({
  platform,
  linked = true,
  className,
}: PlatformCellProps) {
  if (!platform) {
    return <span className="text-muted-foreground">—</span>
  }
  if (!linked) {
    return <span className={className}>{platform.name}</span>
  }
  return (
    <Link
      to="/platforms/$id"
      params={{ id: platform.id }}
      className={className ? `${className} hover:underline` : "hover:underline"}
    >
      {platform.name}
    </Link>
  )
}

export interface PlatformColumnOpts<T> {
  id?: string
  header?: string
  get: (row: T) => PlatformLike | null | undefined
  linked?: boolean
}

export function platformColumn<T>(
  opts: PlatformColumnOpts<T>
): ColumnDef<T, unknown> {
  const id = opts.id ?? "platform"
  const header = opts.header ?? "Platform"
  return {
    id,
    accessorFn: (r) => opts.get(r)?.name ?? "",
    header: ({ column }) => <SortHeader column={column} label={header} />,
    cell: ({ row }) => (
      <PlatformCell platform={opts.get(row.original)} linked={opts.linked} />
    ),
    meta: {
      facet: {
        kind: "enum",
        label: header,
        get: (r: T) => opts.get(r)?.id ?? "__none__",
        formatValue: (_v, sample) => ({
          label: opts.get(sample)?.name ?? "No platform",
        }),
      },
    },
  }
}
