import { type ColumnDef } from "@tanstack/react-table"

/**
 * A small leading "#" column showing an object's per-tenant human-readable
 * number (numid). Mirror of `tagsColumn`/`timeAgoColumn`. Callers gate its
 * inclusion on the `human_ids_enabled` deployment toggle (`useMe().humanIds`).
 */
export function numidColumn<T>({
  get,
}: {
  get: (row: T) => number | null
}): ColumnDef<T> {
  return {
    id: "numid",
    header: "#",
    accessorFn: (r) => get(r) ?? undefined,
    cell: ({ row }) => {
      const n = get(row.original)
      return n != null ? (
        <span className="num font-mono text-xs text-muted-foreground">
          #{n}
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      )
    },
  }
}
