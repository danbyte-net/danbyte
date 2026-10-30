import { useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { Plus } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { FormCombobox, FormDate, FormText } from "@/components/forms"
import { UserPicker } from "./user-picker"
import {
  useCanAddTask,
  useCreateTask,
  usePlanningBoards,
} from "./use-create-task"
import type { TaskLinkTarget } from "./use-create-task"

/**
 * "Add task" for a task list that isn't a board column: an object's Tasks tab
 * (the new task links that object) and the calendar. Hidden without the
 * rights to add the task - and its link, when there is one.
 */
export function AddTaskButton({
  link = null,
  defaultBoard = null,
  defaultDueDate = "",
}: {
  link?: TaskLinkTarget | null
  defaultBoard?: string | null
  defaultDueDate?: string
}) {
  const [open, setOpen] = useState(false)
  const canAdd = useCanAddTask({ linked: !!link })
  if (!canAdd) return null
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="h-3.5 w-3.5" /> Add task
      </Button>
      {open && (
        <AddTaskDialog
          link={link}
          defaultBoard={defaultBoard}
          defaultDueDate={defaultDueDate}
          onOpenChange={setOpen}
        />
      )}
    </>
  )
}

export function AddTaskDialog({
  link,
  defaultBoard,
  defaultDueDate,
  onOpenChange,
}: {
  link: TaskLinkTarget | null
  defaultBoard: string | null
  defaultDueDate: string
  onOpenChange: (open: boolean) => void
}) {
  const nav = useNavigate()
  const [title, setTitle] = useState("")
  const [boardId, setBoardId] = useState<string | null>(defaultBoard)
  const [dueDate, setDueDate] = useState(defaultDueDate)
  const [assignees, setAssignees] = useState<number[]>([])

  const boardsQ = usePlanningBoards()
  const boards = boardsQ.data?.results ?? []
  // Same default as "Plan a change → New task": the first board.
  const activeBoard = boardId ?? boards.at(0)?.id ?? null

  const create = useCreateTask({
    onSuccess: (task) => {
      toast.success(`Created ${task.title}`, {
        action: {
          label: "Open",
          onClick: () =>
            nav({
              to: "/planning/$boardId/tasks/$taskId",
              params: { boardId: task.board, taskId: task.id },
            }),
        },
      })
      onOpenChange(false)
    },
  })
  const ready = !!title.trim() && !!activeBoard && !create.isPending
  const submit = () => {
    if (!ready || !activeBoard) return
    create.mutate({ board: activeBoard, title, dueDate, assignees, link })
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Add task</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <div className="grid gap-3">
            <FormText
              label="Title"
              value={title}
              onChange={setTitle}
              required
              autoFocus
            />
            <FormCombobox
              label="Board"
              value={activeBoard}
              onChange={setBoardId}
              options={boards.map((b) => ({ value: b.id, label: b.name }))}
              searchPlaceholder="Search boards…"
              emptyText="No boards."
            />
            <FormDate label="Due date" value={dueDate} onChange={setDueDate} />
            <UserPicker value={assignees} onChange={setAssignees} />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!ready}>
              {create.isPending ? "Adding…" : "Add task"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
