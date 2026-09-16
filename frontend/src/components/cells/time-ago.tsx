import { type ColumnDef } from "@tanstack/react-table"
import { SortHeader } from "@/components/data-table"
import { useDateFormat } from "@/lib/datetime"
import { useUserPrefs } from "@/lib/use-user-prefs"

// Relative-time helper. Pure - call anywhere.
export function timeAgo(iso: string): string {
  const delta = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  const future = delta < 0
  const s = Math.abs(delta)
  const unit =
    s < 60
      ? `${s}s`
      : s < 3600
        ? `${Math.floor(s / 60)}m`
        : s < 86400
          ? `${Math.floor(s / 3600)}h`
          : `${Math.floor(s / 86400)}d`
  return future ? `in ${unit}` : `${unit} ago`
}

/** Timestamp cell honouring the user's `time_format` preference (relative vs
 * absolute). The absolute form - rendered per the effective date/time display
 * settings (format, 12/24h clock, timezone) - is always available on hover. */
export function TimeCell({
  iso,
  align,
}: {
  iso: string
  align?: "left" | "right"
}) {
  const { values } = useUserPrefs()
  const { formatDateTime } = useDateFormat()
  const absolute = values.time_format === "absolute"
  const exact = formatDateTime(iso)
  return (
    <span
      title={exact}
      className={
        "text-xs text-muted-foreground " +
        (align === "right" ? "block text-right" : "")
      }
    >
      {absolute ? exact : timeAgo(iso)}
    </span>
  )
}

interface TimeAgoColumnOpts<T> {
  id?: string
  header?: string
  /** Accessor for the ISO timestamp. */
  get: (row: T) => string | null | undefined
  align?: "left" | "right"
}

// Drop-in "X ago" column for any TanStack Table. Sortable.
//
//   timeAgoColumn<Prefix>({ id: "updated", header: "Updated", get: (r) => r.updated_at })
export function timeAgoColumn<T>(
  opts: TimeAgoColumnOpts<T>
): ColumnDef<T, unknown> {
  const id = opts.id ?? "updated"
  const header = opts.header ?? "Updated"
  return {
    id,
    accessorFn: (r) => opts.get(r) ?? "",
    header: ({ column }) => <SortHeader column={column} label={header} />,
    cell: ({ row }) => {
      const iso = opts.get(row.original)
      if (!iso) return <span className="text-muted-foreground">-</span>
      return <TimeCell iso={iso} align={opts.align} />
    },
  }
}
