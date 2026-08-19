import { useEffect, useMemo, useRef, useState } from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core"
import { CalendarClock, Flag, Wrench, Zap } from "lucide-react"

import type {
  PlanningCalendar,
  PlanningCalendarEvent,
  PlanningCalendarTask,
} from "@/lib/api"
import { cn } from "@/lib/utils"
import { layOutWeek } from "./calendar-month"

/** UTC-midnight Date for an ISO day - the convention layOutWeek expects. */
const parseISODay = (d: string) => new Date(`${d}T00:00:00Z`)

/**
 * The Outlook-style time grid behind the Week and Day views: one column per
 * day, an hour axis down the left, and two altitudes of content -
 *
 * - **all-day** (the band under the headers): tasks (date-only spans, packed
 *   into lanes exactly like the month view), milestones, and planned changes;
 * - **timed** (the grid): maintenance windows and outages, drawn at their
 *   actual hours, clipped per day for multi-day windows, side-by-side when
 *   they overlap, with a now-line on today.
 *
 * Times render exactly as the API serialises them (the same convention every
 * other calendar surface uses), so the grid never re-zones a timestamp.
 */

const HOUR_H = 44 // px per hour
const DAY_MIN = 24 * 60

function minutesOf(ts: string): number {
  return Number(ts.slice(11, 13)) * 60 + Number(ts.slice(14, 16))
}

interface Segment {
  event: PlanningCalendarEvent
  startMin: number
  endMin: number
  lane: number
  lanes: number
}

/** The event's slice inside one day, in minutes since midnight. */
function segmentFor(
  e: PlanningCalendarEvent,
  day: string
): { startMin: number; endMin: number } | null {
  const from = e.starts_at.slice(0, 10)
  const rawEnd = e.ends_at ?? e.etr
  const to = (rawEnd ?? e.starts_at).slice(0, 10)
  if (day < from || day > to) return null
  const startMin = day === from ? minutesOf(e.starts_at) : 0
  let endMin = DAY_MIN
  if (rawEnd && day === to) endMin = minutesOf(rawEnd)
  else if (!rawEnd && day === from) endMin = Math.min(startMin + 60, DAY_MIN)
  if (endMin <= startMin) endMin = Math.min(startMin + 30, DAY_MIN)
  return { startMin, endMin }
}

/** Greedy side-by-side lanes for one day's overlapping segments. */
function layOutDay(events: PlanningCalendarEvent[], day: string): Segment[] {
  const segs = events
    .map((event) => {
      const s = segmentFor(event, day)
      return s ? { event, ...s, lane: 0, lanes: 1 } : null
    })
    .filter((s): s is Segment => s !== null)
    .sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin)
  const laneEnds: number[] = []
  for (const s of segs) {
    let lane = laneEnds.findIndex((end) => end <= s.startMin)
    if (lane === -1) lane = laneEnds.length
    laneEnds[lane] = s.endMin
    s.lane = lane
  }
  // Every overlapping cluster shares the widest lane count it touches.
  for (const s of segs) {
    const cluster = segs.filter(
      (o) => o.startMin < s.endMin && o.endMin > s.startMin
    )
    s.lanes = Math.max(...cluster.map((o) => o.lane + 1))
  }
  return segs
}

export function CalendarTimeGrid({
  days,
  data,
  today,
  onPickDay,
  onMoveTask,
}: {
  /** ISO days, one column each - 7 for the week view, 1 for the day view. */
  days: string[]
  data: PlanningCalendar | undefined
  today: string
  onPickDay?: (day: string) => void
  onMoveTask?: (task: PlanningCalendarTask, day: string) => void
}) {
  const navigate = useNavigate()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [dragTask, setDragTask] = useState<PlanningCalendarTask | null>(null)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  )

  useEffect(() => {
    // Land the viewport on working hours, not midnight.
    scrollRef.current?.scrollTo({ top: 7 * HOUR_H })
  }, [])

  const dates = useMemo(() => days.map(parseISODay), [days])
  // A single-day task carrying a time is a scheduled block, not an all-day
  // bar; multi-day spans stay in the band whatever times they carry.
  const isTimed = (t: PlanningCalendarTask) => {
    const s = t.start_date ?? t.due_date
    const e = t.due_date ?? t.start_date
    return s !== null && s === e && !!(t.due_time || t.start_time)
  }
  const allDayTasks = useMemo(
    () => (data?.tasks ?? []).filter((t) => !isTimed(t)),
    [data?.tasks]
  )
  const timedTasks = useMemo(
    () => (data?.tasks ?? []).filter(isTimed),
    [data?.tasks]
  )
  const bars = useMemo(
    () => layOutWeek(dates, allDayTasks),
    [dates, allDayTasks]
  )
  const lanes = bars.reduce((n, b) => Math.max(n, b.lane + 1), 0)
  const events = data?.events ?? []
  const milestones = data?.milestones ?? []
  const changes = data?.changes ?? []

  const nowMin = (() => {
    const now = new Date()
    return now.getHours() * 60 + now.getMinutes()
  })()

  const cols = days.length
  const gridCols = { gridTemplateColumns: `3.5rem repeat(${cols}, 1fr)` }

  const onDragStart = (e: DragStartEvent) => {
    const id = String(e.active.id)
    if (id.startsWith("task|"))
      setDragTask((data?.tasks ?? []).find((t) => t.id === id.slice(5)) ?? null)
  }
  const onDragEnd = (e: DragEndEvent) => {
    setDragTask(null)
    if (!onMoveTask || !e.over) return
    const dragId = String(e.active.id)
    const overId = String(e.over.id)
    if (!dragId.startsWith("task|") || !overId.startsWith("day|")) return
    const task = (data?.tasks ?? []).find((t) => t.id === dragId.slice(5))
    if (task) onMoveTask(task, overId.slice(4))
  }

  return (
    <DndContext
      sensors={sensors}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <div
        ref={scrollRef}
        className="flex h-full min-h-0 flex-col overflow-y-auto rounded-lg border border-border"
      >
        {/* ── Sticky chrome: day headers + the all-day band pin together,
            so there is no second offset to fall out of sync on scroll. ── */}
        <div className="sticky top-0 z-20 border-b border-border bg-background">
          {/* ── Day headers ── */}
          <div className="grid border-b border-border" style={gridCols}>
            <div />
            {days.map((d, i) => {
              const date = dates[i]
              const isToday = d === today
              return (
                <button
                  key={d}
                  type="button"
                  onClick={() => onPickDay?.(d)}
                  className={cn(
                    "border-l border-border px-2 py-1.5 text-left",
                    onPickDay && "hover:bg-muted/50"
                  )}
                >
                  <span className="text-[10px] tracking-wide text-muted-foreground uppercase">
                    {date.toLocaleDateString(undefined, {
                      weekday: "short",
                      timeZone: "UTC",
                    })}
                  </span>{" "}
                  <span
                    className={cn(
                      "num text-[13px] font-semibold",
                      isToday &&
                        "rounded-full bg-primary px-1.5 py-0.5 text-primary-foreground"
                    )}
                  >
                    {date.getUTCDate()}
                  </span>
                </button>
              )
            })}
          </div>

          {/* ── All-day band: tasks as lane-packed bars, chips for the rest ── */}
          <div className="grid" style={gridCols}>
            <div className="flex items-start justify-end px-1.5 pt-1 text-[9px] tracking-wide text-muted-foreground uppercase">
              all-day
            </div>
            <div
              className="relative col-span-full col-start-2 grid"
              style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}
            >
              {days.map((d) => (
                <AllDayCell
                  key={d}
                  day={d}
                  droppable={!!onMoveTask}
                  laneOffset={lanes}
                >
                  {milestones
                    .filter((m) => m.due_date === d)
                    .map((m) => (
                      <Link
                        key={m.id}
                        to="/planning/$boardId"
                        params={{ boardId: m.board }}
                        className="flex min-w-0 items-center gap-1 truncate rounded-[4px] px-1 py-0.5 text-[10px] hover:bg-muted/60"
                        style={m.color ? { color: m.color } : undefined}
                      >
                        <Flag className="h-2.5 w-2.5 shrink-0" />
                        <span className="truncate">{m.name}</span>
                      </Link>
                    ))}
                  {changes
                    .filter((c) => c.effective_date === d)
                    .map((c) => (
                      <Link
                        key={c.id}
                        to="/planning/$boardId"
                        params={{ boardId: c.board }}
                        search={{ task: c.task }}
                        className="flex min-w-0 items-center gap-1 truncate rounded-[4px] px-1 py-0.5 text-[10px] text-primary hover:bg-muted/60"
                      >
                        <CalendarClock className="h-2.5 w-2.5 shrink-0" />
                        <span className="truncate">{c.task_title}</span>
                      </Link>
                    ))}
                </AllDayCell>
              ))}
              {lanes > 0 && (
                <div
                  className="pointer-events-none absolute inset-x-0 top-0 grid gap-y-0.5 py-0.5"
                  style={{
                    ...{ gridTemplateColumns: `repeat(${cols}, 1fr)` },
                    gridTemplateRows: `repeat(${lanes}, 1.25rem)`,
                  }}
                >
                  {bars.map((bar) => (
                    <TaskBar
                      key={bar.task.id}
                      bar={bar}
                      draggable={!!onMoveTask}
                      onOpen={() =>
                        navigate({
                          to: "/planning/$boardId/tasks/$taskId",
                          params: {
                            boardId: bar.task.board,
                            taskId: bar.task.id,
                          },
                        })
                      }
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── The hour grid ── */}
        <div className="relative grid" style={gridCols}>
          {/* Hour stamps */}
          <div className="relative" style={{ height: 24 * HOUR_H }}>
            {Array.from({ length: 23 }, (_, i) => i + 1).map((h) => (
              <span
                key={h}
                className="num absolute right-1.5 -translate-y-1/2 text-[10px] text-muted-foreground"
                style={{ top: h * HOUR_H }}
              >
                {String(h).padStart(2, "0")}:00
              </span>
            ))}
          </div>
          {days.map((d) => {
            const segs = layOutDay(events, d)
            const isToday = d === today
            return (
              <div
                key={d}
                className="relative border-l border-border"
                style={{ height: 24 * HOUR_H }}
              >
                {Array.from({ length: 23 }, (_, i) => i + 1).map((h) => (
                  <div
                    key={h}
                    className="absolute inset-x-0 border-t border-border/50"
                    style={{ top: h * HOUR_H }}
                  />
                ))}
                {segs.map((s) => (
                  <EventBlock key={`${s.event.id}-${d}`} seg={s} />
                ))}
                {timedTasks
                  .filter((t) => (t.due_date ?? t.start_date) === d)
                  .map((t) => (
                    <TaskBlock key={t.id} task={t} />
                  ))}
                {isToday && (
                  <div
                    className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-red-500"
                    style={{ top: (nowMin / 60) * HOUR_H }}
                  >
                    <span className="absolute -top-1 -left-1 h-2 w-2 rounded-full bg-red-500" />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
      <DragOverlay dropAnimation={null}>
        {dragTask && (
          <div className="truncate rounded-[4px] border border-border bg-card px-1.5 py-0.5 text-[11px] shadow-sm">
            {dragTask.title}
          </div>
        )}
      </DragOverlay>
    </DndContext>
  )
}

function AllDayCell({
  day,
  droppable,
  laneOffset,
  children,
}: {
  day: string
  droppable: boolean
  /** Task-bar lanes overlaying the band - chips start below them. */
  laneOffset: number
  children: React.ReactNode
}) {
  const drop = useDroppable({ id: `day|${day}`, disabled: !droppable })
  return (
    <div
      ref={drop.setNodeRef}
      className={cn(
        "min-h-7 space-y-0.5 border-l border-border px-0.5 pb-0.5",
        drop.isOver && "bg-primary/10"
      )}
      style={{
        paddingTop: laneOffset ? `${laneOffset * 1.375}rem` : undefined,
      }}
    >
      {children}
    </div>
  )
}

function TaskBar({
  bar,
  draggable,
  onOpen,
}: {
  bar: ReturnType<typeof layOutWeek>[number]
  draggable: boolean
  onOpen: () => void
}) {
  const drag = useDraggable({
    id: `task|${bar.task.id}`,
    disabled: !draggable,
  })
  const t = bar.task
  return (
    <button
      ref={drag.setNodeRef}
      {...drag.listeners}
      {...drag.attributes}
      type="button"
      onClick={onOpen}
      className={cn(
        "pointer-events-auto mx-0.5 flex min-w-0 items-center gap-1 truncate rounded-[4px] border px-1.5 text-left text-[11px] transition-[filter] hover:brightness-125 dark:hover:brightness-150",
        bar.continuesBefore && "rounded-l-none",
        bar.continuesAfter && "rounded-r-none",
        drag.isDragging && "opacity-40"
      )}
      style={{
        gridColumn: `${bar.from} / ${bar.to}`,
        gridRow: bar.lane + 1,
        backgroundColor: t.status_color ? `${t.status_color}22` : undefined,
        borderColor: t.status_color ? `${t.status_color}66` : undefined,
      }}
    >
      <span className="truncate">{t.title}</span>
    </button>
  )
}

function EventBlock({ seg }: { seg: Segment }) {
  const e = seg.event
  const outage = e.kind === "outage"
  const top = (seg.startMin / 60) * HOUR_H
  const height = Math.max(((seg.endMin - seg.startMin) / 60) * HOUR_H, 18)
  const width = 100 / seg.lanes
  return (
    <Link
      to="/maintenance/$id/edit"
      params={{ id: e.id }}
      className={cn(
        "absolute z-[5] overflow-hidden rounded-[4px] border px-1.5 py-0.5 text-[10.5px] leading-tight",
        outage
          ? "border-red-500/50 bg-red-500/15 hover:bg-red-500/25"
          : "border-amber-500/50 bg-amber-500/15 hover:bg-amber-500/25"
      )}
      style={{
        top,
        height,
        left: `${seg.lane * width}%`,
        width: `calc(${width}% - 3px)`,
      }}
      title={`${e.name} · ${e.provider_name || "Internal"} · ${e.status_name}`}
    >
      <span className="flex items-center gap-1 font-medium">
        {outage ? (
          <Zap className="h-2.5 w-2.5 shrink-0 text-red-600 dark:text-red-400" />
        ) : (
          <Wrench className="h-2.5 w-2.5 shrink-0 text-amber-600 dark:text-amber-400" />
        )}
        <span className="truncate">{e.name}</span>
      </span>
      {height > 30 && (
        <span className="num block text-muted-foreground">
          {e.starts_at.slice(11, 16)}
          {e.ends_at ? `–${e.ends_at.slice(11, 16)}` : ""}
        </span>
      )}
    </Link>
  )
}

/** A single-day task with a time, on the hour grid: start_time → due_time,
 * or a one-hour block ending at the one time it has. */
function TaskBlock({ task }: { task: PlanningCalendarTask }) {
  const end = task.due_time ?? task.start_time
  const endMin = end
    ? Number(end.slice(0, 2)) * 60 + Number(end.slice(3, 5))
    : 0
  const startMin = task.start_time
    ? Number(task.start_time.slice(0, 2)) * 60 +
      Number(task.start_time.slice(3, 5))
    : Math.max(endMin - 60, 0)
  const top = (Math.min(startMin, endMin) / 60) * HOUR_H
  const height = Math.max((Math.abs(endMin - startMin) / 60) * HOUR_H, 18)
  return (
    <Link
      to="/planning/$boardId/tasks/$taskId"
      params={{ boardId: task.board, taskId: task.id }}
      className="absolute inset-x-0.5 z-[4] overflow-hidden rounded-[4px] border px-1.5 py-0.5 text-[10.5px] leading-tight hover:brightness-110"
      style={{
        top,
        height,
        backgroundColor: task.status_color
          ? `${task.status_color}22`
          : "var(--muted)",
        borderColor: task.status_color ? `${task.status_color}66` : undefined,
      }}
      title={`${task.title} · ${task.board_name}`}
    >
      <span className="block truncate font-medium">{task.title}</span>
      {height > 30 && (
        <span className="num block text-muted-foreground">
          {task.start_time ? task.start_time.slice(0, 5) : ""}
          {task.start_time && end ? "–" : ""}
          {end ? end.slice(0, 5) : ""}
        </span>
      )}
    </Link>
  )
}
