import type { ReactNode } from "react"
import type { ColumnDef } from "@tanstack/react-table"

import type {
  EffectiveOsDates,
  EolInfo,
  LifecycleNext,
  LifecycleState,
} from "@/lib/api"
import { daysBetween, isIsoDate, useDateFormat } from "@/lib/datetime"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { SortHeader } from "@/components/data-table"
import { EolBadge, useEolSettings } from "@/components/cells/eol-cell"

// Vendor lifecycle rendering - shared by device types (hardware) and
// platforms (OS) - and the one time bar every end date is drawn with:
//
//   <LifecycleBadge state={row.lifecycle_state} />
//   <LifetimeBar start={…} end={…} warningDays={…} />  - any start → end
//   <LifecycleBar item={row} />                          - a type or platform
//   lifecycleColumn<MyRow>({ get: (r) => r })            - table column + facet
//   lifecycleNextColumn<MyRow>({ get: (r) => r.lifecycle_next })
//                                         - a device's or VM's soonest end

export interface LifecycleLike extends EffectiveOsDates {
  release_date?: string | null
  end_of_support?: string | null
  lifecycle_state?: LifecycleState
  /** A platform's end-of-life data (#8); null while the feature is off. */
  eol?: EolInfo | null
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
 *  dates - a green chip on every healthy row would be noise. */
export function LifecycleFlag({
  state,
}: {
  state: LifecycleState | undefined
}) {
  if (!state || state === "supported") return null
  return <LifecycleBadge state={state} />
}

// ─── The time bar ────────────────────────────────────────────────────────

/** Where an end date came from, as the tooltip names it. */
export const DATE_SOURCE_LABELS: Record<string, string> = {
  entered: "Entered",
  endoflife_date: "endoflife.date",
}

/** What the bar's colour says: the end has passed, it falls inside the
 * source's warning window, or neither. */
export type LifetimeTone = "destructive" | "warning" | "primary"

/** The countdown's words: an end of life ("EoL in 2 y"), or a coverage end
 * ("Ends in 40 d") - whose date is the last covered day, so it passes the
 * day after, where an end of life is reached on its day. */
export type LifetimeLabel = "eol" | "coverage"

const TONE_CLASS: Record<LifetimeTone, string> = {
  destructive: "bg-destructive",
  warning: "bg-amber-500",
  primary: "bg-primary",
}

export interface LifetimeFacts {
  /** Elapsed share of start → end, 0-100; null without a start before the end. */
  pct: number | null
  /** Whole days from today to the end, negative once past; null without one. */
  daysLeft: number | null
  tone: LifetimeTone | null
  countdown: string | null
}

function span(days: number): string {
  const abs = Math.abs(days)
  if (abs >= 365) return `${Math.round(abs / 365)} y`
  if (abs >= 60) return `${Math.round(abs / 30)} mo`
  return `${abs} d`
}

/** "EoL in 2 y", "EoL 3 mo ago", "EoL today"; coverage reads "Ends in 40 d",
 * "Ended 2 mo ago", "Ends today". */
export function countdownText(
  daysLeft: number,
  label: LifetimeLabel = "eol"
): string {
  if (label === "coverage") {
    if (daysLeft === 0) return "Ends today"
    return daysLeft > 0
      ? `Ends in ${span(daysLeft)}`
      : `Ended ${span(daysLeft)} ago`
  }
  if (daysLeft === 0) return "EoL today"
  return daysLeft > 0 ? `EoL in ${span(daysLeft)}` : `EoL ${span(daysLeft)} ago`
}

/** Whether an end `daysLeft` away has passed - see {@link LifetimeLabel}. */
export function isPast(daysLeft: number, label: LifetimeLabel = "eol") {
  return label === "coverage" ? daysLeft < 0 : daysLeft <= 0
}

/** Everything a time bar shows, from bare `YYYY-MM-DD` dates. The colour goes
 * by time left, not by the share used, so it agrees with the status pills:
 * past the end destructive, inside `warningDays` warning, else primary. */
export function lifetimeFacts(opts: {
  start?: string | null
  end?: string | null
  warningDays?: number | null
  today: string
  label?: LifetimeLabel
}): LifetimeFacts {
  const { start, end, warningDays, today } = opts
  const label = opts.label ?? "eol"
  if (!end || !isIsoDate(end))
    return { pct: null, daysLeft: null, tone: null, countdown: null }
  const daysLeft = daysBetween(today, end)
  const tone: LifetimeTone = isPast(daysLeft, label)
    ? "destructive"
    : warningDays != null && daysLeft <= warningDays
      ? "warning"
      : "primary"
  let pct: number | null = null
  if (start && isIsoDate(start)) {
    const total = daysBetween(start, end)
    if (total > 0) {
      const used = (daysBetween(start, today) / total) * 100
      pct = Math.max(0, Math.min(100, Math.round(used)))
    }
  }
  return { pct, daysLeft, tone, countdown: countdownText(daysLeft, label) }
}

/**
 * The time bar: a thin track filled with the elapsed share of start → end,
 * and a terse countdown, the exact date in the shared tooltip. With an end
 * and no start it is the countdown alone; with no end it is the source's
 * pill (`fallback` - End of life, Open-ended), else `empty`. Never an empty
 * track.
 */
export function LifetimeBar({
  start,
  end,
  warningDays,
  label = "eol",
  source,
  fallback,
  empty,
  size = "sm",
  className,
}: {
  start?: string | null
  end?: string | null
  /** The source's warning window in days; an end inside it reads amber. */
  warningDays?: number | null
  label?: LifetimeLabel
  /** Where the end came from (`entered`, a source key) - named in the tooltip. */
  source?: string | null
  /** No end, but a state: the source's pill. */
  fallback?: ReactNode
  /** Nothing to show: a muted dash in a table, "No dates" on a card. */
  empty?: ReactNode
  /** `md` is a card's wider bar, with the share used beside the countdown. */
  size?: "sm" | "md"
  className?: string
}) {
  const { today, formatDate } = useDateFormat()
  const f = lifetimeFacts({ start, end, warningDays, today, label })
  if (f.daysLeft === null || !end) {
    if (fallback) return <>{fallback}</>
    return <span className="text-muted-foreground">{empty ?? "-"}</span>
  }
  const word =
    label === "coverage"
      ? isPast(f.daysLeft, label)
        ? "Ended"
        : "Ends"
      : "EoL"
  const from = source ? (DATE_SOURCE_LABELS[source] ?? source) : null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-slot="lifetime-bar"
          data-tone={f.tone ?? undefined}
          className={cn("inline-flex items-center gap-2", className)}
        >
          {f.pct !== null && (
            <span
              aria-hidden
              className={cn(
                "block shrink-0 overflow-hidden rounded-full bg-muted",
                size === "md" ? "h-1.5 w-40" : "h-1 w-20"
              )}
            >
              <span
                className={cn(
                  "block h-full rounded-full",
                  TONE_CLASS[f.tone ?? "primary"]
                )}
                style={{ width: `${f.pct}%` }}
              />
            </span>
          )}
          <span
            className={cn(
              "num whitespace-nowrap text-muted-foreground",
              size === "md" ? "text-xs" : "text-[11px]"
            )}
          >
            {size === "md" && f.pct !== null ? `${f.pct}% · ` : ""}
            {f.countdown}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent variant="panel">
        {word} {formatDate(end)}
        {from ? ` · ${from}` : ""}
      </TooltipContent>
    </Tooltip>
  )
}

// ─── A device type's or platform's lifetime ──────────────────────────────

/** A type's or platform's start → end. A platform carries `effective_*`:
 * what was entered, else its end-of-life mapping (#436). */
export function lifetimeOf(item: LifecycleLike): {
  start: string | null
  end: string | null
  source: string | null
} {
  if (
    item.effective_end !== undefined ||
    item.effective_release !== undefined ||
    item.effective_source !== undefined
  ) {
    return {
      start: item.effective_release ?? null,
      end: item.effective_end ?? null,
      source: item.effective_source ?? null,
    }
  }
  return {
    start: item.release_date ?? null,
    end: item.end_of_support ?? null,
    source: null,
  }
}

/** The pill for an item with no end date: its mapped cycle's End of life or
 * Supported when the mapping speaks for it, else the entered state. */
function lifecycleFallback(
  item: LifecycleLike,
  source: string | null
): ReactNode {
  const mapped = source !== null && source !== "entered"
  if (
    mapped &&
    (item.eol?.status === "eol" || item.eol?.status === "supported")
  )
    return <EolBadge info={item.eol} />
  if (item.lifecycle_state)
    return <LifecycleBadge state={item.lifecycle_state} />
  return null
}

/** Whether an item has anything for a lifetime row to show. */
export function hasLifetime(item: LifecycleLike | null | undefined): boolean {
  if (!item) return false
  const t = lifetimeOf(item)
  return !!t.end || lifecycleFallback(item, t.source) !== null
}

/** Percent of the start → end window already consumed - the lifecycle
 * column's sort value. Null when either date is missing or inverted. */
export function lifecyclePct(item: LifecycleLike): number | null {
  const { start, end } = lifetimeOf(item)
  if (!start || !end) return null
  const s = Date.parse(start)
  const e = Date.parse(end)
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return null
  const pct = ((Date.now() - s) / (e - s)) * 100
  return Math.max(0, Math.min(100, Math.round(pct)))
}

/** A device type's or platform's lifetime bar, coloured by the end-of-life
 * warning window (Settings → End-of-life data, 180 days unless changed). */
export function LifecycleBar({
  item,
  size,
  empty,
  className,
}: {
  item: LifecycleLike | null | undefined
  size?: "sm" | "md"
  empty?: ReactNode
  className?: string
}) {
  const eol = useEolSettings()
  if (!item)
    return <span className="text-muted-foreground">{empty ?? "-"}</span>
  const t = lifetimeOf(item)
  return (
    <LifetimeBar
      start={t.start}
      end={t.end}
      warningDays={eol.data?.warning_days}
      source={t.source}
      fallback={lifecycleFallback(item, t.source)}
      empty={empty}
      size={size}
      className={className}
    />
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

// ─── Next end of life ────────────────────────────────────────────────────

const NEXT_SOURCE_LABELS: Record<LifecycleNext["source"], string> = {
  hardware: "Hardware",
  os: "OS",
  coverage: "Coverage",
  software: "Software",
}

/** Calendar days from today to `end`, for sorting: no end sorts last. */
function daysUntil(end: string | null | undefined): number {
  if (!end || !isIsoDate(end)) return Infinity
  return daysBetween(new Date().toISOString().slice(0, 10), end)
}

function NextEndCell({ next }: { next: LifecycleNext | null | undefined }) {
  const eol = useEolSettings()
  if (!next) return <span className="text-muted-foreground">-</span>
  const coverage = next.source === "coverage"
  return (
    <span className="inline-flex items-center gap-1">
      <LifetimeBar
        start={next.start}
        end={next.end}
        label={coverage ? "coverage" : "eol"}
        // A list row does not carry the tenant's coverage window; coverage
        // has no start here either, so it is the countdown alone.
        warningDays={coverage ? null : eol.data?.warning_days}
      />
      <span className="text-[11px] whitespace-nowrap text-muted-foreground">
        · {NEXT_SOURCE_LABELS[next.source]}
      </span>
    </span>
  )
}

/** "Next end of life" (#436): the soonest end across a device's or VM's
 * sources as the time bar and which source it is, sorted by days left.
 * Hidden until ticked in the Columns menu, so existing layouts and saved
 * views keep their columns. */
export function lifecycleNextColumn<T>(opts: {
  get: (row: T) => LifecycleNext | null | undefined
}): ColumnDef<T, unknown> {
  return {
    id: "lifecycle_next",
    accessorFn: (r) => daysUntil(opts.get(r)?.end),
    header: ({ column }) => (
      <SortHeader column={column} label="Next end of life" />
    ),
    cell: ({ row }) => <NextEndCell next={opts.get(row.original)} />,
    meta: {
      label: "Next end of life",
      defaultHidden: true,
      export: {
        value: (r: T) => {
          const next = opts.get(r)
          return next ? `${next.end} (${NEXT_SOURCE_LABELS[next.source]})` : ""
        },
      },
    },
  }
}
