import { useEffect, useRef, useState } from "react"
import { Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Maximize2, MoreHorizontal, Trash2 } from "lucide-react"
import { toast } from "sonner"

import {
  api,
  type Paginated,
  type PlanningMilestone,
  type PlanningStatus,
  type PlanningTask,
} from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { useDateFormat } from "@/lib/datetime"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Markdown } from "@/components/markdown"
import { JournalPanel } from "@/components/audit/journal-panel"
import { apiErrorToast } from "@/lib/api-toast"
import { PlannedChangePanel } from "./planned-change-panel"
import { scheduleLabel } from "./task-card"
import { TaskLinkPanel } from "./task-link-panel"
import {
  DateRange,
  MilestonePicker,
  PriorityPicker,
  PropertyTable,
  StatusPicker,
} from "./task-properties"
import { UserPicker } from "./user-picker"

/**
 * The task, not a form for the task.
 *
 * Title reads as the heading it is, the properties are chips you click, and the
 * description is prose until you click into it. Every property writes on pick —
 * the same one-small-PATCH behaviour as dragging a card between columns — so
 * there is no Save button and nothing to forget to press. Title and description
 * are the two free-text fields, and they commit on blur.
 */
export function TaskView({
  task,
  statuses,
  layout,
  onDeleted,
}: {
  task: PlanningTask
  statuses: PlanningStatus[]
  /** `panel` is the board's side sheet — one narrow column. `page` is the
   *  task's own route, where the content is centred and the properties sit in
   *  a rail beside it rather than under it. */
  layout: "panel" | "page"
  onDeleted?: () => void
}) {
  const { canDo } = useMe()
  const canEdit = canDo("task", "change")
  const canDelete = canDo("task", "delete")
  const qc = useQueryClient()
  const { formatDate, today } = useDateFormat()

  const [title, setTitle] = useState(task.title)
  const [description, setDescription] = useState(task.description)
  const [editingDesc, setEditingDesc] = useState(false)
  const descRef = useRef<HTMLTextAreaElement>(null)

  // Another writer (or an applied planned change) can move the task underneath
  // us; the sheet stays mounted, so pull the new values in.
  useEffect(() => setTitle(task.title), [task.title])
  useEffect(() => setDescription(task.description), [task.description])
  useEffect(() => {
    if (editingDesc) descRef.current?.focus()
  }, [editingDesc])

  const milestonesQ = useQuery({
    queryKey: ["planning-milestones", task.board],
    queryFn: () =>
      api<Paginated<PlanningMilestone>>(
        `/api/planning/milestones/?board=${task.board}&page_size=100`
      ),
  })
  const milestones = milestonesQ.data?.results ?? []

  const patch = useMutation({
    mutationFn: (body: Partial<PlanningTask>) =>
      api(`/api/planning/tasks/${task.id}/`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    // Paint the new value straight away. Everything here renders from the
    // board's task list, so without this a chip would keep showing the old
    // value until the refetch lands.
    onMutate: (body) => {
      qc.setQueriesData<Paginated<PlanningTask>>(
        { queryKey: ["planning-tasks"] },
        (old) =>
          old?.results
            ? {
                ...old,
                results: old.results.map((t) =>
                  t.id === task.id ? { ...t, ...body } : t
                ),
              }
            : old
      )
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["planning-tasks"] })
      // Milestone task_count is a server-side roll-up: moving a task between
      // milestones changes two of them, so refresh the whole list.
      qc.invalidateQueries({ queryKey: ["planning-milestones"] })
    },
    onError: (e) => {
      apiErrorToast(e)
      // The optimistic value was a guess; the server's answer wins.
      qc.invalidateQueries({ queryKey: ["planning-tasks"] })
    },
  })
  const set = (body: Partial<PlanningTask>) => {
    if (canEdit) patch.mutate(body)
  }

  const del = useMutation({
    mutationFn: () =>
      api(`/api/planning/tasks/${task.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Task deleted")
      qc.invalidateQueries({ queryKey: ["planning-tasks"] })
      qc.invalidateQueries({ queryKey: ["planning-milestones"] })
      onDeleted?.()
    },
    onError: (e) => apiErrorToast(e),
  })

  const commitTitle = () => {
    const next = title.trim()
    if (!next) return setTitle(task.title)
    if (next !== task.title) set({ title: next })
  }
  const commitDescription = () => {
    setEditingDesc(false)
    if (description !== task.description) set({ description })
  }

  const properties = (
    <PropertyTable
      rows={[
        {
          label: "Status",
          value: (
            <StatusPicker
              statuses={statuses}
              value={task.status}
              onChange={(id) => set({ status: id })}
              canEdit={canEdit}
            />
          ),
        },
        {
          label: "Priority",
          value: (
            <PriorityPicker
              value={task.priority}
              onChange={(v) => set({ priority: v })}
              canEdit={canEdit}
            />
          ),
        },
        {
          label: "Assignees",
          value: canEdit ? (
            <UserPicker
              bare
              value={task.assignees}
              onChange={(ids) => set({ assignees: ids })}
            />
          ) : task.assignee_detail.length ? (
            task.assignee_detail.map((a) => a.username).join(", ")
          ) : (
            <span className="text-muted-foreground">Unassigned</span>
          ),
        },
        {
          label: "Milestone",
          value: (
            <MilestonePicker
              milestones={milestones}
              value={task.milestone}
              onChange={(id) => set({ milestone: id })}
              canEdit={canEdit}
              formatDate={formatDate}
            />
          ),
        },
        {
          label: "Dates",
          value: (
            <DateRange
              start={task.start_date}
              due={task.due_date}
              onChange={set}
              canEdit={canEdit}
              schedule={scheduleLabel(task, today, formatDate)}
            />
          ),
        },
      ]}
    />
  )

  const body = (
    <div className="grid gap-5">
      {editingDesc ? (
        <Textarea
          ref={descRef}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={commitDescription}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setDescription(task.description)
              setEditingDesc(false)
            }
          }}
          className="min-h-32 font-mono text-[13px]"
          placeholder="What needs to happen? Markdown works."
        />
      ) : (
        <div
          role={canEdit ? "button" : undefined}
          tabIndex={canEdit ? 0 : undefined}
          onClick={(e) => {
            // Markdown bodies contain links; following one must not also drop
            // the reader into the editor.
            if ((e.target as HTMLElement).closest("a")) return
            if (canEdit) setEditingDesc(true)
          }}
          onKeyDown={(e) => {
            if (canEdit && (e.key === "Enter" || e.key === " ")) {
              e.preventDefault()
              setEditingDesc(true)
            }
          }}
          className={`-mx-2 rounded-md px-2 py-1 ${
            canEdit ? "cursor-text hover:bg-muted/50" : ""
          }`}
        >
          {description ? (
            <Markdown source={description} />
          ) : (
            <p className="text-[13px] text-muted-foreground">
              {canEdit ? "Add a description" : "No description"}
            </p>
          )}
        </div>
      )}

      <TaskLinkPanel
        taskId={task.id}
        boardId={task.board}
        links={task.links}
        canEdit={canEdit}
      />

      <PlannedChangePanel task={task} canEdit={canEdit} />

      <section className="space-y-2">
        <h3 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          Comments
        </h3>
        <JournalPanel objectType="planning.task" objectId={task.id} />
      </section>
    </div>
  )

  const heading = (
    /* The heading *is* the input: no border, no label, sized like a title, so
       the task opens with its own name rather than a field called Title. */
    <textarea
      value={title}
      readOnly={!canEdit}
      onChange={(e) => setTitle(e.target.value)}
      onBlur={commitTitle}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault()
          e.currentTarget.blur()
        }
        if (e.key === "Escape") {
          setTitle(task.title)
          e.currentTarget.blur()
        }
      }}
      rows={1}
      className={`field-sizing-content w-full resize-none bg-transparent leading-snug font-semibold tracking-tight outline-none placeholder:text-muted-foreground focus:outline-none ${
        layout === "page" ? "text-2xl" : "text-lg"
      }`}
      placeholder="Untitled task"
    />
  )

  const menu = canDelete ? (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="icon-sm"
          variant="ghost"
          className="text-muted-foreground"
          title="More"
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          disabled={del.isPending}
          onSelect={() => del.mutate()}
          className="text-destructive"
        >
          <Trash2 className="h-3.5 w-3.5" />{" "}
          {del.isPending ? "Deleting..." : "Delete task"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null

  const saving = patch.isPending ? (
    <span className="text-[11px] text-muted-foreground">Saving...</span>
  ) : null

  if (layout === "page") {
    return (
      <div className="mx-auto w-full max-w-5xl px-6 py-6">
        <div className="mb-4 flex items-start gap-3">
          <div className="min-w-0 flex-1">{heading}</div>
          <span className="flex shrink-0 items-center gap-2 pt-1">
            {saving}
            {menu}
          </span>
        </div>
        {/* Content and properties side by side, but the pair is centred and
            capped — a task is a document, not a thing to stretch across a
            2000px monitor with a rail marooned at the far edge. */}
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_240px]">
          <div className="min-w-0">{body}</div>
          <div className="lg:pt-1">{properties}</div>
        </div>
      </div>
    )
  }

  return (
    <div className="px-5 py-4">
      <div className="mb-4 flex items-start gap-2">
        <div className="min-w-0 flex-1">{heading}</div>
        <span className="flex shrink-0 items-center gap-2 pt-0.5">
          {saving}
          {menu}
        </span>
      </div>
      <div className="grid gap-5">
        {properties}
        <div className="border-t border-border pt-4">{body}</div>
      </div>
    </div>
  )
}

/**
 * The board's side sheet: a quick look at a task without leaving the board.
 * Anything more than a glance belongs on the task's own page — the sheet's
 * expand button goes there rather than growing a panel to fill the screen.
 */
export function TaskDetailSheet({
  task,
  statuses,
  onOpenChange,
}: {
  task: PlanningTask
  statuses: PlanningStatus[]
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Sheet open onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full gap-0 overflow-y-auto p-0 data-[side=right]:sm:max-w-xl"
      >
        <SheetHeader className="p-0">
          <SheetTitle className="sr-only">{task.title}</SheetTitle>
        </SheetHeader>

        {/* Board link left, controls right — pr-14 clears the sheet's own X. */}
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-5 pr-14">
          <Link
            to="/planning/$boardId"
            params={{ boardId: task.board }}
            className="text-[11px] text-muted-foreground hover:text-foreground"
          >
            {task.board_name}
          </Link>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto text-muted-foreground"
            asChild
            title="Open this task on its own page"
          >
            <Link
              to="/planning/$boardId/tasks/$taskId"
              params={{ boardId: task.board, taskId: task.id }}
            >
              <Maximize2 className="h-3.5 w-3.5" /> Open
            </Link>
          </Button>
        </div>

        <TaskView
          task={task}
          statuses={statuses}
          layout="panel"
          onDeleted={() => onOpenChange(false)}
        />
      </SheetContent>
    </Sheet>
  )
}
