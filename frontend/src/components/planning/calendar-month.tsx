import { useMemo } from "react"
import { Link } from "@tanstack/react-router"
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core"
import { CalendarClock, Flag, Wrench, Zap } from "lucide-react"

import type {
  PlanningCalendar,
  PlanningCalendarChange,
  PlanningCalendarEvent,
  PlanningCalendarMilestone,
  PlanningCalendarTask,
} from "@/lib/api"
import { ColorBadge } from "@/components/cells/color-badge"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
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

/** ISO-8601 week number — the week containing that date's Thursday. */
export function isoWeek(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const day = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  return Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
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
  days,
  tall = false,
  onMoveTask,
  onMoveMilestone,
}: {
  year: number
  month: number
  data: PlanningCalendar | undefined
  /** `YYYY-MM-DD` in the viewer's effective timezone. */
  today: string
  onPickDay?: (day: string) => void
  /** Override the drawn days (a multiple of 7) — the week view passes 7. */
  days?: Date[]
  /** Taller cells, for the week view where one row carries a whole week. */
  tall?: boolean
  /** When set, a task bar can be dragged onto another day: the span shifts,
   *  keeping its length. */
  onMoveTask?: (task: PlanningCalendarTask, day: string) => void
  /** Milestones are a single day — dropping one re-dates it. */
  onMoveMilestone?: (m: PlanningCalendarMilestone, day: string) => void
}) {
  const cells = useMemo(
    () => days ?? monthCells(year, month),
    [days, year, month]
  )
  const weeks = useMemo(
    () =>
      Array.from({ length: cells.length / 7 }, (_, i) =>
        cells.slice(i * 7, i * 7 + 7)
      ),
    [cells]
  )
  // An 8px activation threshold keeps plain clicks (open the task) working —
  // the same trick the kanban board uses.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  )
  const handleDragEnd = (ev: DragEndEvent) => {
    const day = ev.over?.id
    const payload = ev.active.data.current as
      | { task?: PlanningCalendarTask; milestone?: PlanningCalendarMilestone }
      | undefined
    if (typeof day !== "string" || !payload) return
    if (payload.task && onMoveTask) onMoveTask(payload.task, day)
    if (payload.milestone && onMoveMilestone)
      onMoveMilestone(payload.milestone, day)
  }

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
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <div className="overflow-hidden rounded-lg border border-border">
        <div className="grid grid-cols-[1.75rem_repeat(7,minmax(0,1fr))] border-b border-border bg-muted/30">
          <div aria-hidden />
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
                    <DroppableCell
                      key={key}
                      id={key}
                      droppable={!!(onMoveTask || onMoveMilestone)}
                      onClick={onPickDay ? () => onPickDay(key) : undefined}
                      className={cn(
                        "flex flex-col items-start border-r border-border p-1 text-left last:border-r-0",
                        tall ? "min-h-96" : "min-h-28",
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
                          <Tooltip key={e.id}>
                            <TooltipTrigger asChild>
                              <span
                                className={cn(
                                  "flex cursor-default items-center gap-1 truncate text-[11px]",
                                  e.kind === "outage"
                                    ? "text-red-600 dark:text-red-400"
                                    : "text-amber-600 dark:text-amber-400",
                                  !e.is_open && "opacity-50"
                                )}
                              >
                                {e.kind === "outage" ? (
                                  <Zap className="h-3 w-3 shrink-0" />
                                ) : (
                                  <Wrench className="h-3 w-3 shrink-0" />
                                )}
                                <span className="truncate">{e.name}</span>
                              </span>
                            </TooltipTrigger>
                            <TooltipContent
                              side="top"
                              variant="panel"
                              className="max-w-xs flex-col items-start gap-0.5 text-[11px]"
                            >
                              <EventTip event={e} />
                            </TooltipContent>
                          </Tooltip>
                        ))}
                        {(byDay.milestones.get(key) ?? []).map((m) => (
                          <Tooltip key={m.id}>
                            <TooltipTrigger asChild>
                              <DraggableChip
                                id={`milestone|${m.id}`}
                                data={{ milestone: m }}
                                enabled={!!onMoveMilestone}
                              >
                                <Flag className="h-3 w-3 shrink-0 text-muted-foreground" />
                                <ColorBadge
                                  name={m.name}
                                  color={m.color || undefined}
                                />
                              </DraggableChip>
                            </TooltipTrigger>
                            <TooltipContent
                              side="top"
                              variant="panel"
                              className="max-w-xs flex-col items-start gap-0.5 text-[11px]"
                            >
                              <p className="font-medium">Milestone: {m.name}</p>
                              <p className="text-muted-foreground">
                                {m.board_name} — tasks roll up to this target.
                              </p>
                            </TooltipContent>
                          </Tooltip>
                        ))}
                        {(byDay.changes.get(key) ?? []).map((c) => (
                          <Tooltip key={c.id}>
                            <TooltipTrigger asChild>
                              <span className="flex cursor-default items-center gap-1 truncate text-[11px] text-muted-foreground">
                                <CalendarClock className="h-3 w-3 shrink-0 text-primary" />
                                <span className="truncate">
                                  {c.fields.join(", ") || "Change"}
                                </span>
                              </span>
                            </TooltipTrigger>
                            <TooltipContent
                              side="top"
                              variant="panel"
                              className="max-w-xs flex-col items-start gap-0.5 text-[11px]"
                            >
                              <p className="font-medium">
                                Planned change —{" "}
                                {c.fields.join(", ") || "fields"}
                              </p>
                              <p className="text-muted-foreground">
                                On task “{c.task_title}”. Applied by hand when
                                the work is done — nothing changes by itself.
                              </p>
                            </TooltipContent>
                          </Tooltip>
                        ))}
                      </span>
                    </DroppableCell>
                  )
                })}
              </div>

              {/* Bars live in their own grid layered over the week: a span has to
                cross day boundaries, which a single cell's content cannot. */}
              <div className="pointer-events-none absolute inset-x-0 top-7 grid auto-rows-[22px] grid-cols-[1.75rem_repeat(7,minmax(0,1fr))]">
                {bars.map((bar) => (
                  <Tooltip key={`${bar.task.id}|${wi}`}>
                    <TooltipTrigger asChild>
                      <TaskBar
                        bar={bar}
                        draggable={!!onMoveTask}
                        weekIndex={wi}
                      />
                    </TooltipTrigger>
                    <TooltipContent
                      side="top"
                      variant="panel"
                      className="max-w-xs flex-col items-start gap-0.5 text-[11px]"
                    >
                      <p className="font-medium">{bar.task.title}</p>
                      <p className="text-muted-foreground">
                        {bar.task.board_name} · {bar.task.status_name}
                        {bar.task.assignees.length
                          ? ` · ${bar.task.assignees.join(", ")}`
                          : ""}
                      </p>
                      <p className="text-muted-foreground">
                        {bar.task.start_date ?? "—"} →{" "}
                        {bar.task.due_date ?? "—"}
                      </p>
                    </TooltipContent>
                  </Tooltip>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </DndContext>
  )
}

function EventTip({ event }: { event: PlanningCalendarEvent }) {
  const when =
    event.starts_at.slice(0, 16).replace("T", " ") +
    (event.ends_at
      ? ` → ${event.ends_at.slice(0, 16).replace("T", " ")}`
      : event.etr
        ? ` · ETR ${event.etr.slice(0, 16).replace("T", " ")}`
        : " · open-ended")
  return (
    <>
      <p className="font-medium">
        {event.kind === "outage" ? "Outage" : "Maintenance"}: {event.name}
      </p>
      <p className="text-muted-foreground">
        {event.provider_name || "Internal"} · {event.status_name}
        {event.impact_count
          ? ` · ${event.impact_count} object${event.impact_count === 1 ? "" : "s"} impacted`
          : ""}
      </p>
      <p className="text-muted-foreground">{when}</p>
    </>
  )
}

/** A day cell that accepts dropped bars/chips. Renders as the plain cell
 *  button when dragging is off, so month browsing stays untouched. */
function DroppableCell({
  id,
  droppable,
  onClick,
  className,
  children,
}: {
  id: string
  droppable: boolean
  onClick?: () => void
  className?: string
  children: React.ReactNode
}) {
  const { setNodeRef, isOver } = useDroppable({ id, disabled: !droppable })
  return (
    <button
      ref={setNodeRef}
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={cn(className, droppable && isOver && "bg-accent/60")}
    >
      {children}
    </button>
  )
}

/** A one-day chip (milestone) that can be dragged onto another day. */
function DraggableChip({
  id,
  data,
  enabled,
  children,
}: {
  id: string
  data: Record<string, unknown>
  enabled: boolean
  children: React.ReactNode
}) {
  const drag = useDraggable({ id, data, disabled: !enabled })
  return (
    <span
      ref={drag.setNodeRef}
      {...drag.attributes}
      {...drag.listeners}
      style={
        drag.transform
          ? {
              transform: `translate(${drag.transform.x}px, ${drag.transform.y}px)`,
              zIndex: 30,
              position: "relative",
            }
          : undefined
      }
      className={cn(
        "flex items-center gap-1 truncate text-[11px]",
        enabled ? "cursor-grab touch-none" : "cursor-default",
        drag.isDragging && "opacity-70"
      )}
    >
      {children}
    </span>
  )
}

/** One task bar in the overlay grid — a link, and (with change rights) a
 *  draggable: drop it on a day and the whole span shifts there. */
function TaskBar({
  bar,
  draggable,
  weekIndex,
}: {
  bar: Bar
  draggable: boolean
  weekIndex: number
}) {
  const drag = useDraggable({
    // A long task renders once per week it crosses; each rendering needs its
    // own drag identity or dnd-kit sees duplicate ids.
    id: `task|${bar.task.id}|${weekIndex}`,
    data: { task: bar.task },
    disabled: !draggable,
  })
  return (
    <Link
      ref={drag.setNodeRef}
      {...drag.attributes}
      {...drag.listeners}
      to="/planning/$boardId/tasks/$taskId"
      params={{ boardId: bar.task.board, taskId: bar.task.id }}
      style={{
        // +1: the first grid column is the week-number gutter.
        gridColumnStart: bar.from + 1,
        gridColumnEnd: bar.to + 1,
        gridRowStart: bar.lane + 1,
        ...(bar.task.status_color
          ? {
              backgroundColor: `${bar.task.status_color}2b`,
              borderColor: `${bar.task.status_color}80`,
            }
          : {}),
        ...(drag.transform
          ? {
              transform: `translate(${drag.transform.x}px, ${drag.transform.y}px)`,
              zIndex: 30,
            }
          : {}),
      }}
      className={cn(
        "pointer-events-auto mx-1 h-[19px] truncate rounded-[5px] border px-1.5 text-[11px] leading-[17px] hover:brightness-125",
        !bar.task.status_color && "border-border bg-muted",
        bar.continuesBefore && "ml-0 rounded-l-none border-l-0",
        bar.continuesAfter && "mr-0 rounded-r-none border-r-0",
        draggable && "touch-none",
        drag.isDragging && "opacity-70"
      )}
    >
      {bar.continuesBefore && "‹ "}
      {bar.task.title}
      {bar.continuesAfter && " ›"}
    </Link>
  )
}
