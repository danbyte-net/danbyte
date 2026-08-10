import { useEffect, useRef, useState } from "react"
import { Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Maximize2, Minimize2, MoreHorizontal, Trash2 } from "lucide-react"
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
  PropertyRow,
  StatusPicker,
} from "./task-properties"
import { UserPicker } from "./user-picker"

const WIDE_KEY = "danbyte.planning.task-sheet-wide"

const readWide = () => {
  try {
    return window.localStorage.getItem(WIDE_KEY) === "1"
  } catch {
    return false
  }
}

/**
 * The task, not a form for the task.
 *
 * Title reads as the heading it is, the properties are chips you click, and the
 * description is prose until you click into it. Every property writes on pick —
 * the same one-small-PATCH behaviour as dragging a card between columns — so
 * there is no Save button and nothing to forget to press. Title and description
 * are the two free-text fields, and they commit on blur.
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
  const { canDo } = useMe()
  const canEdit = canDo("task", "change")
  const canDelete = canDo("task", "delete")
  const qc = useQueryClient()
  const { formatDate, today } = useDateFormat()

  const [wide, setWide] = useState(readWide)
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
      onOpenChange(false)
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

  const toggleWide = () =>
    setWide((w) => {
      try {
        window.localStorage.setItem(WIDE_KEY, w ? "0" : "1")
      } catch {
        /* private mode — the toggle still works for this session */
      }
      return !w
    })

  const properties = (
    <div className="grid gap-1">
      <PropertyRow label="Status">
        <StatusPicker
          statuses={statuses}
          value={task.status}
          onChange={(id) => set({ status: id })}
          canEdit={canEdit}
        />
      </PropertyRow>
      <PropertyRow label="Priority">
        <PriorityPicker
          value={task.priority}
          onChange={(v) => set({ priority: v })}
          canEdit={canEdit}
        />
      </PropertyRow>
      <PropertyRow label="Assignees">
        {canEdit ? (
          <UserPicker
            bare
            value={task.assignees}
            onChange={(ids) => set({ assignees: ids })}
          />
        ) : (
          <span className="pt-1 text-[12px]">
            {task.assignee_detail.length ? (
              task.assignee_detail.map((a) => a.username).join(", ")
            ) : (
              <span className="text-muted-foreground">Unassigned</span>
            )}
          </span>
        )}
      </PropertyRow>
      <PropertyRow label="Milestone">
        <MilestonePicker
          milestones={milestones}
          value={task.milestone}
          onChange={(id) => set({ milestone: id })}
          canEdit={canEdit}
          formatDate={formatDate}
        />
      </PropertyRow>
      <PropertyRow label="Dates">
        <DateRange
          start={task.start_date}
          due={task.due_date}
          onChange={set}
          canEdit={canEdit}
          schedule={scheduleLabel(task, today, formatDate)}
        />
      </PropertyRow>
    </div>
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

  return (
    <Sheet open onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className={
          wide
            ? "w-full gap-0 overflow-y-auto p-0 data-[side=right]:sm:max-w-[min(1200px,95vw)]"
            : "w-full gap-0 overflow-y-auto p-0 data-[side=right]:sm:max-w-xl"
        }
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
          {patch.isPending && (
            <span className="text-[11px] text-muted-foreground">Saving...</span>
          )}
          <Button
            size="icon-sm"
            variant="ghost"
            className="ml-auto text-muted-foreground"
            title={wide ? "Collapse to a side panel" : "Expand to full width"}
            onClick={toggleWide}
          >
            {wide ? (
              <Minimize2 className="h-3.5 w-3.5" />
            ) : (
              <Maximize2 className="h-3.5 w-3.5" />
            )}
          </Button>
          {canDelete && (
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
          )}
        </div>

        <div className="px-5 py-4">
          {/* The heading *is* the input: no border, no label, sized like a
              title, so the sheet opens with the task's name rather than a
              field called Title. */}
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
            className="mb-4 field-sizing-content w-full resize-none bg-transparent text-lg leading-snug font-semibold tracking-tight outline-none placeholder:text-muted-foreground focus:outline-none"
            placeholder="Untitled task"
          />

          {wide ? (
            <div className="grid gap-8 lg:grid-cols-[1fr_260px]">
              <div className="min-w-0 lg:order-1">{body}</div>
              <div className="lg:order-2 lg:pt-1">{properties}</div>
            </div>
          ) : (
            <div className="grid gap-5">
              {properties}
              <div className="border-t border-border pt-4">{body}</div>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
