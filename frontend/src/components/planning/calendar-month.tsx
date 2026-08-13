import { useMemo } from "react"
import { Link } from "@tanstack/react-router"
import { CalendarClock, Flag, Wrench, Zap } from "lucide-react"

import type {
  PlanningCalendar,
  PlanningCalendarChange,
  PlanningCalendarEvent,
  PlanningCalendarMilestone,
  PlanningCalendarTask,
} from "@/lib/api"
import { ColorBadge } from "@/components/cells/color-badge"
import { cn } from "@/lib/utils"

/**
 * A month, with work drawn across it.
 *
 * Tasks are *spans*, so they render as bars that run through the days they
 * cover and carry an arrow where they continue past the edge of a week — the
 * thing a list of due dates cannot show. Milestones and planned changes happen
 * on one day, so they sit inside that day's cell.
 *
 * "Today" comes from the caller's effective timezone, not the browser's, so an
 * operator in Copenhagen and a server in UTC agree about which cell is today.
 */

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

export function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`
}

/** The 6×7 grid a month is drawn on, Monday first, including the days either
 *  side that fill the first and last weeks. */
function nextDay(dayIso: string): string {
  const [y, m, d] = dayIso.split("-").map(Number)
  return iso(new Date(y, m - 1, d + 1))
}

export function monthCells(year: number, month: number): Date[] {
  const first = new Date(year, month, 1)
  const lead = (first.getDay() + 6) % 7
  return Array.from(
    { length: 42 },
    (_, i) => new Date(year, month, 1 - lead + i)
  )
}

interface Bar {
  task: PlanningCalendarTask
  /** 1-based grid columns, inclusive start / exclusive end. */
  from: number
  to: number
  continuesBefore: boolean
  continuesAfter: boolean
  lane: number
}

/** Pack a week's task spans into lanes so no two bars overlap on a row. */
function layOutWeek(week: Date[], tasks: PlanningCalendarTask[]): Bar[] {
  const weekStart = iso(week[0])
  const weekEnd = iso(week[6])
  const bars: Omit<Bar, "lane">[] = []

  for (const task of tasks) {
    // A task dated at one end only occupies that single day.
    const start = task.start_date ?? task.due_date
    const end = task.due_date ?? task.start_date
    if (!start || !end) continue
    if (end < weekStart || start > weekEnd) continue
    const fromIndex = week.findIndex((d) => iso(d) >= start)
    const toIndex = week.reduce((last, d, i) => (iso(d) <= end ? i : last), 0)
    bars.push({
      task,
      from: (fromIndex === -1 ? 0 : fromIndex) + 1,
      to: toIndex + 2,
      continuesBefore: start < weekStart,
      continuesAfter: end > weekEnd,
    })
  }

  // Longest first, then by start: the bars that span the week get the top
  // lanes, which keeps a month readable instead of a staircase.
  bars.sort((a, b) => b.to - b.from - (a.to - a.from) || a.from - b.from)

  const laneEnds: number[] = []
  return bars.map((bar) => {
    let lane = laneEnds.findIndex((end) => end <= bar.from)
    if (lane === -1) lane = laneEnds.length
    laneEnds[lane] = bar.to
    return { ...bar, lane }
  })
}

export function CalendarMonth({
  year,
  month,
  data,
  today,
  onPickDay,
}: {
  year: number
  month: number
  data: PlanningCalendar | undefined
  /** `YYYY-MM-DD` in the viewer's effective timezone. */
  today: string
  onPickDay?: (day: string) => void
}) {
  const cells = useMemo(() => monthCells(year, month), [year, month])
  const weeks = useMemo(
    () => Array.from({ length: 6 }, (_, i) => cells.slice(i * 7, i * 7 + 7)),
    [cells]
  )

  const byDay = useMemo(() => {
    const milestones = new Map<string, PlanningCalendarMilestone[]>()
    const changes = new Map<string, PlanningCalendarChange[]>()
    const events = new Map<string, PlanningCalendarEvent[]>()
    for (const m of data?.milestones ?? []) {
      if (!m.due_date) continue
      milestones.set(m.due_date, [...(milestones.get(m.due_date) ?? []), m])
    }
    for (const c of data?.changes ?? []) {
      changes.set(c.effective_date, [
        ...(changes.get(c.effective_date) ?? []),
        c,
      ])
    }
    // A window spans days; mark each day it touches. The entry carries times,
    // so the tooltip still says exactly when inside the day.
    for (const e of data?.events ?? []) {
      const from = e.starts_at.slice(0, 10)
      const to = (e.ends_at ?? e.etr ?? e.starts_at).slice(0, 10)
      for (let d = from; d <= to; d = nextDay(d)) {
        events.set(d, [...(events.get(d) ?? []), e])
      }
    }
    return { milestones, changes, events }
  }, [data])

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="grid grid-cols-7 border-b border-border bg-muted/30">
        {WEEKDAYS.map((d) => (
          <div
            key={d}
            className="px-2 py-1.5 text-[11px] font-medium text-muted-foreground"
          >
            {d}
          </div>
        ))}
      </div>

      {weeks.map((week, wi) => {
        const bars = layOutWeek(week, data?.tasks ?? [])
        const lanes = bars.reduce((n, b) => Math.max(n, b.lane + 1), 0)
        return (
          <div
            key={wi}
            className={cn(
              "relative",
              wi < weeks.length - 1 && "border-b border-border"
            )}
          >
            <div className="grid grid-cols-7">
              {week.map((day) => {
                const key = iso(day)
                const outside = day.getMonth() !== month
                const isToday = key === today
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => onPickDay?.(key)}
                    disabled={!onPickDay}
                    className={cn(
                      "flex min-h-28 flex-col items-start border-r border-border p-1 text-left last:border-r-0",
                      outside && "bg-muted/20",
                      onPickDay && "hover:bg-accent/40"
                    )}
                  >
                    <span
                      className={cn(
                        "num inline-flex size-5 items-center justify-center rounded-full text-[11px]",
                        outside
                          ? "text-muted-foreground/60"
                          : "text-muted-foreground",
                        isToday &&
                          "bg-primary font-medium text-primary-foreground"
                      )}
                    >
                      {day.getDate()}
                    </span>
                    {/* Reserve the rows the bars are drawn on, so a day's own
                        entries start below them instead of underneath. */}
                    <span aria-hidden style={{ height: lanes * 22 }} />
                    <span className="mt-0.5 w-full space-y-0.5">
                      {(byDay.events.get(key) ?? []).map((e) => (
                        <span
                          key={e.id}
                          className={cn(
                            "flex items-center gap-1 truncate text-[11px]",
                            e.kind === "outage"
                              ? "text-red-600 dark:text-red-400"
                              : "text-amber-600 dark:text-amber-400",
                            !e.is_open && "opacity-50"
                          )}
                          title={
                            `${e.kind === "outage" ? "Outage" : "Maintenance"}: ${e.name}` +
                            (e.provider_name ? ` — ${e.provider_name}` : "") +
                            ` · ${e.status}` +
                            (e.impact_count
                              ? ` · ${e.impact_count} object${e.impact_count === 1 ? "" : "s"}`
                              : "")
                          }
                        >
                          {e.kind === "outage" ? (
                            <Zap className="h-3 w-3 shrink-0" />
                          ) : (
                            <Wrench className="h-3 w-3 shrink-0" />
                          )}
                          <span className="truncate">{e.name}</span>
                        </span>
                      ))}
                      {(byDay.milestones.get(key) ?? []).map((m) => (
                        <span
                          key={m.id}
                          className="flex items-center gap-1 truncate text-[11px]"
                          title={`${m.name} — ${m.board_name}`}
                        >
                          <Flag className="h-3 w-3 shrink-0 text-muted-foreground" />
                          <ColorBadge
                            name={m.name}
                            color={m.color || undefined}
                          />
                        </span>
                      ))}
                      {(byDay.changes.get(key) ?? []).map((c) => (
                        <span
                          key={c.id}
                          className="flex items-center gap-1 truncate text-[11px] text-muted-foreground"
                          title={`${c.task_title}: ${c.fields.join(", ") || "change"}`}
                        >
                          <CalendarClock className="h-3 w-3 shrink-0 text-primary" />
                          <span className="truncate">
                            {c.fields.join(", ") || "Change"}
                          </span>
                        </span>
                      ))}
                    </span>
                  </button>
                )
              })}
            </div>

            {/* Bars live in their own grid layered over the week: a span has to
                cross day boundaries, which a single cell's content cannot. */}
            <div className="pointer-events-none absolute inset-x-0 top-7 grid auto-rows-[22px] grid-cols-7">
              {bars.map((bar) => (
                <Link
                  key={bar.task.id}
                  to="/planning/$boardId/tasks/$taskId"
                  params={{ boardId: bar.task.board, taskId: bar.task.id }}
                  style={{
                    gridColumnStart: bar.from,
                    gridColumnEnd: bar.to,
                    gridRowStart: bar.lane + 1,
                    ...(bar.task.status_color
                      ? {
                          backgroundColor: `${bar.task.status_color}2b`,
                          borderColor: `${bar.task.status_color}80`,
                        }
                      : {}),
                  }}
                  className={cn(
                    "pointer-events-auto mx-1 h-[19px] truncate rounded-[5px] border px-1.5 text-[11px] leading-[17px] hover:brightness-125",
                    !bar.task.status_color && "border-border bg-muted",
                    bar.continuesBefore && "ml-0 rounded-l-none border-l-0",
                    bar.continuesAfter && "mr-0 rounded-r-none border-r-0"
                  )}
                  title={`${bar.task.title} — ${bar.task.board_name} · ${bar.task.status_name}`}
                >
                  {bar.continuesBefore && "‹ "}
                  {bar.task.title}
                  {bar.continuesAfter && " ›"}
                </Link>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
