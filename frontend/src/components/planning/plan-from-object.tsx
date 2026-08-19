import { useState } from "react"
import { useNavigate, useRouterState } from "@tanstack/react-router"
import { useMutation, useQuery } from "@tanstack/react-query"
import { CalendarClock, Plus } from "lucide-react"
import { toast } from "sonner"

import {
  api,
  type Paginated,
  type PlanningBoard,
  type PlanningStatus,
  type PlanningTask,
} from "@/lib/api"
import { OBJECT_DETAIL_ROUTES, objectForPath } from "@/lib/object-routes"
import { isPlanCapable } from "@/lib/save-object"
import { useMe } from "@/lib/use-me"
import { useDateFormat } from "@/lib/datetime"
import { apiErrorToast } from "@/lib/api-toast"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { FormSelect } from "@/components/forms"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

/**
 * "Plan a change" from the object's own page.
 *
 * The other entry point is the task's linked-object row, but operators live on
 * device pages - they notice the thing that needs changing there, not on a board.
 * Pick the task the work belongs to and this drops straight into the object's
 * edit form in plan mode. When no existing task fits, the "+" flow creates one
 * on the spot: the new task auto-links this object, then opens the same editor.
 *
 * Route-derived like `DetailActions`, so it mounts in `DetailShell` once and
 * works on every detail page whose type is plan-capable, with no per-page props.
 */

export function PlanFromObject() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const { canDo } = useMe()
  const nav = useNavigate()
  const { formatDate } = useDateFormat()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState("")
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState("")
  const [boardId, setBoardId] = useState<string | null>(null)

  const target = objectForPath(pathname)
  const enabled = open && !!target

  const tasks = useQuery({
    queryKey: ["planning-tasks", "picker", q],
    queryFn: () =>
      api<Paginated<PlanningTask>>(
        `/api/planning/tasks/?page_size=20&${new URLSearchParams({ q }).toString()}`
      ),
    enabled,
    staleTime: 30_000,
  })

  const boardsQ = useQuery({
    queryKey: ["planning-boards"],
    queryFn: () => api<Paginated<PlanningBoard>>("/api/planning/boards/"),
    enabled: enabled && creating,
    staleTime: 60_000,
  })
  const boards = boardsQ.data?.results ?? []
  const activeBoard = boardId ?? boards[0]?.id ?? null

  const goPlan = (taskId: string, board: string) => {
    if (!target) return
    setOpen(false)
    nav({
      to: `${OBJECT_DETAIL_ROUTES[target.objectType].replace("$id", target.id)}/edit`,
      search: { plan: taskId, planBoard: board },
    })
  }

  const create = useMutation({
    mutationFn: async () => {
      if (!target || !activeBoard) throw new Error("Pick a board first.")
      // The new task starts in the board's leftmost open column.
      const statuses = await api<Paginated<PlanningStatus>>(
        `/api/planning/statuses/?board=${activeBoard}&page_size=100`
      )
      const openCols = statuses.results.filter(
        (s) =>
          s.semantic_group !== "completed" && s.semantic_group !== "cancelled"
      )
      const status = (openCols[0] ?? statuses.results[0])?.id
      if (!status) throw new Error("This board has no statuses.")
      const task = await api<PlanningTask>("/api/planning/tasks/", {
        method: "POST",
        body: JSON.stringify({
          board: activeBoard,
          status,
          title: title.trim(),
        }),
      })
      // Auto-link the object the operator is standing on.
      await api("/api/planning/links/", {
        method: "POST",
        body: JSON.stringify({
          task: task.id,
          object_type: target.objectType,
          object_id: target.id,
        }),
      })
      return task
    },
    onSuccess: (task) => {
      toast.success("Task created")
      goPlan(task.id, task.board)
    },
    onError: (e) => apiErrorToast(e),
  })

  if (!target || !isPlanCapable(target.objectType)) return null
  // Recording a change on a task is editing that task.
  if (!canDo("task", "change")) return null

  const rows = tasks.data?.results ?? []
  const canCreate = canDo("task", "add")

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v)
        if (!v) setCreating(false)
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          title="Record a change to this object on a planning task"
        >
          <CalendarClock className="h-3.5 w-3.5" /> Plan a change
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-2">
        {creating ? (
          <div className="space-y-2">
            <Input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Task title"
              className="h-8"
              onKeyDown={(e) => {
                if (e.key === "Enter" && title.trim() && activeBoard)
                  create.mutate()
              }}
            />
            <FormSelect
              label="Board"
              value={activeBoard}
              onChange={setBoardId}
              options={boards.map((b) => ({ value: b.id, label: b.name }))}
            />
            <p className="text-[11px] text-muted-foreground">
              This object is linked to the new task automatically, and saving
              the form records the edit on it as a planned change.
            </p>
            <div className="flex justify-end gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setCreating(false)}
              >
                Back
              </Button>
              <Button
                size="sm"
                disabled={!title.trim() || !activeBoard || create.isPending}
                onClick={() => create.mutate()}
              >
                {create.isPending ? "Creating..." : "Create & plan"}
              </Button>
            </div>
          </div>
        ) : (
          <>
            <Input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Which task is this for?"
              className="mb-2 h-8"
            />
            <div className="max-h-64 overflow-y-auto">
              {tasks.isLoading && (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">
                  Loading...
                </p>
              )}
              {!tasks.isLoading && rows.length === 0 && (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">
                  {q ? "No task matches." : "No tasks yet."}
                </p>
              )}
              {rows.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-accent"
                  onClick={() => goPlan(t.id, t.board)}
                >
                  <span className="text-[13px] leading-tight">{t.title}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {t.board_name} · {t.status_name}
                    {t.due_date ? ` · due ${formatDate(t.due_date)}` : ""}
                  </span>
                </button>
              ))}
            </div>
            {canCreate && (
              <div className="mt-1 border-t border-border pt-1">
                <button
                  type="button"
                  className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-accent"
                  onClick={() => {
                    setTitle(q)
                    setCreating(true)
                  }}
                >
                  <Plus className="h-3.5 w-3.5" /> New task
                  {q.trim() ? `: “${q.trim()}”` : ""}
                </button>
              </div>
            )}
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}
