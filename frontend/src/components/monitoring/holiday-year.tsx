import { memo, useEffect, useId, useMemo, useRef } from "react"
import type { KeyboardEvent } from "react"

import type { HolidayDay } from "@/lib/api"
import { cn } from "@/lib/utils"
import { monthCells, WEEKDAYS } from "@/components/ui/date-picker"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  MAX_YEAR,
  MIN_YEAR,
  MONTHS,
  dayLabelLong,
  daysInYear,
  isWeekend,
  stepDay,
} from "./holiday-days"

export interface HolidayYearProps {
  year: number
  days: HolidayDay[]
  /** Today in the user's timezone, `YYYY-MM-DD`. */
  today: string
  /** The day Tab lands on (one roving tab stop for the whole year). */
  focusIso: string
  /** A day became the tab stop. It may be in another year: a key stepped
   * past the edge of this one. Stable identity keeps the months memoised. */
  onFocusDay: (iso: string) => void
  /** Stable identity, like `onFocusDay`. */
  onToggle: (iso: string) => void
  readOnly?: boolean
}

const pad = (n: number) => String(n).padStart(2, "0")

/** A holiday's square, and the inner ring that marks one that repeats every
 * year - a click on it takes it off every year, so it must not look like a
 * one-off. */
const PICKED = "bg-primary text-primary-foreground"
const YEARLY = "ring-2 ring-inset ring-primary-foreground/50"

/** What the two kinds of filled day mean. */
export function HolidayLegend({ className }: { className?: string }) {
  const swatch = (yearly: boolean, label: string) => (
    <span className="flex items-center gap-1.5">
      <span
        aria-hidden
        className={cn("size-3.5 rounded-[4px]", PICKED, yearly && YEARLY)}
      />
      {label}
    </span>
  )
  return (
    <div
      className={cn(
        "flex items-center gap-3 text-[11px] whitespace-nowrap text-muted-foreground",
        className
      )}
    >
      {swatch(false, "Holiday")}
      {swatch(true, "Every year")}
    </div>
  )
}

/**
 * A year of month grids where a click makes a day a holiday or takes it off.
 * Arrow keys move a day or a week, Home/End to the week's ends, Page Up/Down
 * a month (Shift: a year); Enter or Space toggles.
 */
export function HolidayYear({
  year,
  days,
  today,
  focusIso,
  onFocusDay,
  onToggle,
  readOnly,
}: HolidayYearProps) {
  const byMonth = useMemo(() => {
    const out = Array.from({ length: 12 }, () => new Map<string, HolidayDay>())
    for (const { iso, day } of daysInYear(days, year))
      out[Number(iso.slice(5, 7)) - 1].set(iso, day)
    return out
  }, [days, year])
  const root = useRef<HTMLDivElement>(null)
  // Focus follows the tab stop only after a key moved it; a click or a year
  // stepper press must not pull focus into the grid.
  const keyMoved = useRef(false)
  useEffect(() => {
    if (!keyMoved.current) return
    keyMoved.current = false
    root.current
      ?.querySelector<HTMLElement>(`[data-day="${focusIso}"]`)
      ?.focus()
  }, [focusIso, year])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const iso = (e.target as HTMLElement).dataset.day
    if (!iso) return
    const next = stepDay(iso, e.key, e.shiftKey)
    if (!next) return
    e.preventDefault()
    const y = Number(next.slice(0, 4))
    if (y < MIN_YEAR || y > MAX_YEAR) return
    keyMoved.current = true
    onFocusDay(next)
  }

  return (
    <div
      ref={root}
      onKeyDown={onKeyDown}
      className="grid grid-cols-[repeat(auto-fill,minmax(10.5rem,1fr))] gap-x-4 gap-y-4"
    >
      {MONTHS.map((label, m) => (
        <Month
          key={m}
          year={year}
          month={m}
          label={label}
          days={byMonth[m]}
          signature={signature(byMonth[m])}
          today={today}
          focusIso={
            focusIso.startsWith(`${year}-${pad(m + 1)}-`) ? focusIso : ""
          }
          onFocusDay={onFocusDay}
          onToggle={onToggle}
          readOnly={!!readOnly}
        />
      ))}
    </div>
  )
}

/** What a month shows of its holidays, so a month re-renders only when that
 * changes - not on every edit elsewhere in the year. */
function signature(days: Map<string, HolidayDay>): string {
  let s = ""
  for (const [iso, d] of days) s += `${iso}|${d.yearly ? 1 : 0}|${d.name}\n`
  return s
}

interface MonthProps {
  year: number
  month: number
  label: string
  days: Map<string, HolidayDay>
  signature: string
  today: string
  focusIso: string
  onFocusDay: (iso: string) => void
  onToggle: (iso: string) => void
  readOnly: boolean
}

const Month = memo(
  function Month({
    year,
    month,
    label,
    days,
    today,
    focusIso,
    onFocusDay,
    onToggle,
    readOnly,
  }: MonthProps) {
    const id = useId()
    return (
      <div role="group" aria-labelledby={id} className="w-[10.5rem]">
        <div id={id} className="mb-1 px-1 text-xs font-medium">
          {label}
        </div>
        <div className="grid grid-cols-7 justify-items-center">
          {WEEKDAYS.map((d) => (
            <div
              key={d}
              aria-hidden
              className="pb-0.5 text-[10px] text-muted-foreground"
            >
              {d}
            </div>
          ))}
          {monthCells(year, month).map((d) => {
            if (d.getMonth() !== month)
              return <div key={d.toDateString()} className="size-6" />
            const iso = `${year}-${pad(month + 1)}-${pad(d.getDate())}`
            return (
              <Day
                key={iso}
                iso={iso}
                day={days.get(iso)}
                isToday={iso === today}
                tabStop={iso === focusIso}
                onFocusDay={onFocusDay}
                onToggle={onToggle}
                readOnly={readOnly}
              />
            )
          })}
        </div>
      </div>
    )
  },
  (a, b) =>
    a.year === b.year &&
    a.month === b.month &&
    a.signature === b.signature &&
    a.today === b.today &&
    a.focusIso === b.focusIso &&
    a.readOnly === b.readOnly &&
    a.onFocusDay === b.onFocusDay &&
    a.onToggle === b.onToggle
)

function Day({
  iso,
  day,
  isToday,
  tabStop,
  onFocusDay,
  onToggle,
  readOnly,
}: {
  iso: string
  day: HolidayDay | undefined
  isToday: boolean
  tabStop: boolean
  onFocusDay: (iso: string) => void
  onToggle: (iso: string) => void
  readOnly: boolean
}) {
  const label = [dayLabelLong(iso), day?.name, day?.yearly ? "every year" : ""]
    .filter(Boolean)
    .join(", ")
  // Every day has the same Tooltip > Trigger > button tree, picked or not:
  // wrapping only picked days would remount the button on a toggle and drop
  // keyboard focus. Only a picked day has content to show.
  return (
    <Tooltip delayDuration={300}>
      {/* The button's label already says what the tip shows. */}
      <TooltipTrigger asChild aria-describedby={undefined}>
        <button
          type="button"
          data-day={iso}
          aria-pressed={!!day}
          aria-label={label}
          aria-disabled={readOnly || undefined}
          tabIndex={tabStop ? 0 : -1}
          onClick={() => {
            onFocusDay(iso)
            if (!readOnly) onToggle(iso)
          }}
          className={cn(
            "num flex size-6 items-center justify-center rounded-md text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
            day
              ? cn(PICKED, day.yearly && YEARLY)
              : cn(
                  isWeekend(iso) && "text-muted-foreground",
                  !readOnly && "hover:bg-accent hover:text-accent-foreground"
                ),
            isToday && "font-semibold underline underline-offset-2",
            isToday && !day && "text-primary",
            readOnly && "cursor-default"
          )}
        >
          {Number(iso.slice(8, 10))}
        </button>
      </TooltipTrigger>
      {day && (
        <TooltipContent variant="panel" side="top">
          {day.name || "Holiday"}
          {day.yearly && (
            <span className="text-muted-foreground">· every year</span>
          )}
        </TooltipContent>
      )}
    </Tooltip>
  )
}
