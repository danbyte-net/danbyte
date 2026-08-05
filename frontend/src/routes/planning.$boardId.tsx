import { useState } from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { ChevronLeft } from "lucide-react"

import {
  api,
  type Paginated,
  type PlanningBoard,
  type PlanningStatus,
  type PlanningTask,
} from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { QueryError } from "@/components/query-error"
import { BoardCanvas } from "@/components/planning/board-canvas"
import { TaskDetailSheet } from "@/components/planning/task-detail"

export const Route = createFileRoute("/planning/$boardId")({
  component: BoardPage,
})

function BoardPage() {
  const { boardId } = Route.useParams()
  const { canDo } = useMe()
  const canEdit = canDo("task", "change") || canDo("task", "add")
  const [openTask, setOpenTask] = useState<PlanningTask | null>(null)

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
  // Keep the sheet's task fresh after edits.
  const openTaskLive = openTask
    ? (tasks.find((t) => t.id === openTask.id) ?? openTask)
    : null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4 lg:px-6">
        <Link
          to="/planning"
          className="flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" /> Boards
        </Link>
        <h1 className="text-sm font-semibold">{board?.name ?? "…"}</h1>
        <span className="text-[12px] text-muted-foreground">
          {tasks.length} task{tasks.length === 1 ? "" : "s"}
        </span>
      </header>
      <div className="min-h-0 flex-1">
        {statusesQ.isLoading || tasksQ.isLoading ? (
          <p className="p-6 text-sm text-muted-foreground">Loading…</p>
        ) : (
          <BoardCanvas
            boardId={boardId}
            statuses={statuses}
            tasks={tasks}
            onOpenTask={setOpenTask}
            canEdit={canEdit}
          />
        )}
      </div>
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
