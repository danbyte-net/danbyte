import * as React from "react"
import {
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { useDateFormat } from "@/lib/datetime"
import { cn } from "@/lib/utils"

// shadcn-style date picker (Popover + a self-contained month grid — no
// react-day-picker dependency). Takes/returns a plain ISO `YYYY-MM-DD` string
// ("" = no date) and DISPLAYS it per the user's effective date format, unlike
// a native <input type="date"> which is locked to browser locale + chrome.
// Theme-aware via the semantic tokens (popover, accent, primary, muted).

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/

function parseIso(v: string | null | undefined): Date | null {
  const m = v ? ISO_RE.exec(v) : null
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return isNaN(d.getTime()) ? null : d
}

function toIso(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

// Monday-first weekday header.
const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]

function MonthGrid({
  selected,
  onPick,
}: {
  selected: Date | null
  onPick: (d: Date) => void
}) {
  const today = new Date()
  const [view, setView] = React.useState<{ y: number; m: number }>(() => {
    const base = selected ?? today
    return { y: base.getFullYear(), m: base.getMonth() }
  })

  const shift = (months: number) =>
    setView(({ y, m }) => {
      const d = new Date(y, m + months, 1)
      return { y: d.getFullYear(), m: d.getMonth() }
    })

  // 6 fixed rows keep the popover height stable while paging months.
  const first = new Date(view.y, view.m, 1)
  const lead = (first.getDay() + 6) % 7 // days shown from the previous month
  const cells: Date[] = []
  for (let i = 0; i < 42; i++)
    cells.push(new Date(view.y, view.m, 1 - lead + i))

  const monthLabel = new Intl.DateTimeFormat("en-GB", {
    month: "long",
    year: "numeric",
  }).format(first)

  const nav = (label: string, months: number, Icon: typeof ChevronLeft) => (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-6 text-muted-foreground"
      aria-label={label}
      onClick={() => shift(months)}
    >
      <Icon className="size-4" />
    </Button>
  )

  return (
    <div>
      <div className="flex items-center justify-between">
        <div className="flex">
          {nav("Previous year", -12, ChevronsLeft)}
          {nav("Previous month", -1, ChevronLeft)}
        </div>
        <div className="text-xs font-medium">{monthLabel}</div>
        <div className="flex">
          {nav("Next month", 1, ChevronRight)}
          {nav("Next year", 12, ChevronsRight)}
        </div>
      </div>
      <div className="mt-2 grid grid-cols-7 text-center">
        {WEEKDAYS.map((d) => (
          <div key={d} className="py-1 text-[10px] text-muted-foreground">
            {d}
          </div>
        ))}
        {cells.map((d) => {
          const outside = d.getMonth() !== view.m
          const isSelected = selected !== null && sameDay(d, selected)
          const isToday = sameDay(d, today)
          return (
            <button
              key={d.toDateString()}
              type="button"
              onClick={() => onPick(d)}
              className={cn(
                "num mx-auto flex size-7 items-center justify-center rounded-md text-xs",
                outside ? "text-muted-foreground/50" : "text-foreground",
                isSelected
                  ? "bg-primary text-primary-foreground"
                  : "hover:bg-accent hover:text-accent-foreground",
                isToday && !isSelected && "font-semibold text-primary"
              )}
            >
              {d.getDate()}
            </button>
          )
        })}
      </div>
    </div>
  )
}

export interface DatePickerProps {
  /** ISO `YYYY-MM-DD`, or ""/null for no date. */
  value: string | null | undefined
  /** Called with an ISO `YYYY-MM-DD` string, or "" when cleared. */
  onChange: (iso: string) => void
  placeholder?: string
  disabled?: boolean
  className?: string
  id?: string
}

export function DatePicker({
  value,
  onChange,
  placeholder = "Pick a date",
  disabled,
  className,
  id,
}: DatePickerProps) {
  const [open, setOpen] = React.useState(false)
  const { formatDate } = useDateFormat()
  const selected = parseIso(value)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          id={id}
          variant="outline"
          disabled={disabled}
          className={cn(
            "w-full justify-start px-3 font-normal",
            !selected && "text-muted-foreground",
            className
          )}
        >
          <CalendarIcon className="size-4 text-muted-foreground" />
          {selected ? (
            <span className="num">{formatDate(value)}</span>
          ) : (
            placeholder
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto gap-2 p-3" align="start">
        <MonthGrid
          selected={selected}
          onPick={(d) => {
            onChange(toIso(d))
            setOpen(false)
          }}
        />
        <div className="flex items-center justify-between border-t border-border pt-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => {
              onChange(toIso(new Date()))
              setOpen(false)
            }}
          >
            Today
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-muted-foreground"
            disabled={!selected}
            onClick={() => {
              onChange("")
              setOpen(false)
            }}
          >
            Clear
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
