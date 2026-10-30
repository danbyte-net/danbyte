import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type {
  Paginated,
  PlanningBoard,
  PlanningStatus,
  PlanningTask,
} from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"

/** The object a new task is linked to - the page the operator stands on. */
export interface TaskLinkTarget {
  objectType: string
  id: string
}

export interface NewTask {
  board: string
  title: string
  /** ISO `YYYY-MM-DD`; empty or absent = no due date. */
  dueDate?: string | null
  assignees?: number[]
  link?: TaskLinkTarget | null
}

/** Every board, for the board picker. Shared key with the boards list. */
export function usePlanningBoards(enabled = true) {
  return useQuery({
    queryKey: ["planning-boards"],
    queryFn: () => apiAll<PlanningBoard>("/api/planning/boards/"),
    enabled,
    staleTime: 60_000,
  })
}

/** May this user add a task - and, with `linked`, link it to an object?
 * The link is its own RBAC type, so a task-only grant would create the task
 * and then fail on the link. */
export function useCanAddTask({ linked }: { linked: boolean }): boolean {
  const { canDo } = useMe()
  return canDo("task", "add") && (!linked || canDo("tasklink", "add"))
}

async function createTask(input: NewTask): Promise<PlanningTask> {
  // The new task starts in the board's leftmost open column.
  const statuses = await api<Paginated<PlanningStatus>>(
    `/api/planning/statuses/?board=${input.board}&page_size=100`
  )
  const openCols = statuses.results.filter(
    (s) => s.semantic_group !== "completed" && s.semantic_group !== "cancelled"
  )
  const status = (openCols.at(0) ?? statuses.results.at(0))?.id
  if (!status) throw new Error("This board has no statuses.")
  const body: Record<string, unknown> = {
    board: input.board,
    status,
    title: input.title.trim(),
  }
  if (input.dueDate) body.due_date = input.dueDate
  if (input.assignees?.length) body.assignees = input.assignees
  const task = await api<PlanningTask>("/api/planning/tasks/", {
    method: "POST",
    body: JSON.stringify(body),
  })
  if (input.link) {
    await api("/api/planning/links/", {
      method: "POST",
      body: JSON.stringify({
        task: task.id,
        object_type: input.link.objectType,
        object_id: input.link.id,
      }),
    })
  }
  return task
}

/** Create a task on a board and, when `link` is given, link it to that
 * object. The one implementation behind "Plan a change → New task" and every
 * "Add task" button. Refreshes every task list, count and the calendar. */
export function useCreateTask({
  onSuccess,
}: {
  onSuccess?: (task: PlanningTask, input: NewTask) => void
} = {}) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: createTask,
    onSuccess: (task, input) => onSuccess?.(task, input),
    onError: (e) => apiErrorToast(e),
    // Also after a failed link: the task itself may already exist.
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["planning-tasks"] })
      qc.invalidateQueries({ queryKey: ["planning-boards"] })
      qc.invalidateQueries({ queryKey: ["planning-calendar"] })
    },
  })
}
