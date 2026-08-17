import { useMemo, useState } from "react"
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  pointerWithin,
  rectIntersection,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { Link } from "@tanstack/react-router"

import { api, type PlanningStatus, type PlanningTask } from "@/lib/api"
import { Input } from "@/components/ui/input"
import { ColorBadge } from "@/components/cells/color-badge"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { TaskCard } from "./task-card"

// Nested droppables (cards inside column bodies) flicker with plain
// closestCenter; prefer what the pointer is actually inside, then rectangle
// intersection, then fall back.
const collision: CollisionDetection = (args) => {
  const within = pointerWithin(args)
  if (within.length > 0) return within
  const rects = rectIntersection(args)
  if (rects.length > 0) return rects
  return closestCenter(args)
}

/** The kanban surface: one droppable column per status, draggable task cards,
 * one PATCH per drop. Columns come from the board's editable status rows. */
export function BoardCanvas({
  boardId,
  statuses,
  tasks,
  onOpenTask,
  canEdit,
}: {
  boardId: string
  statuses: PlanningStatus[]
  tasks: PlanningTask[]
  onOpenTask: (task: PlanningTask) => void
  canEdit: boolean
}) {
  const qc = useQueryClient()
  const [activeTask, setActiveTask] = useState<PlanningTask | null>(null)
  const sensors = useSensors(
    // 6px activation: plain clicks still open the detail sheet.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  )

  const byStatus = useMemo(() => {
    const map = new Map<string, PlanningTask[]>()
    for (const s of statuses) map.set(s.id, [])
    for (const t of tasks) map.get(t.status)?.push(t)
    return map
  }, [statuses, tasks])

  const move = useMutation({
    mutationFn: ({
      task,
      status,
      weight,
    }: {
      task: string
      status: string
      weight: number
    }) =>
      api(`/api/planning/tasks/${task}/`, {
        method: "PATCH",
        body: JSON.stringify({ status, weight }),
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["planning-tasks", boardId] }),
    onError: (e) => apiErrorToast(e),
  })

  const onDragStart = (e: DragStartEvent) => {
    const id = String(e.active.id)
    if (id.startsWith("task|"))
      setActiveTask(tasks.find((t) => t.id === id.slice(5)) ?? null)
  }

  const onDragEnd = (e: DragEndEvent) => {
    setActiveTask(null)
    if (!canEdit || !e.over) return
    const dragId = String(e.active.id)
    const overId = String(e.over.id)
    if (!dragId.startsWith("task|") || !overId.startsWith("column|")) return
    const taskId = dragId.slice(5)
    const statusId = overId.slice(7)
    const task = tasks.find((t) => t.id === taskId)
    if (!task || task.status === statusId) return
    // Append to the end of the target column: max weight + 100.
    const column = byStatus.get(statusId) ?? []
    const weight = column.length
      ? Math.max(...column.map((t) => t.weight)) + 100
      : 100
    move.mutate({ task: taskId, status: statusId, weight })
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collision}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <div className="flex h-full min-h-0 gap-3 overflow-x-auto p-4 lg:p-6">
        {statuses.map((s) => (
          <Column
            key={s.id}
            status={s}
            tasks={byStatus.get(s.id) ?? []}
            boardId={boardId}
            onOpenTask={onOpenTask}
            canEdit={canEdit}
          />
        ))}
        <AddColumn boardId={boardId} statuses={statuses} />
      </div>
      <DragOverlay dropAnimation={null}>
        {activeTask && (
          <div className="w-64 rotate-2">
            <TaskCard task={activeTask} onOpen={() => {}} />
          </div>
        )}
      </DragOverlay>
    </DndContext>
  )
}

function Column({
  status,
  tasks,
  boardId,
  onOpenTask,
  canEdit,
}: {
  status: PlanningStatus
  tasks: PlanningTask[]
  boardId: string
  onOpenTask: (task: PlanningTask) => void
  canEdit: boolean
}) {
  const drop = useDroppable({ id: `column|${status.id}` })
  const qc = useQueryClient()
  const { canDo } = useMe()
  const canDeleteColumn = canDo("taskstatus", "delete")
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState("")

  const removeColumn = useMutation({
    mutationFn: () =>
      api(`/api/planning/statuses/${status.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Column “${status.name}” deleted`)
      qc.invalidateQueries({ queryKey: ["planning-statuses", boardId] })
    },
    // The server refuses while tasks remain — the toast explains it.
    onError: (e) => apiErrorToast(e),
  })

  const create = useMutation({
    mutationFn: () =>
      api("/api/planning/tasks/", {
        method: "POST",
        body: JSON.stringify({
          board: boardId,
          status: status.id,
          title: title.trim(),
          weight: tasks.length
            ? Math.max(...tasks.map((t) => t.weight)) + 100
            : 100,
        }),
      }),
    onSuccess: () => {
      setTitle("")
      setAdding(false)
      qc.invalidateQueries({ queryKey: ["planning-tasks", boardId] })
    },
    onError: (e) => {
      apiErrorToast(e)
      toast.dismiss()
    },
  })

  return (
    <div className="group/column flex w-80 shrink-0 flex-col rounded-lg border border-border bg-muted/20">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <ColorBadge name={status.name} color={status.color || undefined} />
        <span className="num text-[11px] text-muted-foreground">
          {tasks.length}
        </span>
        {canEdit && (
          <button
            type="button"
            className="ml-auto rounded p-1 text-muted-foreground hover:text-foreground"
            title="Add task"
            onClick={() => setAdding(true)}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        )}
        {canDeleteColumn && (
          <button
            type="button"
            className="rounded p-1 text-muted-foreground opacity-0 group-hover/column:opacity-100 hover:text-foreground focus-visible:opacity-100"
            title="Delete column (must be empty)"
            onClick={() => removeColumn.mutate()}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <div
        ref={drop.setNodeRef}
        className={`flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto p-2 transition-colors ${
          drop.isOver ? "bg-primary/10" : ""
        }`}
      >
        {adding && (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (title.trim()) create.mutate()
            }}
            className="rounded-lg border border-border bg-card p-2"
          >
            <Input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setAdding(false)
                  setTitle("")
                }
              }}
              onBlur={() => {
                if (!title.trim()) setAdding(false)
              }}
              placeholder="Task title — Enter to add"
              className="h-8 text-[13px]"
            />
          </form>
        )}
        {tasks.map((t) => (
          <TaskCard key={t.id} task={t} onOpen={onOpenTask} />
        ))}
        {tasks.length === 0 && !adding && (
          <p className="px-1 py-3 text-[12px] text-muted-foreground">
            {drop.isOver ? "Drop here" : "Nothing here yet."}
          </p>
        )}
        {canEdit && !adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="flex items-center justify-center gap-1 rounded-lg border border-dashed border-border py-2 text-[12px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
          >
            <Plus className="h-3.5 w-3.5" /> Add task
          </button>
        )}
      </div>
    </div>
  )
}

/** The rail after the last column: add a column right on the board, plus the
 * link to the full editor (rename, color, Done tick, reorder). */
function AddColumn({
  boardId,
  statuses,
}: {
  boardId: string
  statuses: PlanningStatus[]
}) {
  const { canDo } = useMe()
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState("")

  const create = useMutation({
    mutationFn: () =>
      api("/api/planning/statuses/", {
        method: "POST",
        body: JSON.stringify({
          board: boardId,
          name: name.trim(),
          semantic_group: "unstarted",
          weight: statuses.length
            ? Math.max(...statuses.map((s) => s.weight)) + 100
            : 100,
        }),
      }),
    onSuccess: () => {
      setName("")
      setAdding(false)
      qc.invalidateQueries({ queryKey: ["planning-statuses", boardId] })
    },
    onError: (e) => apiErrorToast(e),
  })

  if (!canDo("taskstatus", "add")) return null
  return (
    <div className="w-56 shrink-0">
      {adding ? (
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Column name"
          className="h-9"
          onKeyDown={(e) => {
            if (e.key === "Enter" && name.trim()) create.mutate()
            if (e.key === "Escape") {
              setName("")
              setAdding(false)
            }
          }}
          onBlur={() => {
            if (!name.trim()) setAdding(false)
          }}
        />
      ) : (
        <button
          type="button"
          className="flex h-9 w-full items-center gap-1.5 rounded-lg border border-dashed border-border px-3 text-[13px] text-muted-foreground hover:bg-accent/50 hover:text-foreground"
          onClick={() => setAdding(true)}
        >
          <Plus className="h-3.5 w-3.5" /> Add column
        </button>
      )}
      <Link
        to="/statuses"
        search={{ tab: "tasks" }}
        className="link mt-2 block px-1 text-[11px] text-muted-foreground"
      >
        Manage columns (rename, color, Done)…
      </Link>
    </div>
  )
}
