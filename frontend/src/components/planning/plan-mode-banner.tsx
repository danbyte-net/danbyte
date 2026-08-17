import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { CalendarClock } from "lucide-react"

import { api, type PlanningTask } from "@/lib/api"
import { usePlanTarget } from "@/lib/save-object"

/** Says, unmistakably, that this form is not going to write anything.
 *
 * Rendered at the top of any edit/create page carrying `?plan=` — an operator
 * who lands here from a task must not think they are editing the live object.
 * Renders nothing outside plan mode, so routes can mount it unconditionally. */
export function PlanModeBanner() {
  const plan = usePlanTarget()
  const q = useQuery({
    queryKey: ["planning-task", plan?.taskId],
    queryFn: () => api<PlanningTask>(`/api/planning/tasks/${plan!.taskId}/`),
    enabled: !!plan,
    staleTime: 60_000,
  })
  if (!plan) return null

  return (
    <div className="mb-4 flex flex-wrap items-start gap-3 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3">
      <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-[13px] font-medium">
          Planning a change for{" "}
          <Link
            to="/planning/$boardId"
            params={{ boardId: plan.boardId }}
            search={{ task: plan.taskId }}
            className="link"
          >
            «{q.data?.title ?? "this task"}»
          </Link>
        </p>
        <p className="text-[12px] text-muted-foreground">
          Saving records what you changed on the task. Nothing is written to
          this object now — someone applies it when the work is done.
        </p>
      </div>
    </div>
  )
}
