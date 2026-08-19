import { useMemo } from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  Flag,
  Wrench,
} from "lucide-react"
import { toast } from "sonner"

import {
  api,
  type Paginated,
  type PlanningBoard,
  type PlanningCalendar,
  type PlanningCalendarMilestone,
  type PlanningCalendarTask,
} from "@/lib/api"
import { daysBetween, useDateFormat } from "@/lib/datetime"
import { useMe } from "@/lib/use-me"
import { apiErrorToast } from "@/lib/api-toast"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { SegmentedTabs } from "@/components/segmented-tabs"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { QueryError } from "@/components/query-error"
import {
  CalendarMonth,
  iso,
  isoWeek,
  monthCells,
} from "@/components/planning/calendar-month"
import { CalendarTimeGrid } from "@/components/planning/calendar-timegrid"

const VIEWS = ["month", "week", "day"] as const
type CalView = (typeof VIEWS)[number]

export const Route = createFileRoute("/planning/calendar")({
  // The view, its anchor and the board live in the URL so a calendar can be
  // linked and reloaded: ?view=week&day=2026-08-17&board=…
  validateSearch: (
    s: Record<string, unknown>
  ): { month?: string; day?: string; view?: CalView; board?: string } => ({
    ...(typeof s.month === "string" ? { month: s.month } : {}),
    ...(typeof s.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s.day)
      ? { day: s.day }
      : {}),
    ...(typeof s.view === "string" && VIEWS.includes(s.view as CalView)
      ? { view: s.view as CalView }
      : {}),
    ...(typeof s.board === "string" ? { board: s.board } : {}),
  }),
  component: CalendarPage,
})

const ALL_BOARDS = "__all__"

function parseDay(day: string): Date {
  const [y, m, d] = day.split("-").map(Number)
  return new Date(y, m - 1, d)
}

function addDays(day: string, n: number): string {
  const d = parseDay(day)
  d.setDate(d.getDate() + n)
  return iso(d)
}

/** Monday of the week `day` falls in. */
function mondayOf(day: string): string {
  const d = parseDay(day)
  return addDays(day, -((d.getDay() + 6) % 7))
}

function CalendarPage() {
  const {
    month: monthParam,
    day: dayParam,
    view = "month",
    board,
  } = Route.useSearch()
  const navigate = Route.useNavigate()
  const { today, settings, formatDate } = useDateFormat()
  const { canDo } = useMe()
  const qc = useQueryClient()

  // Anchor on the viewer's today, not the browser's - the same resolution the
  // rest of Danbyte uses, so "this month" means their month.
  const [y0, m0] = today.split("-").map(Number)
  const anchor = useMemo(() => {
    if (monthParam && /^\d{4}-\d{2}$/.test(monthParam)) {
      const [y, m] = monthParam.split("-").map(Number)
      return { year: y, month: m - 1 }
    }
    return { year: y0, month: m0 - 1 }
  }, [monthParam, y0, m0])
  const anchorDay = dayParam ?? today

  const setSearch = (patch: Record<string, string | undefined>) =>
    navigate({ search: (s) => ({ ...s, ...patch }) })

  const shift = (by: number) => {
    if (view === "month") {
      const d = new Date(anchor.year, anchor.month + by, 1)
      setSearch({
        month: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
      })
    } else {
      setSearch({ day: addDays(anchorDay, by * (view === "week" ? 7 : 1)) })
    }
  }
  const goToday = () =>
    setSearch({
      month: `${y0}-${String(m0).padStart(2, "0")}`,
      day: today,
    })

  // Fetch exactly what the view draws: the month view includes the days either
  // side that fill its first and last weeks - work on them is real work.
  const weekDays = useMemo(() => {
    const monday = mondayOf(anchorDay)
    return Array.from({ length: 7 }, (_, i) => parseDay(addDays(monday, i)))
  }, [anchorDay])
  const cells = monthCells(anchor.year, anchor.month)
  const [start, end] =
    view === "month"
      ? [iso(cells[0]), iso(cells[cells.length - 1])]
      : view === "week"
        ? [iso(weekDays[0]), iso(weekDays[6])]
        : [anchorDay, anchorDay]

  const boardsQ = useQuery({
    queryKey: ["planning-boards"],
    queryFn: () =>
      api<Paginated<PlanningBoard>>("/api/planning/boards/?page_size=100"),
  })

  const dataQ = useQuery({
    queryKey: ["planning-calendar", start, end, board ?? ALL_BOARDS],
    queryFn: () =>
      api<PlanningCalendar>(
        `/api/planning/calendar/?start=${start}&end=${end}` +
          (board ? `&board=${board}` : "")
      ),
  })

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["planning-calendar"] })
    qc.invalidateQueries({ queryKey: ["planning-tasks"] })
    qc.invalidateQueries({ queryKey: ["planning-milestones"] })
  }

  // Drag-to-reschedule: dropping a bar shifts its whole span onto the target
  // day, keeping the span's length; a milestone simply re-dates.
  const moveTask = useMutation({
    mutationFn: ({
      task,
      day,
    }: {
      task: PlanningCalendarTask
      day: string
    }) => {
      const from = task.start_date ?? task.due_date
      const delta = from ? daysBetween(from, day) : 0
      return api(`/api/planning/tasks/${task.id}/`, {
        method: "PATCH",
        body: JSON.stringify({
          start_date: task.start_date ? addDays(task.start_date, delta) : null,
          due_date: task.due_date ? addDays(task.due_date, delta) : null,
        }),
      })
    },
    onSuccess: (_r, { task, day }) => {
      toast.success(`Rescheduled “${task.title}” to ${formatDate(day)}`)
      invalidate()
    },
    onError: (e) => {
      apiErrorToast(e)
      invalidate()
    },
  })
  const moveMilestone = useMutation({
    mutationFn: ({ m, day }: { m: PlanningCalendarMilestone; day: string }) =>
      api(`/api/planning/milestones/${m.id}/`, {
        method: "PATCH",
        body: JSON.stringify({ due_date: day }),
      }),
    onSuccess: (_r, { m, day }) => {
      toast.success(`Moved milestone “${m.name}” to ${formatDate(day)}`)
      invalidate()
    },
    onError: (e) => {
      apiErrorToast(e)
      invalidate()
    },
  })
  const canMoveTasks = canDo("task", "change")
  const canMoveMilestones = canDo("milestone", "change")

  const label =
    view === "month"
      ? new Intl.DateTimeFormat("en-GB", {
          month: "long",
          year: "numeric",
        }).format(new Date(anchor.year, anchor.month, 1))
      : view === "week"
        ? `W${isoWeek(weekDays[3])} · ${formatDate(iso(weekDays[0]))} – ${formatDate(iso(weekDays[6]))}`
        : `W${isoWeek(parseDay(anchorDay))} · ${formatDate(anchorDay)}`

  const counts = dataQ.data
  const boards = boardsQ.data?.results ?? []

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4 lg:px-6">
        <nav className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Button variant="ghost" size="sm" asChild className="h-6 px-1">
            <Link to="/planning">
              <ChevronLeft className="h-3 w-3" /> Boards
            </Link>
          </Button>
          <ChevronRight className="h-3 w-3 opacity-60" />
          <h1 className="text-sm font-semibold text-foreground">Calendar</h1>
        </nav>

        <div className="ml-auto flex items-center gap-2">
          {counts && (
            <span className="hidden items-center gap-3 text-[11px] text-muted-foreground sm:flex">
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="cursor-default">
                    {counts.tasks.length} scheduled
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom" variant="panel">
                  Tasks with dates in this view - drawn as bars across the days
                  they cover. Drag a bar to another day to reschedule it.
                </TooltipContent>
              </Tooltip>
              {counts.changes.length > 0 && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex cursor-default items-center gap-1">
                      <CalendarClock className="h-3 w-3 text-primary" />
                      {counts.changes.length} planned
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" variant="panel">
                    Planned changes - edits recorded on tasks, landing on the
                    day the object is meant to change.
                  </TooltipContent>
                </Tooltip>
              )}
              {counts.milestones.length > 0 && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex cursor-default items-center gap-1">
                      <Flag className="h-3 w-3" />
                      {counts.milestones.length}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" variant="panel">
                    Milestones due in this view.
                  </TooltipContent>
                </Tooltip>
              )}
              {counts.events.length > 0 && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex cursor-default items-center gap-1">
                      <Wrench className="h-3 w-3 text-amber-600 dark:text-amber-400" />
                      {counts.events.length}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" variant="panel">
                    Maintenance windows and outages - managed under Organization
                    → Maintenance.
                  </TooltipContent>
                </Tooltip>
              )}
            </span>
          )}
          <Select
            value={board ?? ALL_BOARDS}
            onValueChange={(v) =>
              setSearch({ board: v === ALL_BOARDS ? undefined : v })
            }
          >
            <SelectTrigger className="h-8 w-44 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_BOARDS}>All boards</SelectItem>
              {boards.map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </header>

      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4 lg:px-6">
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Previous"
          onClick={() => shift(-1)}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Next"
          onClick={() => shift(1)}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
        <span className="text-sm font-medium">{label}</span>
        <Button
          size="sm"
          variant="ghost"
          onClick={goToday}
          className="text-muted-foreground"
        >
          Today
        </Button>
        <div className="ml-auto flex items-center gap-2">
          <SegmentedTabs
            value={view}
            onValueChange={(v) => setSearch({ view: v })}
            items={[
              { value: "month", label: "Month" },
              { value: "week", label: "Week" },
              { value: "day", label: "Day" },
            ]}
          />
          <Badge variant="secondary" className="font-normal">
            {settings.timezone}
          </Badge>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4 lg:p-6">
        {dataQ.isError ? (
          <QueryError error={dataQ.error} />
        ) : view !== "month" ? (
          <CalendarTimeGrid
            days={view === "week" ? weekDays.map(iso) : [anchorDay]}
            data={dataQ.data}
            today={today}
            onPickDay={
              view === "week"
                ? (d) => setSearch({ view: "day", day: d })
                : undefined
            }
            onMoveTask={
              canMoveTasks
                ? (task, day) => moveTask.mutate({ task, day })
                : undefined
            }
          />
        ) : (
          <CalendarMonth
            year={anchor.year}
            month={anchor.month}
            data={dataQ.data}
            today={today}
            onPickDay={(d) => setSearch({ view: "day", day: d })}
            onMoveTask={
              canMoveTasks
                ? (task, day) => moveTask.mutate({ task, day })
                : undefined
            }
            onMoveMilestone={
              canMoveMilestones
                ? (m, day) => moveMilestone.mutate({ m, day })
                : undefined
            }
          />
        )}
      </div>
    </div>
  )
}
