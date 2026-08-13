import { useMemo } from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import {
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  Flag,
  Wrench,
} from "lucide-react"

import {
  api,
  type Paginated,
  type PlanningBoard,
  type PlanningCalendar,
} from "@/lib/api"
import { useDateFormat } from "@/lib/datetime"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
  monthCells,
} from "@/components/planning/calendar-month"

export const Route = createFileRoute("/planning/calendar")({
  // The month and board live in the URL so a view can be linked and reloaded.
  validateSearch: (
    s: Record<string, unknown>
  ): { month?: string; board?: string } => ({
    ...(typeof s.month === "string" ? { month: s.month } : {}),
    ...(typeof s.board === "string" ? { board: s.board } : {}),
  }),
  component: CalendarPage,
})

const ALL_BOARDS = "__all__"

function CalendarPage() {
  const { month: monthParam, board } = Route.useSearch()
  const navigate = Route.useNavigate()
  const { today, settings } = useDateFormat()

  // Anchor on the viewer's today, not the browser's — the same resolution the
  // rest of Danbyte uses, so "this month" means their month.
  const [y0, m0] = today.split("-").map(Number)
  const anchor = useMemo(() => {
    if (monthParam && /^\d{4}-\d{2}$/.test(monthParam)) {
      const [y, m] = monthParam.split("-").map(Number)
      return { year: y, month: m - 1 }
    }
    return { year: y0, month: m0 - 1 }
  }, [monthParam, y0, m0])

  const setMonth = (year: number, month: number) =>
    navigate({
      search: (s) => ({
        ...s,
        month: `${year}-${String(month + 1).padStart(2, "0")}`,
      }),
    })

  const shift = (by: number) => {
    const d = new Date(anchor.year, anchor.month + by, 1)
    setMonth(d.getFullYear(), d.getMonth())
  }

  // Fetch the whole drawn grid, not just the month: the first and last weeks
  // show days either side, and work on them is real work.
  const cells = monthCells(anchor.year, anchor.month)
  const start = iso(cells[0])
  const end = iso(cells[cells.length - 1])

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

  const label = new Intl.DateTimeFormat("en-GB", {
    month: "long",
    year: "numeric",
  }).format(new Date(anchor.year, anchor.month, 1))

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
                  Tasks with dates in this month — drawn as bars across the
                  days they cover.
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
                    Planned changes — edits recorded on tasks, landing on the
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
                    Milestones due this month.
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
                    Maintenance windows and outages — managed under Monitoring
                    → Maintenance.
                  </TooltipContent>
                </Tooltip>
              )}
            </span>
          )}
          <Select
            value={board ?? ALL_BOARDS}
            onValueChange={(v) =>
              navigate({
                search: (s) => ({
                  ...s,
                  board: v === ALL_BOARDS ? undefined : v,
                }),
              })
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
          aria-label="Previous month"
          onClick={() => shift(-1)}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Next month"
          onClick={() => shift(1)}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
        <span className="text-sm font-medium">{label}</span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setMonth(y0, m0 - 1)}
          className="text-muted-foreground"
        >
          Today
        </Button>
        <Badge variant="secondary" className="ml-auto font-normal">
          {settings.timezone}
        </Badge>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4 lg:p-6">
        {dataQ.isError ? (
          <QueryError error={dataQ.error} />
        ) : (
          <CalendarMonth
            year={anchor.year}
            month={anchor.month}
            data={dataQ.data}
            today={today}
          />
        )}
      </div>
    </div>
  )
}
