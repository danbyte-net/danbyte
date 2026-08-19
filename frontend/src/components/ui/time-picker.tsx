import * as React from "react"
import { Clock, X } from "lucide-react"

import { useDateFormat } from "@/lib/datetime"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

/**
 * The DatePicker's sibling for clock times: a trigger button opening scrollable
 * hour / minute columns (plus AM·PM under a 12-hour preference). The value is
 * always 24-hour `"HH:MM"` - only the presentation follows the user's
 * `time_style` setting, like every time Danbyte renders.
 */

export interface TimePickerProps {
  /** `"HH:MM"` (seconds tolerated), or null/"" for unset. */
  value: string | null
  onChange: (v: string | null) => void
  placeholder?: string
  disabled?: boolean
  className?: string
}

const MINUTE_STEP = 5

function parts(value: string | null): { h: number; m: number } | null {
  if (!value) return null
  const h = Number(value.slice(0, 2))
  const m = Number(value.slice(3, 5))
  return Number.isFinite(h) && Number.isFinite(m) ? { h, m } : null
}

const pad = (n: number) => String(n).padStart(2, "0")

export function TimePicker({
  value,
  onChange,
  placeholder = "Time",
  disabled,
  className,
}: TimePickerProps) {
  const [open, setOpen] = React.useState(false)
  const { settings } = useDateFormat()
  const twelve = settings.time_style === "12h"
  const sel = parts(value)

  const label = sel
    ? twelve
      ? `${((sel.h + 11) % 12) + 1}:${pad(sel.m)} ${sel.h < 12 ? "AM" : "PM"}`
      : `${pad(sel.h)}:${pad(sel.m)}`
    : null

  const set = (h: number, m: number, close = false) => {
    onChange(`${pad(h)}:${pad(m)}`)
    if (close) setOpen(false)
  }
  // Picking from nothing starts at a sane default rather than 00:00.
  const base = sel ?? { h: 9, m: 0 }

  const hours = twelve
    ? Array.from({ length: 12 }, (_, i) => (i === 0 ? 12 : i))
    : Array.from({ length: 24 }, (_, i) => i)
  const minutes = Array.from(
    { length: 60 / MINUTE_STEP },
    (_, i) => i * MINUTE_STEP
  )

  const toH24 = (display: number) => {
    if (!twelve) return display
    const pm = base.h >= 12
    const h = display % 12
    return pm ? h + 12 : h
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          className={cn(
            "justify-start px-2.5 font-normal",
            !sel && "text-muted-foreground",
            className
          )}
        >
          <Clock className="size-3.5 text-muted-foreground" />
          {label ? <span className="num">{label}</span> : placeholder}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-2" align="start">
        <div className="flex gap-1">
          <Column
            label="Hour"
            values={hours}
            display={(h) => (twelve ? String(h) : pad(h))}
            isSelected={(h) =>
              sel !== null &&
              (twelve ? ((sel.h + 11) % 12) + 1 === h : sel.h === h)
            }
            onPick={(h) => set(toH24(h), base.m)}
          />
          <Column
            label="Min"
            values={minutes}
            display={pad}
            isSelected={(m) => sel !== null && sel.m === m}
            onPick={(m) => set(base.h, m, true)}
          />
          {twelve && (
            <div className="flex flex-col gap-1 pt-6">
              {(["AM", "PM"] as const).map((half) => {
                const active = sel !== null && sel.h >= 12 === (half === "PM")
                return (
                  <button
                    key={half}
                    type="button"
                    className={cn(
                      "num rounded-md px-2 py-1 text-[12px]",
                      active
                        ? "bg-primary text-primary-foreground"
                        : "hover:bg-accent"
                    )}
                    onClick={() =>
                      set((base.h % 12) + (half === "PM" ? 12 : 0), base.m)
                    }
                  >
                    {half}
                  </button>
                )
              })}
            </div>
          )}
        </div>
        {value && (
          <button
            type="button"
            className="mt-1.5 flex w-full items-center justify-center gap-1 rounded-md py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => {
              onChange(null)
              setOpen(false)
            }}
          >
            <X className="h-3 w-3" /> Clear time
          </button>
        )}
      </PopoverContent>
    </Popover>
  )
}

function Column({
  label,
  values,
  display,
  isSelected,
  onPick,
}: {
  label: string
  values: number[]
  display: (v: number) => string
  isSelected: (v: number) => boolean
  onPick: (v: number) => void
}) {
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    // Land the column on the current value, like the month grid lands on the
    // selected date.
    ref.current
      ?.querySelector("[data-selected=true]")
      ?.scrollIntoView({ block: "center" })
  }, [])
  return (
    <div className="flex flex-col">
      <span className="pb-1 text-center text-[10px] tracking-wide text-muted-foreground uppercase">
        {label}
      </span>
      <div
        ref={ref}
        className="max-h-52 w-14 overflow-y-auto rounded-md border border-border p-0.5"
      >
        {values.map((v) => {
          const active = isSelected(v)
          return (
            <button
              key={v}
              type="button"
              data-selected={active || undefined}
              className={cn(
                "num block w-full rounded-[4px] px-1 py-1 text-center text-[12px]",
                active
                  ? "bg-primary text-primary-foreground"
                  : "hover:bg-accent"
              )}
              onClick={() => onPick(v)}
            >
              {display(v)}
            </button>
          )
        })}
      </div>
    </div>
  )
}
