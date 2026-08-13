import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { ChevronLeft, ChevronRight } from "lucide-react"

import {
  api,
  type Paginated,
  type PlanningStatus,
  type PlanningTask,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import { QueryError } from "@/components/query-error"
import { TaskView } from "@/components/planning/task-detail"

export const Route = createFileRoute("/planning/$boardId/tasks/$taskId")({
  component: TaskPage,
})

/**
 * A task on its own page.
 *
 * The board's sheet is for a glance; a task carrying linked devices, planned
 * changes and a comment thread is a document, and reading one should not mean
 * squinting at a panel over the board it came from. Same chrome as every other
 * detail page: a back link to where you were, then the content.
 */
function TaskPage() {
  const { boardId, taskId } = Route.useParams()

  const taskQ = useQuery({
    queryKey: ["planning-task", taskId],
    queryFn: () => api<PlanningTask>(`/api/planning/tasks/${taskId}/`),
  })
  const statusesQ = useQuery({
    queryKey: ["planning-statuses", boardId],
    queryFn: () =>
      api<Paginated<PlanningStatus>>(
        `/api/planning/statuses/?board=${boardId}&page_size=100`
      ),
  })

  const task = taskQ.data
  const statuses = statusesQ.data?.results ?? []

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-1.5 border-b border-border px-4 lg:px-6">
        <Button variant="ghost" size="sm" asChild className="h-6 px-1">
          <Link to="/planning/$boardId" params={{ boardId }}>
            <ChevronLeft className="h-3 w-3" />
            {task?.board_name ?? "Board"}
          </Link>
        </Button>
        <ChevronRight className="h-3 w-3 text-muted-foreground opacity-60" />
        <span className="truncate text-xs font-semibold tracking-tight text-foreground">
          {task?.title ?? "Task"}
        </span>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto">
        {taskQ.isLoading && (
          <p className="p-6 text-sm text-muted-foreground">Loading...</p>
        )}
        {taskQ.isError && (
          <div className="p-6">
            <QueryError error={taskQ.error} />
          </div>
        )}
        {task && <TaskView task={task} statuses={statuses} layout="page" />}
      </main>
    </div>
  )
}
