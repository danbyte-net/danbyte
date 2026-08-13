import { useState } from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { ChevronLeft, ChevronRight, Flag } from "lucide-react"

import {
  api,
  type Paginated,
  type PlanningBoard,
  type PlanningStatus,
  type PlanningTask,
} from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { QueryError } from "@/components/query-error"
import {
  AssigneeFilterStrip,
  filterByAssignee,
  type AssigneeFilter,
} from "@/components/planning/assignee-filter"
import { BoardCanvas } from "@/components/planning/board-canvas"
import { MilestoneManagerDialog } from "@/components/planning/milestone-manager"
import { TaskDetailSheet } from "@/components/planning/task-detail"

export const Route = createFileRoute("/planning/$boardId")({
  // ?task=<id> opens that task's sheet — how a staged planned change returns
  // you to the task you were planning for, and a linkable task in general.
  validateSearch: (s: Record<string, unknown>): { task?: string } =>
    typeof s.task === "string" ? { task: s.task } : {},
  component: BoardPage,
})

function BoardPage() {
  const { boardId } = Route.useParams()
  const { task: deepLinkTask } = Route.useSearch()
  const { canDo } = useMe()
  const canEdit = canDo("task", "change") || canDo("task", "add")
  const [openTask, setOpenTask] = useState<PlanningTask | null>(null)
  const [milestonesOpen, setMilestonesOpen] = useState(false)
  const [assignee, setAssignee] = useState<AssigneeFilter>(null)

  const boardQ = useQuery({
    queryKey: ["planning-board", boardId],
    queryFn: () => api<PlanningBoard>(`/api/planning/boards/${boardId}/`),
  })
  const statusesQ = useQuery({
    queryKey: ["planning-statuses", boardId],
    queryFn: () =>
      api<Paginated<PlanningStatus>>(
        `/api/planning/statuses/?board=${boardId}&page_size=100`
      ),
  })
  const tasksQ = useQuery({
    queryKey: ["planning-tasks", boardId],
    queryFn: () =>
      api<Paginated<PlanningTask>>(
        `/api/planning/tasks/?board=${boardId}&page_size=500`
      ),
  })

  if (boardQ.isError) return <QueryError error={boardQ.error} />
  const board = boardQ.data
  const statuses = statusesQ.data?.results ?? []
  const tasks = tasksQ.data?.results ?? []
  const shown = filterByAssignee(tasks, assignee)
  // Keep the sheet's task fresh after edits. `?task=` opens one directly, which
  // is what a staged planned change navigates back to.
  const openTaskLive = openTask
    ? (tasks.find((t) => t.id === openTask.id) ?? openTask)
    : (tasks.find((t) => t.id === deepLinkTask) ?? null)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Same shape as every other page header: back link, title, count chip —
          then the people, separated so they read as a control rather than more
          header text. */}
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4 lg:px-6">
        <nav className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Button variant="ghost" size="sm" asChild className="h-6 px-1">
            <Link to="/planning">
              <ChevronLeft className="h-3 w-3" /> Boards
            </Link>
          </Button>
          <ChevronRight className="h-3 w-3 opacity-60" />
          <h1 className="text-sm font-semibold text-foreground">
            {board?.name ?? "…"}
          </h1>
        </nav>
        <Badge variant="secondary">
          {assignee === null
            ? tasks.length
            : `${shown.length} of ${tasks.length}`}
        </Badge>
        {tasks.length > 0 && (
          <span className="mx-1 h-5 w-px bg-border" aria-hidden />
        )}
        <AssigneeFilterStrip
          tasks={tasks}
          value={assignee}
          onChange={setAssignee}
        />
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          onClick={() => setMilestonesOpen(true)}
        >
          <Flag className="h-3.5 w-3.5" /> Milestones
        </Button>
      </header>
      <div className="min-h-0 flex-1">
        {statusesQ.isLoading || tasksQ.isLoading ? (
          <p className="p-6 text-sm text-muted-foreground">Loading…</p>
        ) : (
          <BoardCanvas
            boardId={boardId}
            statuses={statuses}
            tasks={shown}
            onOpenTask={setOpenTask}
            canEdit={canEdit}
          />
        )}
      </div>
      {milestonesOpen && (
        <MilestoneManagerDialog
          boardId={boardId}
          open={milestonesOpen}
          onOpenChange={setMilestonesOpen}
        />
      )}
      {openTaskLive && (
        <TaskDetailSheet
          key={openTaskLive.id}
          task={openTaskLive}
          statuses={statuses}
          onOpenChange={(o) => !o && setOpenTask(null)}
        />
      )}
    </div>
  )
}
