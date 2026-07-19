import { type ColumnDef } from "@tanstack/react-table"

import type { LifecycleState } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { SortHeader } from "@/components/data-table"

// Vendor lifecycle rendering — shared by device types (hardware) and
// platforms (OS). The user enters the dates; everything here derives:
//
//   <LifecycleBadge state={row.lifecycle_state} />
//   <LifecycleBar item={row} />                      — release → EoL bar
//   lifecycleColumn<MyRow>({ get: (r) => r })        — table column + facet

export interface LifecycleLike {
  release_date?: string | null
  end_of_support?: string | null
  lifecycle_state?: LifecycleState
}

export const LIFECYCLE_LABELS: Record<Exclude<LifecycleState, "">, string> = {
  supported: "Supported",
  eos: "End of sale",
  security_ended: "No security fixes",
  eol: "End of life",
}

const BADGE_VARIANT: Record<
  Exclude<LifecycleState, "">,
  "success" | "warning" | "destructive"
> = {
  supported: "success",
  eos: "warning",
  security_ended: "destructive",
  eol: "destructive",
}

export function LifecycleBadge({
  state,
  className,
}: {
  state: LifecycleState | undefined
  className?: string
}) {
  if (!state) return null
  return (
    <Badge variant={BADGE_VARIANT[state]} className={className}>
      {LIFECYCLE_LABELS[state]}
    </Badge>
  )
}

/** Risk-only badge for dense tables: renders nothing for "supported"/no
 *  dates — a green chip on every healthy row would be noise. */
export function LifecycleFlag({
  state,
}: {
  state: LifecycleState | undefined
}) {
  if (!state || state === "supported") return null
  return <LifecycleBadge state={state} />
}

/** Percent of the release → end-of-support window already consumed.
 *  Null when either date is missing or the window is inverted. */
export function lifecyclePct(item: LifecycleLike): number | null {
  if (!item.release_date || !item.end_of_support) return null
  const start = Date.parse(item.release_date)
  const end = Date.parse(item.end_of_support)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
    return null
  const pct = ((Date.now() - start) / (end - start)) * 100
  return Math.max(0, Math.min(100, Math.round(pct)))
}

/** Human "EoL in 3 mo" / "EoL 2 y ago" from end_of_support. */
export function eolCountdown(item: LifecycleLike): string | null {
  if (!item.end_of_support) return null
  const days = Math.round(
    (Date.parse(item.end_of_support) - Date.now()) / 86_400_000
  )
  const abs = Math.abs(days)
  const span =
    abs >= 365
      ? `${Math.round(abs / 365)} y`
      : abs >= 60
        ? `${Math.round(abs / 30)} mo`
        : `${abs} d`
  return days >= 0 ? `EoL in ${span}` : `EoL ${span} ago`
}

/** Thin lifetime bar (release → EoL) with a countdown label. Falls back to
 *  the state badge when the bar can't be computed. */
export function LifecycleBar({
  item,
  className,
}: {
  item: LifecycleLike | null | undefined
  className?: string
}) {
  if (!item) return <span className="text-muted-foreground">—</span>
  const pct = lifecyclePct(item)
  if (pct === null) {
    return item.lifecycle_state ? (
      <LifecycleBadge state={item.lifecycle_state} />
    ) : (
      <span className="text-muted-foreground">—</span>
    )
  }
  const color =
    pct >= 100 ? "bg-red-500" : pct > 85 ? "bg-amber-500" : "bg-primary"
  return (
    <div className={"flex items-center gap-2 " + (className ?? "")}>
      <div className="h-1 w-20 overflow-hidden rounded-full bg-muted">
        <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="num text-[11px] whitespace-nowrap text-muted-foreground">
        {eolCountdown(item)}
      </span>
    </div>
  )
}

export function lifecycleColumn<T>(opts: {
  get: (row: T) => LifecycleLike | null | undefined
  id?: string
  header?: string
}): ColumnDef<T, unknown> {
  const id = opts.id ?? "lifecycle"
  const header = opts.header ?? "Lifecycle"
  return {
    id,
    accessorFn: (r) => lifecyclePct(opts.get(r) ?? {}) ?? -1,
    header: ({ column }) => <SortHeader column={column} label={header} />,
    cell: ({ row }) => <LifecycleBar item={opts.get(row.original)} />,
    meta: {
      facet: {
        kind: "enum",
        label: header,
        get: (r: T) => opts.get(r)?.lifecycle_state || "__none__",
        formatValue: (v) => ({
          label:
            v === "__none__"
              ? "No dates"
              : LIFECYCLE_LABELS[v as Exclude<LifecycleState, "">],
        }),
      },
    },
  }
}
